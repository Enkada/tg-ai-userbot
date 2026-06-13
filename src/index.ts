import { TelegramClient, type InputText, type Message } from '@mtcute/node';
import { config, isWhitelisted } from './config.js';
import { createLogger } from './logger.js';
import { resolveCommand, parseCommand, type CommandContext } from './commands.js';
import {
  activeProviderId,
  chat,
  describeImage,
  getVisionSupport,
  initProvider,
  type ChatResult,
} from './llm.js';
import { renderSystemPrompt } from './prompt.js';
import { runMigrations } from './db/index.js';
import { getWindow, saveAttachment, saveMessage, saveSearch } from './memory.js';
import { isSearchConfigured, webSearch } from './search.js';
import { finalizeReply, parseToolCall } from './tools.js';
import { renderMarkdown } from './format.js';
import { withTyping } from './typing.js';

const log = createLogger('bot');
const startedAt = Date.now();

/**
 * Per-chat ids of bot messages sent as slash-command output. They're deleted (for both
 * sides) the moment the user sends their next normal message, so command output doesn't
 * pile up alongside the actual conversation.
 */
const pendingCommandOutputs = new Map<number, number[]>();

function trackCommandOutput(chatId: number, messageId: number): void {
  const ids = pendingCommandOutputs.get(chatId);
  if (ids) ids.push(messageId);
  else pendingCommandOutputs.set(chatId, [messageId]);
}

/**
 * Per-chat promise chain. All stateful handling for a chat runs through here so messages
 * are processed strictly in arrival order, one at a time — a second message waits for the
 * first reply to be fully generated and saved before its own LLM round-trip starts. This
 * keeps the stored history cleanly alternating (user → assistant → user → …) and, because
 * each task's `getWindow` runs only after the previous reply is persisted, every request
 * ends on a user turn. Without it, two quick messages race: overlapping LLM calls, two
 * adjacent `user` rows, and nondeterministic reply order.
 */
const chatQueues = new Map<number, Promise<void>>();

function enqueue(chatId: number, task: () => Promise<void>): void {
  const prev = chatQueues.get(chatId) ?? Promise.resolve();
  // Run the next task regardless of whether the previous one settled or threw, so one
  // failure never wedges the chat. Errors are logged inside `task`.
  const next = prev.then(task, task);
  chatQueues.set(chatId, next);
  next.finally(() => {
    // Drop the entry once the chain has fully drained, so idle chats don't leak memory.
    if (chatQueues.get(chatId) === next) chatQueues.delete(chatId);
  });
}

