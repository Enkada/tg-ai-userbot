import { InputMedia, TelegramClient, proxyTransportFromUrl, type InputText, type Message } from '@mtcute/node';
import { config, isWhitelisted } from './config.js';
import { createLogger } from './logger.js';
import { resolveCommand, parseCommand, type CommandContext } from './commands.js';
import { dropPanel, showPanel, sweepDebris, trackDebris, untrackDebris } from './panel.js';
import { activeProviderId, canCaptionImages, describeImage, initProvider } from './llm.js';
import { renderSystemPrompt } from './prompt.js';
import { runMigrations } from './db/index.js';
import { initPersona } from './persona.js';
import { getLastMessageAt, rememberUserName, saveAttachment, saveMessage } from './memory.js';
import { photoBeatMs, readDelayMs, readPauseMs, sleep } from './pacing.js';
import { generateReply, persistedSearchStrategy } from './generate.js';
import { finalizeReply } from './tools.js';
import { ReplyStreamer } from './send.js';
import { withTyping } from './typing.js';
import { enqueue } from './queue.js';
import { onUserActivity, startProactiveLoop } from './proactive.js';
import { startSummaryLoop } from './summary.js';

const log = createLogger('bot');
const startedAt = Date.now();

const client = new TelegramClient({
  apiId: config.apiId,
  apiHash: config.apiHash,
  storage: config.sessionPath,
  // Route MTProto through a proxy when configured (needed where Telegram's DCs are blocked).
  ...(config.proxyUrl ? { transport: proxyTransportFromUrl(config.proxyUrl) } : {}),
});

/**
 * Cheap gate for every incoming update: drops messages we never act on (our own, non-DM,
 * non-whitelisted), then hands the rest to the per-chat queue so they're processed one at
 * a time in arrival order. Cheap filtering stays out of the queue so it can't be delayed
 * behind an in-flight LLM call.
 */
function handleMessage(msg: Message, selfName: string): void {
  // Ignore our own outgoing messages to avoid feedback loops.
  if (msg.isOutgoing) return;

  // Only operate in private (DM) chats — ignore groups, supergroups and channels.
  if (msg.chat.type !== 'user') return;

  const senderId = msg.sender.id;
  if (!isWhitelisted(senderId)) {
    log.debug(`Ignoring message from non-whitelisted user ${senderId}`);
    return;
  }

  enqueue(msg.chat.id, () =>
    processMessage(msg, senderId, selfName).catch((err) => {
      log.error('Error handling message:', err);
    }),
  );
}