const client = new TelegramClient({
  apiId: config.apiId,
  apiHash: config.apiHash,
  storage: config.sessionPath,
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

/**
 * Generates a reply, running the model's `web_search` tool calls in a loop. The first
 * `chat` is the normal reply; if its output is a `<tool_call>`, we run the search, attach
 * the distilled result to the user's message row (so it enters the window), and ask the
 * model again — now grounded. Repeats until the model answers in prose or the per-turn
 * cap is hit (anti-loop: a model that keeps emitting calls can't spin forever). When
 * search is unconfigured there are no tools, so this is a single `chat` call.
 */
async function generateWithTools(
  chatId: number,
  systemPrompt: string,
  userRowId: number,
): Promise<ChatResult> {
  let result = await chat(systemPrompt, getWindow(chatId));
  if (!isSearchConfigured()) return result;

  const max = config.tavily.maxSearchesPerTurn;
  for (let searchCount = 0; searchCount < max; searchCount++) {
    const call = parseToolCall(result.content);
    if (!call || call.name !== 'web_search') break;
    const query = String(call.arguments.query ?? '').trim();
    if (!query) break;

    let summary: string;
    try {
      summary = await webSearch(query);
      log.info(`Web search ${searchCount + 1}/${max} for chat ${chatId}: ${query}`);
    } catch (err) {
      log.error('Web search failed:', err);
      summary = 'search failed — no results available right now.';
    }
    // Attach to the user turn; the rebuilt window injects it as a [web search …] block.
    saveSearch(userRowId, searchCount, query, summary);
    result = await chat(systemPrompt, getWindow(chatId));
  }
  return result;
}

/** Processes one message to completion (command routing or a full LLM round-trip). */
async function processMessage(msg: Message, senderId: number, selfName: string): Promise<void> {
  // Mark the sender's message as read as soon as we start handling it.
  await client.readHistory(msg.chat, { maxId: msg.id });

  // `text` is the message text, or the caption when a photo is attached ('' if neither).
  const text = msg.text;
  // We handle photos (described via a vision pass) and plain text. Everything else —
  // stickers, voice, video, documents — is silently ignored, as before.
  const photo = msg.media?.type === 'photo' ? msg.media : null;
  if (!text && !photo) return;

  // Memory is keyed by chat id (the DM peer).
  const chatId = msg.chat.id;
  // Display name of the user we're talking to, for the {{user}} prompt tag.
  const userName = msg.sender.displayName;
  // A photo's caption is never treated as a slash command — commands are text-only.
  const parsed = photo ? null : parseCommand(text);

  if (parsed) {
    // All command output goes through `reply` so each sent message is tracked and
    // can be swept away when the user's next normal message arrives.
    const reply = async (content: InputText): Promise<Message> => {
      const sent = await client.answerText(msg, content);
      trackCommandOutput(chatId, sent.id);
      return sent;
    };

    const command = resolveCommand(parsed.name);
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
      };

      log.info(`Command /${parsed.name} from ${senderId}`);
      await command.handler(ctx);
    }

    // Delete the user's command message (for both sides) so it doesn't clutter the
    // chat. It may already be gone — e.g. /clear wipes the history — so ignore errors.
    await client.deleteMessages([msg], { revoke: true }).catch(() => {});
    return;
  }

  // A photo is only usable if the loaded model actually has vision (an --mmproj projector).
  // Without it, fall back to the old behaviour and ignore the image — and if there's no
  // caption text to answer instead, there's nothing to respond to at all, so bail early.
  let imagePhoto = photo;
  if (imagePhoto && !(await getVisionSupport())) {
    log.info('Model has no vision support; ignoring attached photo.');
    imagePhoto = null;
    if (!text) return;
  }

  // A normal message arrived: sweep away any leftover slash-command output first, so
  // stale /context, /status, etc. responses don't accumulate next to the conversation.
  const staleOutputs = pendingCommandOutputs.get(chatId);
  if (staleOutputs?.length) {
    pendingCommandOutputs.delete(chatId);
    await client.deleteMessagesById(msg.chat, staleOutputs, { revoke: true }).catch(() => {});
  }

  // Any non-command text (and/or a photo) from whitelisted users goes to the local LLM.
  log.info(`LLM request from ${senderId}: ${imagePhoto ? '[photo] ' : ''}${text.slice(0, 80)}`);
  try {
    const systemPrompt = renderSystemPrompt({ userName });
    // Caption (if a photo) and generate under one typing indicator — both are slow model
    // passes. Persisting the user turn happens inside so the window includes it.
    const reply = await withTyping(client, msg.chat, async () => {
      // Store the user message's Telegram id too, so /delete can revoke it in the chat.
      const userRowId = saveMessage(chatId, 'user', text, msg.id);
      if (imagePhoto) {
        // Vision pass → caption, linked to the user row. It's injected into the window as
        // an `[image: …]` block; the chat model sees text, never the pixels.
        const bytes = await client.downloadAsBuffer(imagePhoto);
        const caption = await describeImage(Buffer.from(bytes).toString('base64'));
        saveAttachment(userRowId, 0, caption);
        log.info(`Image caption: ${caption.slice(0, 120)}`);
      }
      // Build the cache-friendly window (now including this message + caption) and reply,
      // running any web_search tool calls the model makes before it answers.
      return generateWithTools(chatId, systemPrompt, userRowId);
    });
    // Strip any leftover tool call (cap hit) so a raw tag never reaches the chat.
    const replyText = finalizeReply(reply.content);
    // Send first so we can record the message id — /reroll and /update edit it in place.
    const sent = await client.answerText(msg, renderMarkdown(replyText));
    saveMessage(chatId, 'assistant', replyText, sent.id, {
      provider: activeProviderId(),
      model: reply.model,
    });
  } catch (err) {
    log.error('LLM error:', err);
    await client.answerText(msg, '⚠️ Sorry, I could not get a response from the language model.');
  }
}

async function main(): Promise<void> {
  log.info('Starting UserBot...');

  runMigrations();

  // Pick the LLM backend up front: local llama.cpp if reachable, else OpenRouter.
  await initProvider();

  const self = await client.start({ phone: config.phone });
  const selfName = self.displayName ?? self.username ?? String(self.id);

  log.info(`Logged in as ${selfName} (id: ${self.id})`);
  log.info(`Whitelisted users: ${[...config.whitelist].join(', ') || '(none)'}`);

  client.onNewMessage.add((msg) => {
    handleMessage(msg, selfName);
  });

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