/** Processes one message to completion (command routing or a full LLM round-trip). */
async function processMessage(msg: Message, senderId: number, selfName: string): Promise<void> {
  // `text` is the message text, or the caption when a photo is attached ('' if neither).
  const text = msg.text;
  // We handle photos (described via a vision pass) and plain text. Everything else —
  // stickers, voice, video, documents — is silently ignored, as before.
  const photo = msg.media?.type === 'photo' ? msg.media : null;

  // Unsupported types are read instantly and dropped: no reply will follow, so a delayed
  // read would just dangle ("she saw it moments later and said nothing").
  if (!text && !photo) {
    await client.readHistory(msg.chat, { maxId: msg.id });
    return;
  }

  // Memory is keyed by chat id (the DM peer).
  const chatId = msg.chat.id;
  // Display name of the user we're talking to, for the {{user}} prompt tag.
  const userName = msg.sender.displayName;
  // The user is active: reset the proactive silence timer and cache their name (also for the
  // off-line summarizer). Covers commands too — any interaction counts as "they're here".
  const noteActivity = (): void => {
    onUserActivity(chatId, userName);
    rememberUserName(chatId, userName);
  };
  // A photo's caption is never treated as a slash command — commands are text-only.
  const parsed = photo ? null : parseCommand(text);

  if (parsed) {
    // Commands are control UI, not conversation: read instantly, no human pacing.
    await client.readHistory(msg.chat, { maxId: msg.id });
    noteActivity();
    // Leftover /dump files and command messages stranded by a crash go first, so file
    // output never stacks. The panel itself stays — the handler edits it in place.
    await sweepDebris(client, msg.chat, chatId, ['file', 'command']);
    // Track this command message from the start: if the process dies mid-handler, the
    // post-handler delete below never runs and the next sweep collects it instead.
    trackDebris(chatId, msg.id, 'command');

    // All command output goes through the panel: one reusable message per chat, edited
    // in place, swept away when the user's next normal message arrives.
    const reply = (content: InputText): Promise<void> => showPanel(client, msg.chat, chatId, content);
    // File output (e.g. /dump's prompt .md) can't be a panel edit — send + track it.
    const replyDocument = async (
      content: Buffer,
      fileName: string,
      caption?: InputText,
    ): Promise<void> => {
      const sent = await client.sendMedia(msg.chat, InputMedia.document(content, { fileName, caption }));
      trackDebris(chatId, sent.id, 'file');
    };

    const command = resolveCommand(parsed.name);
    try {
      if (!command) {
        await reply(`Unknown command: /${parsed.name}. Try /help`);
      } else {
        const ctx: CommandContext = {
          client,
          msg,
          chatId,
          userName,
          args: parsed.args,
          rawArgs: parsed.rawArgs,
          startedAt,
          selfName,
          reply,
          replyDocument,
          dropPanel: () => dropPanel(client, msg.chat, chatId),
        };

        log.info(`Command /${parsed.name} from ${senderId}`);
        await command.handler(ctx);
      }
    } catch (err) {
      // A failed command must never end in silence: surface it in the panel (tracked,
      // so it sweeps like any output) instead of leaving the chat looking ignored.
      log.error(`Command /${parsed.name} failed:`, err);
      await reply('⚠️ Command failed — check the server logs.').catch(() => {});
    }

    // Delete the user's command message (for both sides) so it doesn't clutter the
    // chat. It may already be gone — /nuke wipes the history, /r revokes it at the
    // swap — Telegram treats that as success. Only release the debris row once the
    // revoke went through; on failure the row stays and the next sweep retries.
    try {
      await client.deleteMessages([msg], { revoke: true });
      untrackDebris(chatId, msg.id);
    } catch {
      /* keep the debris row for the next sweep */
    }
    return;
  }

  // A photo is only usable if we can caption it: either the active model has vision (an
  // --mmproj projector / a vision chat model), or a dedicated OpenRouter caption model is
  // configured as a fallback. Otherwise ignore the image — and if there's no caption text to
  // answer instead, there's nothing to respond to at all: read instantly (like other
  // unsupported types — no reply will follow) and bail.
  let imagePhoto = photo;
  if (imagePhoto && !(await canCaptionImages())) {
    log.info('No vision model available (active model text-only, no caption fallback); ignoring attached photo.');
    imagePhoto = null;
    if (!text) {
      await client.readHistory(msg.chat, { maxId: msg.id });
      noteActivity();
      return;
    }
  }

  // A reply will follow — so the human read-delay applies. The longer the chat has been
  // idle (counting messages from either side), the longer "she" takes to notice this one;
  // time it already spent waiting (queue, reconnect backlog) counts toward the delay, so an
  // already-late read is never padded further. Curve and jitter live in pacing.ts.
  const lastMessageAt = getLastMessageAt(chatId);
  const idleMs = lastMessageAt == null ? 0 : Date.now() - lastMessageAt;
  const readWait = readDelayMs(idleMs) - Math.max(0, Date.now() - msg.date.getTime());
  if (readWait > 0) {
    log.info(`Read delay ${(readWait / 1000).toFixed(1)}s (chat idle ${Math.round(idleMs / 60_000)}m)`);
    await sleep(readWait);
  }
  await client.readHistory(msg.chat, { maxId: msg.id });
  noteActivity();

  // A normal message arrived: sweep away all slash-command debris — the panel, /dump
  // files, stranded command messages — so it doesn't sit next to the conversation.
  // The sweep reads from the DB, so debris orphaned by a restart is collected here too.
  await sweepDebris(client, msg.chat, chatId);

  // Any non-command text (and/or a photo) from whitelisted users goes to the local LLM.
  log.info(`LLM request from ${senderId}: ${imagePhoto ? '[photo] ' : ''}${text.slice(0, 80)}`);
  // The streamer sends the reply as bubbles while it generates. It's created only after the
  // silent read→typing phase below (so first-bubble pacing measures from when "typing"
  // believably began), but declared out here so the catch block can recover whatever
  // bubbles already landed if generation fails partway.
  let streamer: ReplyStreamer | undefined;
  try {
    const systemPrompt = renderSystemPrompt({ userName, chatId });
    // Store the user message's Telegram id too, so /delete can revoke it in the chat.
    const userRowId = saveMessage(chatId, 'user', text, [msg.id]);

    // The silent read→typing beat: after the read receipt, "she" spends a moment on the
    // message before any typing indicator may appear. Nothing is shown during it.
    if (imagePhoto) {
      // "Looking at the photo": the vision pass runs inside the beat, so its real latency
      // is absorbed rather than stacked — the wait is max(caption pass, human glance). The
      // caption links to the user row and is injected into the window as a
      // `[<user> sent a photo: …]` block; the chat model sees text, never the pixels.
      const beat = photoBeatMs();
      const passStart = Date.now();
      const bytes = await client.downloadAsBuffer(imagePhoto);
      const caption = await describeImage(Buffer.from(bytes).toString('base64'));
      saveAttachment(userRowId, 0, caption);
      log.info(`Image caption: ${caption.slice(0, 120)}`);
      await sleep(beat - (Date.now() - passStart));
    } else {
      // Reading the text at a fast-skim pace — the receipt and "typing…" never coincide.
      await sleep(readPauseMs(text.length));
    }

    streamer = new ReplyStreamer(client, msg.chat);
    // A const alias so the closure below sees a definitely-assigned streamer.
    const sink = streamer;
    // Generate and stream the reply under one typing indicator.
    const reply = await withTyping(client, msg.chat, async () => {
      // Build the cache-friendly window (now including this message + caption) and reply,
      // streaming prose bubbles and running any web_search tool calls before it answers.
      const result = await generateReply(
        systemPrompt,
        persistedSearchStrategy(chatId, userRowId),
        `chat ${chatId}`,
        sink,
      );
      // Strip any leftover tool call (cap hit) so a raw tag never reaches the chat, then flush
      // the final bubble (or send the whole thing if nothing streamed, e.g. only a tool call).
      const replyText = finalizeReply(result.content);
      const ids = await sink.finalize(replyText);
      return { replyText, ids, model: result.model };
    });
    // Nothing reached the chat at all — fall through to the error path below.
    if (reply.ids.length === 0) throw new Error('Failed to send any part of the reply');
    // One memory row holds the whole reply; every bubble id lets /delete, /reroll and /update
    // act on it as a unit.
    saveMessage(chatId, 'assistant', reply.replyText, reply.ids, {
      provider: activeProviderId(),
      model: reply.model,
    });
  } catch (err) {
    // If some bubbles already streamed before the failure, persist them so memory matches the
    // chat; only fall back to an apology when the user saw nothing at all (including a
    // failure — e.g. in the vision pass — before the streamer even existed).
    const partialIds = streamer?.ids ?? [];
    const partialText = streamer ? finalizeReply(streamer.streamedText) : '';
    if (partialIds.length > 0 && partialText) {
      log.error('Reply only partially streamed:', err);
      saveMessage(chatId, 'assistant', partialText, partialIds, {
        provider: activeProviderId(),
        model: null,
      });
    } else {
      log.error('LLM error:', err);
      // The apology is ephemeral, not conversation: route it through the panel so a
      // retry that fails again edits the same notice, and any reply sweeps it away.
      await showPanel(client, msg.chat, chatId, '⚠️ Sorry, I could not get a response from the language model.');
    }
  }
}

async function main(): Promise<void> {
  log.info('Starting UserBot...');

  runMigrations();
  // The persona lives in the DB (persona_versions) — load it only after migrations.
  initPersona();

  if (config.proxyUrl) {
    // Log the proxy host without leaking any user:pass credentials in the URL.
    const host = config.proxyUrl.replace(/^[a-z0-9+.-]+:\/\/(?:[^@/]*@)?/i, '').split(/[/?]/)[0];
    log.info(`Connecting through proxy: ${host}`);
  }

  // Pick the LLM backend up front: local llama.cpp if reachable, else OpenRouter.
  await initProvider();

  const self = await client.start({ phone: config.phone });
  const selfName = self.displayName ?? self.username ?? String(self.id);

  log.info(`Logged in as ${selfName} (id: ${self.id})`);
  log.info(`Whitelisted users: ${[...config.whitelist].join(', ') || '(none)'}`);

  client.onNewMessage.add((msg) => {
    handleMessage(msg, selfName);
  });

  // Start the proactive scheduler (no-op unless PROACTIVE_ENABLED=true).
  if (config.proactive.enabled) startProactiveLoop(client);

  // Start the long-term-memory summarizer (no-op unless SUMMARY_ENABLED=true + OpenRouter set).
  startSummaryLoop();

  log.info('UserBot is online and listening for messages.');
}

main().catch((err) => {
  log.error('Fatal error during startup:', err);
  process.exit(1);
});

// Graceful shutdown.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info(`Received ${signal}, shutting down...`);
    client.destroy().finally(() => process.exit(0));
  });
}
