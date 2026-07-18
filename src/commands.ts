import { html, md, InputMedia, type InputText, type Message, type TelegramClient } from '@mtcute/node';
import { encode } from 'gpt-tokenizer';
import { config } from './config.js';
import {
  activeProviderId,
  chat,
  countContextTokens,
  getMaxContext,
  getOpenRouterInfo,
  getProvidersOverview,
  type ChatMessage,
  type ChatResult,
} from './llm.js';
import {
  renderFactsBlock,
  renderMemoryBlock,
  renderPersona,
  renderSystemPrompt,
  renderTechnical,
} from './prompt.js';
import {
  addFact,
  deleteFact,
  deleteLastMessages,
  editFact,
  factCount,
  getFacts,
  getLastAssistant,
  getLastRole,
  getRecentSummaries,
  getWindow,
  getWindowDetailed,
  getWindowInfo,
  hasPhotoGen,
  lastPhotoGen,
  messageCount,
  photosToday,
  resetMemory,
  savePhotoGen,
  summaryCount,
  updateMessageContent,
  upsertProactiveState,
  MIN_WINDOW,
  STEP,
} from './memory.js';
import { FACT_CATEGORIES, type FactCategory } from './db/schema.js';
import { withReplyCue } from './generate.js';
import { forgetDebris, trackDebris } from './panel.js';
import { endpointHealth, generateSelfie, isSelfieConfigured, savePng } from './selfie.js';
import { getPersona, resetPersona, setPersona, undoPersona } from './persona.js';
import { getCharName, getImgUpscale, normalizeCharName, setCharName, setImgUpscale } from './settings.js';
import { formatDateTime, renderMarkdown } from './format.js';
import { withTyping } from './typing.js';
import { getSearchUsage, isSearchConfigured } from './search.js';
import { finalizeReply, renderToolsBlock } from './tools.js';
import { ReplyStreamer } from './send.js';
import { splitMessage } from './chunker.js';
import { stopInFlight } from './inflight.js';
import { getProactiveStatus, runContinue, runProactiveNow } from './proactive.js';
import { getDiaryStatus, listCandidateChannels, runDiaryNow } from './diary.js';

/** Display labels for chat roles, used by /prompt. */
const ROLE_LABELS: Record<'system' | 'user' | 'assistant', string> = {
  system: 'System',
  user: 'User',
  assistant: 'Assistant',
};

/** Shared context passed to every command handler. */
export interface CommandContext {
  client: TelegramClient;
  msg: Message;
  /** Telegram chat (peer) id — the memory key for this conversation. */
  chatId: number;
  /** Display name of the user we're talking to (for the {{user}} prompt tag). */
  userName: string;
  /** Arguments after the command name, already split by whitespace. */
  args: string[];
  /** Raw argument string (everything after the command name). */
  rawArgs: string;
  /** Timestamp (ms) when the bot process started, for uptime reporting. */
  startedAt: number;
  /** Display name of the logged-in account. */
  selfName: string;
  /**
   * Renders command output into the chat's panel — a single reusable bot message that is
   * edited in place (created if absent), so consecutive commands never stack output. The
   * panel is swept away when the user sends their next normal message. Use this instead
   * of `client.answerText` in command handlers.
   */
  reply: (content: InputText) => Promise<void>;
  /**
   * Sends a file as command output. Files can't live in the panel (a text message can't
   * become a document), so this sends a separate message, tracked as debris: it's swept
   * on the next normal message or the next command. Used by `/dump`.
   */
  replyDocument: (content: Buffer, fileName: string, caption?: InputText) => Promise<void>;
  /**
   * Revokes the chat's panel message (no-op if none). For commands whose success output
   * is the conversation itself (`/reroll`, `/update`): leftover panel content — say a
   * `/prompt` dump — vanishes at the moment the new reply lands.
   */
  dropPanel: () => Promise<void>;
}

export interface Command {
  name: string;
  /** Optional short aliases (e.g. `s` for `status`). Looked up like the primary name. */
  aliases?: string[];
  description: string;
  handler: (ctx: CommandContext) => Promise<void>;
}

/** Formats a millisecond duration as a human-readable uptime string. */
function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

/** The command registry, keyed by primary name. Add new commands here. */
export const commands = new Map<string, Command>();
/** Alias → primary name, for fast lookup. Built alongside `commands`. */
const aliases = new Map<string, string>();

function register(command: Command): void {
  commands.set(command.name, command);
  for (const alias of command.aliases ?? []) {
    aliases.set(alias, command.name);
  }
}

/** Resolves a command by its primary name or one of its aliases. */
export function resolveCommand(name: string): Command | undefined {
  return commands.get(name) ?? commands.get(aliases.get(name) ?? '');
}

register({
  name: 'help',
  description: 'Show the list of available commands',
  handler: async ({ reply }) => {
    const list = [...commands.values()]
      .map((cmd) => {
        const names = [cmd.name, ...(cmd.aliases ?? [])].map((n) => `\`/${n}\``).join(' ');
        return `${names} — ${cmd.description}`;
      })
      .join('\n');
    await reply(md(`**🤖 UserBot — available commands**\n\n${list}`));
  },
});

register({
  name: 'status',
  aliases: ['s'],
  description: 'Show the bot status (uptime, account, LLM providers)',
  handler: async ({ reply, startedAt, selfName }) => {
    const uptime = formatUptime(Date.now() - startedAt);
    const providers = await getProvidersOverview();

    // One line per provider: state, model, vision, and which one is active.
    const lines = providers.map((p) => {
      const tag = p.active ? ' ← active' : '';
      if (!p.configured) return `• ${p.label}: not configured${tag}`;
      if (!p.online) return `• ${p.label}: offline ❌${tag}`;
      const vision = p.vision ? 'vision ✅' : 'vision ❌';
      return `• ${p.label}: online ✅ · \`${p.model ?? 'unknown'}\` · ${vision}${tag}`;
    });

    // Dedicated OpenRouter vision model that captions photos when the active model is text-only.
    const captionModel = config.llm.captionModel;
    let captionLine: string;
    if (!captionModel) {
      captionLine = '• Image caption fallback: not configured';
    } else if (!config.llm.openrouter.apiKey) {
      captionLine = `• Image caption fallback: \`${captionModel}\` · ⚠️ needs OPENROUTER_API_KEY`;
    } else {
      // Only engaged while the active model can't see images; otherwise it captions itself.
      const active = providers.find((p) => p.active);
      const state = active && !active.vision ? 'active ✅' : 'idle (active model has vision)';
      captionLine = `• Image caption fallback: \`${captionModel}\` · ${state}`;
    }

    // Web search: configured? plus plan + credit usage when the API answers.
    let searchLine: string;
    if (!isSearchConfigured()) {
      searchLine = '• Tavily: not configured';
    } else {
      const u = await getSearchUsage();
      if (!u) {
        searchLine = '• Tavily: configured ✅ · usage unavailable';
      } else {
        const plan = u.plan ? `${u.plan} plan` : 'configured ✅';
        const credits =
          u.used !== null && u.limit !== null ? ` · ${u.used}/${u.limit} credits` : '';
        searchLine = `• Tavily: ${plan}${credits}`;
      }
    }

    await reply(
      md(`**📊 Status**
Account: **${selfName}**
State: **online** ✅
Uptime: **${uptime}**
Whitelisted users: **${config.whitelist.size}**

**🧠 LLM providers**
${lines.join('\n')}
${captionLine}

**🔎 Web search**
${searchLine}`),
    );
  },
});

register({
  name: 'openrouter',
  aliases: ['or'],
  description: 'Show OpenRouter status, model and free-tier limits',
  handler: async ({ reply }) => {
    const info = await getOpenRouterInfo();
    if (!info.configured) {
      await reply(
        md('🌐 **OpenRouter** — not configured.\nSet `OPENROUTER_API_KEY` in your `.env` to enable it as a fallback.'),
      );
      return;
    }

    const isActive = activeProviderId() === 'openrouter';
    const reachable = info.key !== null;

    // Model facts (context length / vision / free) from the /models metadata.
    const m = info.modelInfo;
    const ctx = m?.contextLength ? `${m.contextLength.toLocaleString('en-US')} tokens` : 'unknown';
    const vision = m ? (m.vision ? 'supported ✅' : 'not supported ❌') : 'unknown';
    const tier = m ? (m.free ? 'free' : 'paid') : 'unknown';

    // Usage / limits from the /key endpoint.
    const k = info.key;
    const usd = (n: number) => `$${n.toFixed(4)}`;
    const usage = k?.usage !== undefined ? usd(k.usage) : 'unknown';
    // Per-period breakdown (today / 7d / 30d), shown only when the API provides it.
    const breakdown = [
      k?.usage_daily !== undefined ? `today ${usd(k.usage_daily)}` : null,
      k?.usage_weekly !== undefined ? `7d ${usd(k.usage_weekly)}` : null,
      k?.usage_monthly !== undefined ? `30d ${usd(k.usage_monthly)}` : null,
    ].filter(Boolean);
    const usageLine = breakdown.length ? `${usage} · ${breakdown.join(' · ')}` : usage;
    const limit =
      k?.limit === null || k?.limit === undefined
        ? 'no credit limit (pay-as-you-go)'
        : `${usd(k.limit)} · remaining ${k.limit_remaining != null ? usd(k.limit_remaining) : '—'}`;
    const freeTier = k?.is_free_tier ? 'yes' : 'no';

    // Upstream provider routing preference.
    const r = info.routing;
    const orderStr = r.order.length ? r.order.join(' → ') : 'default (OpenRouter decides)';
    const fallback = r.allowFallbacks ? 'fallback on ✅' : 'fallback off ❌';
    const sortStr = r.sort ? ` · sort: ${r.sort}` : '';

    await reply(
      md(`🌐 **OpenRouter**
Configured: **yes** · ${reachable ? 'reachable ✅' : 'unreachable ❌'}${isActive ? ' · **active**' : ' · standby (local is active)'}
Model: \`${info.model}\`
Context: **${ctx}** · Vision: **${vision}** · Tier: **${tier}**
Route: **${orderStr}** · ${fallback}${sortStr}

**💳 Account**
Usage: **${usageLine}**
Limit: **${limit}**
Free-tier key: **${freeTier}**`),
    );
  },
});

register({
  name: 'delete',
  aliases: ['d'],
  description: 'Delete the last N messages for both sides (default 1): /d [N]',
  handler: async ({ client, msg, reply, chatId, args }) => {
    const n = args.length ? Number(args[0]) : 1;
    if (!Number.isInteger(n) || n < 1) {
      await reply(md('Usage: `/d [N]` — deletes the last N messages (default 1).'));
      return;
    }

    // Soft-flag the rows (like /nuke), then revoke those messages in the chat.
    const { flagged, tgMessageIds } = deleteLastMessages(chatId, n);
    if (flagged === 0) {
      await reply('Nothing to delete.');
      return;
    }
    if (tgMessageIds.length) {
      await client.deleteMessagesById(msg.chat, tgMessageIds, { revoke: true }).catch(() => {});
    }
    // No confirmation message — the messages vanishing for both sides is the feedback.
  },
});

register({
  name: 'trim',
  aliases: ['t'],
  description: "Trim the last N bubbles off my most recent reply (default 1): /t [N]",
  handler: async ({ client, msg, reply, chatId, args }) => {
    const n = args.length ? Number(args[0]) : 1;
    if (!Number.isInteger(n) || n < 1) {
      await reply(md('Usage: `/t [N]` — trims the last N bubbles off my most recent reply (default 1).'));
      return;
    }
    // Only trim when the reply is genuinely the last turn (like /reroll); a newer user message
    // would make "the last reply" ambiguous.
    if (getLastRole(chatId) !== 'assistant') {
      await reply('Nothing to trim — the last message is not my reply.');
      return;
    }
    const last = getLastAssistant(chatId);
    if (!last) {
      await reply('Nothing to trim — no previous reply.');
      return;
    }
    if (last.tgMessageIds === null) {
      await reply('Cannot trim — this reply predates message-id tracking.');
      return;
    }
    // A photo turn is one photo message, not text bubbles — nothing to trim off it.
    if (hasPhotoGen(last.id)) {
      await reply(md('Cannot trim a photo message — use `/d 1` to remove it.'));
      return;
    }

    // Re-split the stored reply into the same bubbles it was sent as. The split is deterministic
    // and idempotent with sanitize, so an ordinary streamed reply re-splits to exactly its stored
    // bubble ids. When the counts don't match — a /update'd reply (one message, many sentences), an
    // empty/degenerate reply, or a rare prose+tool-tag leak — the mapping is unsafe, so refuse
    // rather than revoke the wrong bubble.
    const ids = last.tgMessageIds;
    const pieces = splitMessage(last.content);
    if (pieces.length !== ids.length) {
      await reply(md("Can't cleanly trim this reply — its bubbles don't line up (likely edited via `/u`). Use `/u` to rewrite it."));
      return;
    }

    // Trimming the whole reply (or more) is just a full delete — reuse the /delete path so the row
    // is flagged and every bubble revoked, consistent with `/d 1`.
    if (n >= pieces.length) {
      const { tgMessageIds } = deleteLastMessages(chatId, 1);
      if (tgMessageIds.length) {
        await client.deleteMessagesById(msg.chat, tgMessageIds, { revoke: true }).catch(() => {});
      }
      return;
    }

    // Revoke the last N bubbles and repoint the row at what's left. Kept pieces are rejoined with
    // newlines (a terminator the splitter honours) so their dot-stripped forms re-split identically
    // on a later /trim; provenance is left unchanged (still my words, just shorter).
    const dropIds = ids.slice(ids.length - n);
    const keepIds = ids.slice(0, ids.length - n);
    await client.deleteMessagesById(msg.chat, dropIds, { revoke: true }).catch(() => {});
    updateMessageContent(last.id, pieces.slice(0, pieces.length - n).join('\n'), undefined, keepIds);
    // No confirmation — the bubbles vanishing is the feedback (like /d).
  },
});

/** Non-deleted message count above which /nuke demands an explicit `confirm` argument. */
const NUKE_CONFIRM_THRESHOLD = 20;

register({
  name: 'nuke',
  description: 'Erase the chat for both sides + wipe all memory: /nuke [confirm]',
  handler: async ({ client, msg, reply, chatId, args }) => {
    // Guard the irreversible path: past the threshold, show what would die and require
    // an explicit `/nuke confirm`. The prompt lives in the panel, so ignoring it makes
    // it sweep away like any other command output. Tiny (test) chats skip the ceremony.
    const total = messageCount(chatId);
    if (total > NUKE_CONFIRM_THRESHOLD && args[0]?.toLowerCase() !== 'confirm') {
      const nSummaries = summaryCount(chatId);
      const nFacts = factCount(chatId);
      await reply(
        md(`☢️ **Nuke** — erases this chat for both sides and wipes memory: **${total}** message${total === 1 ? '' : 's'}, **${nSummaries}** summar${nSummaries === 1 ? 'y' : 'ies'}, **${nFacts}** fact${nFacts === 1 ? '' : 's'}. Cannot be undone.
Send \`/nuke confirm\` to proceed.`),
      );
      return;
    }

    // Telegram first: if the history wipe fails, memory is untouched and nothing is
    // lost — just retry. `revoke` deletes for both participants; maxId 0 (default)
    // removes everything, including this command and the panel, so no confirmation
    // message is sent (the now-empty chat is the result).
    await client.deleteHistory(msg.chat, { mode: 'revoke' });
    // Soft-delete the conversation memory and the chat's long-term summaries.
    resetMemory(chatId);
    // A fresh start shouldn't inherit proactive escalation from the previous life.
    upsertProactiveState(chatId, { dueAt: null, isMorning: false, ignoredCount: 0 });
    // The tracked panel/file/command messages died with the history — drop their rows.
    forgetDebris(chatId);
  },
});

register({
  name: 'clear',
  aliases: ['cls'],
  description: 'Clear leftover command output (the panel) without sending a message',
  handler: async ({ dropPanel }) => {
    // The dispatcher already swept /dump files and stranded command messages before this handler
    // ran, and the /clear message itself is deleted afterward — so dropping the panel is all that's
    // left to return the chat to just the conversation. Deliberately no reply(): it would only
    // spawn a fresh panel in place of the one we're clearing.
    await dropPanel();
  },
});

register({
  name: 'reroll',
  aliases: ['r'],
  description: 'Regenerate the last reply, editing it in place',
  handler: async ({ client, msg, reply, dropPanel, chatId, userName }) => {
    const last = getLastAssistant(chatId);
    if (!last) {
      await reply('Nothing to reroll — no previous reply.');
      return;
    }
    if (last.tgMessageIds === null) {
      await reply('Cannot reroll — this reply predates message-id tracking.');
      return;
    }
    // Rerolling a photo turn would revoke the image and answer with text — blocked in v1 so
    // an image can't be lost by habit. (A future /r-on-photo could re-run the same tag
    // prompt with a fresh seed instead; the guard lives here, not in the shared machinery.)
    if (hasPhotoGen(last.id)) {
      await reply(md('Cannot reroll a photo message — use `/d 1` to remove it, or ask her for another pic.'));
      return;
    }
    // Only reroll when the assistant reply is genuinely the last turn. If a newer user
    // message exists, regenerating would answer that one but overwrite the older reply.
    if (getLastRole(chatId) !== 'assistant') {
      await reply('Cannot reroll — the last message is not my reply.');
      return;
    }

    // Regenerate against the context up to (but excluding) the reply we're replacing,
    // so the model answers the last user message afresh — with the same format cue a
    // first-pass reply gets, so a reroll can't come back as a wall of text.
    const history = getWindow(chatId);
    while (history.length && history[history.length - 1].role === 'assistant') history.pop();
    const rerollHistory = withReplyCue(history);

    const systemPrompt = renderSystemPrompt({ userName, chatId });
    const oldIds = last.tgMessageIds;
    // A streamed reply can't be edited in place (the new reply may split into a different
    // number of bubbles), so we replace by deletion. The swap happens the instant the first
    // new bubble is ready: clear the old reply's bubble(s) AND the `/r` command, so the new
    // bubbles take their place cleanly instead of appearing below `/r`. If generation fails
    // before producing anything, this never runs and the old reply is left untouched.
    const streamer = new ReplyStreamer(client, msg.chat, async () => {
      await client.deleteMessagesById(msg.chat, oldIds, { revoke: true }).catch(() => {});
      await client.deleteMessages([msg], { revoke: true }).catch(() => {});
      // /r's output is the regenerated reply itself, not the panel — any open panel
      // content (a /prompt dump, a /status readout) goes with the old reply.
      await dropPanel();
    });
    let regenerated: ChatResult;
    try {
      // Reroll is a single pass — one beginPass.
      regenerated = await withTyping(client, msg.chat, () => {
        streamer.beginPass();
        return chat(systemPrompt, rerollHistory, streamer.onToken);
      });
    } catch {
      // If nothing streamed, the old reply is untouched — just report. If bubbles already
      // landed, fall through and treat what streamed as the regenerated reply.
      if (streamer.ids.length === 0) {
        await reply('⚠️ Could not reach the language model.');
        return;
      }
      regenerated = { content: streamer.streamedText, model: null };
    }

    // Reroll doesn't run the search loop, so strip any tool call the model emits rather
    // than leak a raw tag into the chat (the stored search blocks still ground the reply).
    const regenText = finalizeReply(regenerated.content);
    const newIds = await streamer.finalize(regenText);
    if (newIds.length === 0) {
      await reply('⚠️ Could not send the rerolled reply.');
      return;
    }
    // Repoint the existing record (no new row) at the fresh bubbles, refreshing provenance
    // to the model that just regenerated it.
    updateMessageContent(
      last.id,
      regenText,
      { provider: activeProviderId(), model: regenerated.model },
      newIds,
    );
  },
});

register({
  name: 'update',
  aliases: ['u'],
  description: 'Replace the last reply with your own text: /u <new text>',
  handler: async ({ client, msg, reply, dropPanel, chatId, rawArgs }) => {
    const text = rawArgs.trim();
    if (!text) {
      await reply(md('Usage: `/u <text>` — replaces the last reply with your own text.'));
      return;
    }

    const last = getLastAssistant(chatId);
    if (!last) {
      await reply('Nothing to update — no previous reply.');
      return;
    }
    if (last.tgMessageIds === null) {
      await reply('Cannot update — this reply predates message-id tracking.');
      return;
    }
    // Replacing a photo turn with text would silently destroy the image — blocked in v1.
    if (hasPhotoGen(last.id)) {
      await reply(md('Cannot update a photo message — use `/d 1` to remove it.'));
      return;
    }

    // The replacement is verbatim user text, so it's sent as a single message — never split
    // into bubbles. Send it first, then revoke all old bubble(s) and repoint the row at the
    // new message. Provenance is cleared (null): the text is now human-authored.
    let sent: Message;
    try {
      sent = await client.sendText(msg.chat, renderMarkdown(text));
    } catch {
      await reply('Could not send the replacement message.');
      return;
    }
    await client.deleteMessagesById(msg.chat, last.tgMessageIds, { revoke: true }).catch(() => {});
    updateMessageContent(last.id, text, null, [sent.id]);
    // Like /r: the replacement text is the output — clear any open panel with the swap.
    await dropPanel();
  },
});

register({
  name: 'continue',
  aliases: ['go'],
  description: 'Advance the conversation on my behalf when you\'re stuck: /go [directive]',
  handler: async ({ client, dropPanel, chatId, userName, rawArgs }) => {
    // The output is the streamed reply itself (like /reroll and /update), not the panel — clear any
    // open panel so a leftover /prompt dump doesn't hover above the new turn. An optional directive
    // steers what to say ("/go ask about the weekend"); empty just keeps the thread moving.
    await dropPanel();
    try {
      await runContinue(client, chatId, userName, rawArgs.trim());
    } catch (err) {
      // /stop aborts the generation with an AbortError — an intentional halt, not a failure: the
      // partial is already persisted, so swallow it rather than show the dispatcher's error panel.
      // Any real failure still propagates for the dispatcher to surface.
      if ((err as { name?: string } | null)?.name !== 'AbortError') throw err;
    }
  },
});

register({
  name: 'stop',
  description: 'Stop my reply mid-generation — aborts the model and halts further messages',
  handler: async ({ chatId }) => {
    // Normally intercepted out-of-queue by the dispatcher so it can interrupt an in-flight reply
    // instead of queueing behind it (index.ts). This registry entry keeps /stop in /help and acts
    // as a harmless fallback if it ever reaches here (there's nothing generating to abort).
    stopInFlight(chatId);
  },
});

register({
  name: 'proactive',
  aliases: ['pro'],
  description: 'Show the proactive schedule; /proactive test previews a reach-out now',
  handler: async ({ client, reply, chatId, userName, args }) => {
    const sub = args[0]?.toLowerCase();
    if (sub === 'test') {
      const result = await runProactiveNow(client, chatId, userName);
      await reply(md(`🛎️ **Proactive test**\n${result}`));
      return;
    }
    await reply(md(`🛎️ **Proactive**\n${getProactiveStatus(chatId)}`));
  },
});

register({
  name: 'diary',
  description: 'Show the diary schedule; /diary test posts an entry now',
  handler: async ({ client, reply, args }) => {
    const sub = args[0]?.toLowerCase();
    if (sub === 'test') {
      const result = await runDiaryNow(client);
      await reply(md(`📓 **Diary test**\n${result}`));
      return;
    }
    let body = getDiaryStatus();
    // No channel configured yet: append the candidates (channels this account can post to)
    // so the id can be copied into .env without grepping logs or scripting the API. Not
    // gated on `enabled` — the id can then be discovered before flipping the feature on,
    // and both settings land in .env in one edit (one restart instead of two).
    if (config.diary.channelId === undefined) {
      const candidates = await listCandidateChannels(client);
      body += candidates.length
        ? `\n\nChannels this account can post to:\n${candidates.map((c) => `• \`${c.id}\` — ${c.title}`).join('\n')}\nSet \`DIARY_CHANNEL_ID\` in .env and restart.`
        : '\n\nNo postable channels found — create one from this account first.';
    }
    await reply(md(`📓 **Diary**\n${body}`));
  },
});

/** The `/img` help: the action menu. */
const IMG_HELP = md(`**📸 /img** — selfie generation (the send_selfie tool)
\`/img\` — status: endpoint health, today's count, last generation
\`/img upscale on|off\` — toggle the 2× upscale pass (off = ~half the time/cost, for testing)
\`/img gen <prose>\` — test the pipeline directly: prose → booru tags → image (doesn't touch the conversation or the daily cap)`);

register({
  name: 'img',
  description: "Selfie generation: /img (status) · upscale on|off · gen <prose>",
  handler: async ({ client, msg, reply, chatId, args, rawArgs }) => {
    const sub = args[0]?.toLowerCase();

    if (sub === 'upscale') {
      const arg = args[1]?.toLowerCase();
      if (arg !== 'on' && arg !== 'off') {
        await reply(IMG_HELP);
        return;
      }
      const value = arg === 'on';
      const prev = setImgUpscale(value);
      const desc = value
        ? `**on** — 2× second pass, ${config.selfie.width * 2}×${config.selfie.height * 2}`
        : `**off** — single pass, ${config.selfie.width}×${config.selfie.height}`;
      await reply(md(prev === null ? `Upscale already ${desc}.` : `✅ Upscale ${desc}.`));
      return;
    }

    if (sub === 'gen') {
      const prose = rawArgs.slice(3).trim();
      if (!prose) {
        await reply(IMG_HELP);
        return;
      }
      if (!isSelfieConfigured()) {
        await reply(md('📸 Not configured — set `RUNPOD_API_KEY`, `RUNPOD_ENDPOINT_ID` and `OPENROUTER_API_KEY`.'));
        return;
      }
      await reply(md(`📸 Generating (upscale ${getImgUpscale() ? 'on' : 'off'})… this can take a few minutes on a cold worker.`));
      try {
        const gen = await generateSelfie(prose);
        const filePath = savePng(gen.buffer);
        // A test image is command output, not conversation: tracked as `file` debris (like
        // /dump), no message row, no attachment — the model never learns it happened.
        const sent = await client.sendMedia(
          msg.chat,
          InputMedia.photo(gen.buffer, {
            caption: md(
              `📸 delay ${((gen.delayMs ?? 0) / 1000).toFixed(1)}s · exec ${((gen.execMs ?? 0) / 1000).toFixed(1)}s · seed \`${gen.seed}\` · upscale ${gen.upscaled ? 'on' : 'off'}`,
            ),
          }),
        );
        trackDebris(chatId, sent.id, 'file');
        savePhotoGen({
          prose,
          tags: gen.tags,
          seed: gen.seed,
          upscaled: gen.upscaled,
          jobId: gen.jobId,
          delayMs: gen.delayMs,
          execMs: gen.execMs,
          status: 'ok',
          filePath: filePath ?? undefined,
        });
        // The panel gets the exact tag prompt, so a bad image is diagnosable on the spot.
        const MAX = 3500;
        const tags = gen.tags.length > MAX ? `${gen.tags.slice(0, MAX)}…` : gen.tags;
        await reply(html`📸 Done. Tags:<br><pre>${tags}</pre>`);
      } catch (err) {
        savePhotoGen({ prose, tags: '', upscaled: getImgUpscale(), status: 'failed', error: String(err).slice(0, 500) });
        await reply(md(`⚠️ Generation failed: ${String(err).slice(0, 300)}`));
      }
      return;
    }

    if (sub !== undefined) {
      await reply(IMG_HELP);
      return;
    }

    // Status.
    if (!isSelfieConfigured()) {
      await reply(
        md('📸 **Selfies** — not configured.\nNeeds `RUNPOD_API_KEY`, `RUNPOD_ENDPOINT_ID` and `OPENROUTER_API_KEY` in `.env`.'),
      );
      return;
    }
    const [health, today] = [await endpointHealth(), photosToday()];
    const w = health?.workers;
    const healthLine = w
      ? `ready ${w.ready} · running ${w.running} · initializing ${w.initializing} · throttled ${w.throttled}` +
        (health.jobs.inQueue ? ` · ⚠️ ${health.jobs.inQueue} queued` : '')
      : 'unreachable ❌';
    const upscale = getImgUpscale();
    const sizeStr = upscale
      ? `${config.selfie.width * 2}×${config.selfie.height * 2} (upscale on)`
      : `${config.selfie.width}×${config.selfie.height} (upscale off)`;

    const last = lastPhotoGen();
    let lastLine = 'none yet';
    if (last) {
      const status = last.status === 'ok' ? '✅' : `❌ ${last.error ?? 'failed'}`;
      const timing =
        last.execMs != null ? ` · delay ${((last.delayMs ?? 0) / 1000).toFixed(0)}s exec ${(last.execMs / 1000).toFixed(0)}s` : '';
      const kind = last.chatId == null ? ' · test' : '';
      lastLine = `${formatDateTime(last.createdAt)} ${status}${timing}${kind}\n"${last.prose.slice(0, 120)}"`;
    }

    await reply(
      md(`**📸 Selfies**
Endpoint: **${config.selfie.endpointId}** · ${healthLine}
Today: **${today}/${config.selfie.dailyCap}** · Output: **${sizeStr}**
Booru model: \`${config.selfie.model}\`

**Last generation**
${lastLine}`),
    );
  },
});

register({
  name: 'context',
  aliases: ['c'],
  description: 'Show context token usage',
  handler: async ({ reply, chatId, userName }) => {
    const info = getWindowInfo(chatId);
    const window = getWindow(chatId);
    const systemPrompt = renderSystemPrompt({ userName, chatId });

    let used: number | null = null;
    try {
      used = await countContextTokens(systemPrompt, window);
    } catch {
      used = null;
    }
    const max = await getMaxContext();

    const n = (x: number) => x.toLocaleString('en-US');
    // OpenRouter has no tokenize endpoint, so its counts are tokenizer estimates (≈).
    const approx = activeProviderId() === 'openrouter' ? '≈' : '';
    const usedStr = used === null ? 'unavailable' : `${approx}${n(used)}`;
    const maxStr = max === null ? 'unknown' : n(max);
    const pct = used !== null && max ? ` · **${((used / max) * 100).toFixed(1)}%**` : '';

    const source =
      info.total === 0
        ? 'System prompt only — memory empty'
        : `System prompt + last **${info.windowCount}** message${info.windowCount === 1 ? '' : 's'}`;

    // Explain the cache-friendly window: it holds the newest MIN_WINDOW..MIN_WINDOW+STEP-1
    // messages, growing 1-per-message, then snaps back to MIN_WINDOW (a full recompute).
    const windowLine =
      info.total <= MIN_WINDOW
        ? `Holding all **${info.total}** stored (grows to ${MIN_WINDOW} before it starts re-anchoring)`
        : `Re-anchors every **${STEP}** msgs to keep KV-cache warm · next snap in **${info.untilReanchor}**`;

    await reply(
      md(`**📐 Context**

**🪟 Window** — ${info.windowCount} of ${info.total} stored
${windowLine}

**🔢 Tokens** — ${usedStr} / ${maxStr}${pct}
${source}`),
    );
  },
});

/** The slices of the LLM prompt that `/prompt` can show, one at a time. */
type PromptPart = 'persona' | 'technical' | 'tools' | 'summaries' | 'facts' | 'chat';

/** Maps the argument the user types to a part. `/prompt` with no arg defaults to `persona`. */
const PROMPT_PART_ALIASES: Record<string, PromptPart> = {
  p: 'persona',
  persona: 'persona',
  tech: 'technical',
  technical: 'technical',
  t: 'tools',
  tools: 'tools',
  s: 'summaries',
  summary: 'summaries',
  summaries: 'summaries',
  f: 'facts',
  fact: 'facts',
  facts: 'facts',
  c: 'chat',
  chat: 'chat',
  history: 'chat',
  conversation: 'chat',
};

/** The `/prompt h` help text: the part menu, plus a pointer to `/dump` for the whole thing. */
const PROMPT_HELP = md(`**🧩 /prompt** \`<part>\` — show one slice of the prompt the LLM receives
\`p\` — persona (default)
\`tech\` — technical layer
\`t\` — tools block
\`s\` — summaries (memory)
\`f\` — facts block as a .md file (as the model sees it — use \`/facts\` to edit)
\`c\` — chat window (first 3 + last 6)
\`h\` — this help

Use \`/dump\` for the full prompt as a \`.md\` file, \`/persona\` to edit the persona layer.`);

/**
 * Renders the chat window the way the LLM-facing window is shaped, but elided for a quick peek:
 * the first {@link HEAD} and last {@link TAIL} messages, with `[Role]` tags, and a marker for the
 * middle that's omitted. `/dump` shows the window in full; this is the at-a-glance version.
 */
function renderChatPeek(conversation: ChatMessage[]): string {
  if (conversation.length === 0) return '(no conversation yet)';
  const HEAD = 3;
  const TAIL = 6;
  const parts: ChatMessage[] =
    conversation.length <= HEAD + TAIL
      ? conversation
      : [
          ...conversation.slice(0, HEAD),
          { role: 'system', content: `… (${conversation.length - HEAD - TAIL} messages omitted) …` },
          ...conversation.slice(-TAIL),
        ];
  return parts
    .map((m) =>
      m.role === 'system' && m.content.startsWith('…')
        ? m.content
        : `[${ROLE_LABELS[m.role]}]\n${m.content}`,
    )
    .join('\n\n');
}

register({
  name: 'prompt',
  aliases: ['p'],
  description: 'Show one slice of the LLM prompt: /p [p|tech|t|s|f|c|h] (default persona)',
  handler: async ({ reply, replyDocument, chatId, userName, args }) => {
    const arg = args[0]?.toLowerCase();
    if (arg === 'h' || arg === 'help') {
      await reply(PROMPT_HELP);
      return;
    }
    // No arg → persona; an unknown arg → the help menu (rather than guessing a part).
    const part = arg === undefined ? 'persona' : PROMPT_PART_ALIASES[arg];
    if (!part) {
      await reply(PROMPT_HELP);
      return;
    }

    // The facts block outgrew the 4096-char panel, so it ships as a verbatim .md file
    // (fenced, like /dump) with the same last-touched caption as /facts.
    if (part === 'facts') {
      const block = renderFactsBlock(chatId, userName);
      if (!block) {
        await reply(html`<pre>[Facts]\n(no facts yet)</pre>`);
        return;
      }
      await replyDocument(
        Buffer.from(`# Facts block — as the model sees it\n\n${mdFence(block)}\n`, 'utf8'),
        `prompt_facts_${fileStamp()}.md`,
        factsCaption(chatId, '🧩 Facts block — as the model sees it'),
      );
      return;
    }

    const ctx = { userName, chatId };
    let label: string;
    let body: string;
    switch (part) {
      case 'persona':
        label = 'Persona';
        body = renderPersona(ctx);
        break;
      case 'technical':
        label = 'Technical';
        body = renderTechnical(ctx);
        break;
      case 'tools':
        label = 'Tools';
        body = renderToolsBlock() || '(no tools available)';
        break;
      case 'summaries':
        label = 'Summaries';
        body = renderMemoryBlock(chatId, userName) || '(no summaries yet)';
        break;
      case 'chat':
        label = 'Chat';
        body = renderChatPeek(getWindow(chatId));
        break;
    }

    // Telegram caps messages at 4096 chars; keep the <pre> block under that. A single part can
    // still overflow (persona is large) — clip it and point at /dump for the untruncated dump.
    const MAX = 3900;
    const text = `[${label}]\n${body}`;
    const clipped =
      text.length > MAX ? `${text.slice(0, MAX)}\n… (truncated — use /dump for the full prompt)` : text;
    await reply(html`<pre>${clipped}</pre>`);
  },
});

/** The `/persona` help: the action menu, plus how it relates to `/prompt`. */
const PERSONA_HELP = md(`**👤 /persona** — view or edit the persona layer of the system prompt
\`/persona\` — show the current persona (raw, \`{{tags}}\` intact — copy from here to edit)
\`/persona set <text>\` — replace the persona (applies instantly, all chats)
\`/persona undo\` — swap with the previous version (run again to redo — handy for A/B)
\`/persona default\` — reset to the shipped default

\`/prompt p\` shows the same layer as the model sees it (tags substituted).`);

register({
  name: 'persona',
  description: 'View or edit the persona: /persona [set <text>|undo|default]',
  handler: async ({ reply, args, rawArgs }) => {
    // Shows the raw persona under an optional status line. The <pre> holds only the persona
    // text (no label) so tap-to-copy on mobile grabs exactly what you'd edit and resend.
    const show = async (status?: string) => {
      const MAX = 3900; // Telegram's 4096 cap, minus room for the status line.
      const body = getPersona();
      const clipped = body.length > MAX ? `${body.slice(0, MAX)}\n… (truncated)` : body;
      await reply(status ? html`${status}<br><pre>${clipped}</pre>` : html`<pre>${clipped}</pre>`);
    };

    const action = args[0]?.toLowerCase();
    switch (action) {
      case undefined:
        await show();
        return;
      case 'set': {
        // Everything after the `set` token, newlines included (rawArgs starts with it).
        const text = rawArgs.slice(3).trim();
        if (!text) {
          await reply(PERSONA_HELP);
          return;
        }
        const prev = setPersona(text);
        if (prev === null) {
          await show('Persona unchanged — the new text is identical.');
          return;
        }
        await show(`✅ Persona updated (${prev.length} → ${text.length} chars) — /persona undo to revert`);
        return;
      }
      case 'undo': {
        const prev = undoPersona();
        if (prev === null) {
          await show('Nothing to undo — no earlier version.');
          return;
        }
        await show(`↩️ Persona reverted (${prev.length} → ${getPersona().length} chars) — /persona undo again to redo`);
        return;
      }
      case 'default': {
        const prev = resetPersona();
        if (prev === null) {
          await show('Persona is already the default.');
          return;
        }
        await show(`✅ Persona reset to default (${prev.length} → ${getPersona().length} chars) — /persona undo to revert`);
        return;
      }
      default:
        await reply(PERSONA_HELP);
    }
  },
});

register({
  name: 'name',
  description: "Show or set the character's name (the {{char}} tag): /name [<name>]",
  handler: async ({ reply, rawArgs }) => {
    const raw = rawArgs.trim();
    // No argument → show the current name and how to change it.
    if (!raw) {
      await reply(
        md(`👤 Character name: **${getCharName()}**\nChange it with \`/name <name>\` — applies to new replies and summaries. Persona text that spells the name out literally (instead of \`{{char}}\`) is unaffected.`),
      );
      return;
    }
    const name = normalizeCharName(raw);
    if (!name) {
      await reply(md('Usage: `/name <name>` — the name must be non-empty.'));
      return;
    }
    const prev = setCharName(name);
    if (prev === null) {
      await reply(md(`Name unchanged — already **${name}**.`));
      return;
    }
    await reply(md(`✅ Character name: **${prev}** → **${name}**.`));
  },
});

/**
 * Wraps raw text in a fenced block sized longer than any backtick run inside, so content
 * that itself contains ``` can't break out — the .md reader shows it verbatim.
 */
function mdFence(content: string): string {
  const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}\n${content}\n${ticks}`;
}

/** `2026_07_17_1930`-style timestamp for generated file names. */
function fileStamp(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}_${pad(now.getMonth() + 1)}_${pad(now.getDate())}_` +
    `${pad(now.getHours())}${pad(now.getMinutes())}`
  );
}

/** The `/facts` help: the action menu, plus how it relates to `/prompt f`. */
const FACTS_HELP = md(`**📇 /facts** \`/f\` — long-term facts about you (edited by the nightly pass)
\`/f\` — all facts with ids, as a .md file
\`/f add <category> <text>\` — record a fact by hand
\`/f set <id> <category> <text>\` — rewrite a fact
\`/f delete <id>\` — remove a fact

Categories: ${FACT_CATEGORIES.map((c) => `\`${c}\``).join(' ')}
\`/prompt f\` shows the block exactly as the model sees it (no ids).`);

/**
 * Caption for the facts file messages: the last 10 added/updated facts, newest first —
 * the "what changed lately" view, since the file itself is ordered by category. Each
 * line and the whole caption are clipped to stay under Telegram's 1024-char caption cap.
 */
function factsCaption(chatId: number, heading: string): string {
  const rows = [...getFacts(chatId)].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10);
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const lines = rows.map((f) => clip(`#${f.id} ${f.content}`, 90));
  return clip(`${heading}\nLast touched:\n${lines.join('\n')}`, 1000);
}

/** The full fact list as a Markdown document: grouped by category, with ids and dates. */
function buildFactsDoc(chatId: number): string {
  const rows = getFacts(chatId);
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const sections = FACT_CATEGORIES.map((cat) => {
    const items = rows.filter((f) => f.category === cat);
    if (items.length === 0) return null;
    const lines = items.map((f) => {
      const dates = day(f.createdAt) + (f.updatedAt !== f.createdAt ? ` → ${day(f.updatedAt)}` : '');
      return `- **#${f.id}** (${dates}) ${f.content}`;
    });
    return `## ${cat} (${items.length})\n\n${lines.join('\n')}`;
  }).filter(Boolean);
  return `# Facts — ${rows.length}\n\n${sections.join('\n\n')}\n`;
}

register({
  name: 'facts',
  aliases: ['f'],
  description: 'Long-term facts as a .md file; /f [add|set|delete] to edit',
  handler: async ({ reply, replyDocument, chatId, args, rawArgs }) => {
    const action = args[0]?.toLowerCase();

    // No args → the full listing as a file (the list outgrew the 4096-char panel), captioned
    // with the 10 most recently touched facts. Tracked as `file` debris like /dump's output.
    if (action === undefined) {
      const total = factCount(chatId);
      if (total === 0) {
        await reply(md('📇 No facts yet — the nightly pass records them, or `/f add <category> <text>`.'));
        return;
      }
      await replyDocument(
        Buffer.from(buildFactsDoc(chatId), 'utf8'),
        `facts_${fileStamp()}.md`,
        factsCaption(chatId, `📇 ${total} fact${total === 1 ? '' : 's'}`),
      );
      return;
    }

    if (action === 'add') {
      const m = rawArgs.match(/^add\s+(\S+)\s+([\s\S]+)$/i);
      const category = m?.[1].toLowerCase() as FactCategory | undefined;
      if (!m || !category || !FACT_CATEGORIES.includes(category)) {
        await reply(FACTS_HELP);
        return;
      }
      const content = m[2].trim();
      const id = addFact(chatId, category, content);
      await reply(md(`✅ Added fact #${id} [${category}]:\n${content}`));
      return;
    }

    if (action === 'set') {
      const m = rawArgs.match(/^set\s+(\d+)\s+(\S+)\s+([\s\S]+)$/i);
      const category = m?.[2].toLowerCase() as FactCategory | undefined;
      if (!m || !category || !FACT_CATEGORIES.includes(category)) {
        await reply(FACTS_HELP);
        return;
      }
      const id = Number(m[1]);
      const content = m[3].trim();
      if (!editFact(chatId, id, content, category)) {
        await reply(md(`⚠️ No fact #${id} here.`));
        return;
      }
      await reply(md(`✅ Fact #${id} [${category}] updated:\n${content}`));
      return;
    }

    if (action === 'delete' || action === 'del') {
      const id = Number(args[1]);
      if (!Number.isInteger(id)) {
        await reply(FACTS_HELP);
        return;
      }
      if (!deleteFact(chatId, id)) {
        await reply(md(`⚠️ No fact #${id} here.`));
        return;
      }
      await reply(md(`🗑 Fact #${id} deleted.`));
      return;
    }

    await reply(FACTS_HELP);
  },
});

register({
  name: 'dump',
  description: 'Send the full annotated prompt (system + conversation) as a .md file',
  handler: async ({ replyDocument, chatId, userName }) => {
    const ctx = { userName, chatId };
    const n = (x: number): string => x.toLocaleString('en-US');
    // GPT-tokenizer estimate, same proxy the OpenRouter provider uses for /context.
    const tok = (s: string): number => (s ? encode(s).length : 0);
    const charName = getCharName();

    // The same pieces renderSystemPrompt joins, in its exact order — the annotated dump must
    // never drift from the live payload. Empty blocks stay in the overview (a zero row says
    // "nothing here yet") but get no body section.
    const nFacts = factCount(chatId);
    const nSummaries = getRecentSummaries(chatId, config.summary.maxKept).length;
    const sections = [
      { emoji: '🎭', name: 'Persona', body: renderPersona(ctx) },
      { emoji: '⚙️', name: 'Technical', body: renderTechnical(ctx) },
      { emoji: '📇', name: `Facts (${nFacts})`, body: renderFactsBlock(chatId, userName) },
      { emoji: '🧠', name: `Memory (${nSummaries} day${nSummaries === 1 ? '' : 's'})`, body: renderMemoryBlock(chatId, userName) },
      { emoji: '🛠️', name: 'Tools', body: renderToolsBlock() },
    ];
    const msgs = getWindowDetailed(chatId);
    const info = getWindowInfo(chatId);

    const systemTokens = tok(sections.map((s) => s.body).filter(Boolean).join('\n\n')) + 4;
    const convTokens = msgs.reduce((sum, m) => sum + tok(m.content) + 4, 0);
    const total = systemTokens + convTokens;

    // The model's max context is a provider call — best-effort, omitted when unreachable.
    let budget = '';
    try {
      const max = await getMaxContext();
      if (max) budget = ` of **${n(max)}** (${((total / max) * 100).toFixed(1)}%)`;
    } catch {
      /* provider unreachable — show the estimate alone */
    }

    const share = (t: number): string => (total > 0 ? `${((t / total) * 100).toFixed(1)}%` : '—');
    const table = [
      '| Section | ≈ Tokens | Share |',
      '|:--|--:|--:|',
      ...sections.map((s) => `| ${s.emoji} ${s.name} | ${n(tok(s.body))} | ${share(tok(s.body))} |`),
      `| 💬 Conversation (${msgs.length}) | ${n(convTokens)} | ${share(convTokens)} |`,
      `| **Total** | **${n(total)}** | 100% |`,
    ].join('\n');

    // Verbatim fidelity: each section's raw text goes inside a fenced block (see mdFence) so
    // the .md reader shows exactly what the model receives (the prompt's own `#` headings
    // don't become reader headings) — only the annotations around the fences are ours.
    const sectionDocs = sections
      .filter((s) => s.body)
      .map((s) => `## ${s.emoji} ${s.name} — ≈${n(tok(s.body))} tokens\n\n${mdFence(s.body)}`);

    // One block per turn: who spoke, when (24h), and — for replies — which model, so a scroll
    // through the dump doubles as a provenance log. Content stays fenced, exactly as the LLM
    // sees it (captions and search blocks included).
    const convHeader =
      `## 💬 Conversation — ${msgs.length} message${msgs.length === 1 ? '' : 's'}` +
      (info.total > msgs.length
        ? ` (of ${info.total} stored · window re-anchors in ${info.untilReanchor})`
        : '');
    const convDoc = msgs.length
      ? msgs
          .map((m, i) => {
            const who = m.role === 'user' ? `🧑 ${userName}` : `🤖 ${charName}`;
            const meta = [
              formatDateTime(m.at),
              m.model ? `\`${m.model}\`` : null,
              m.proactive ? '🛎️ proactive' : null,
            ]
              .filter(Boolean)
              .join(' · ');
            return `**#${i + 1} · ${who}** — ${meta}\n\n${mdFence(m.content)}`;
          })
          .join('\n\n')
      : '_(no conversation yet)_';

    const now = new Date();
    const doc =
      [
        `# 📄 Prompt dump — ${formatDateTime(now.getTime(), { year: true })}`,
        `**Character:** ${charName} · **User:** ${userName} · **Provider:** \`${activeProviderId()}\``,
        `**Payload:** ≈**${n(total)}** tokens${budget} — system ${n(systemTokens)} + conversation ${n(convTokens)}`,
        `_Token counts are GPT-tokenizer estimates (+4 per message for role overhead). Sections appear in the exact order the model receives them; every fenced block is verbatim._`,
        `## 📊 Overview\n\n${table}`,
        ...sectionDocs,
        `${convHeader}\n\n${convDoc}`,
      ].join('\n\n') + '\n';

    await replyDocument(
      Buffer.from(doc, 'utf8'),
      `prompt_${fileStamp(now)}.md`,
      md(`📄 Prompt dump — ≈${n(total)} tokens · ${msgs.length} message${msgs.length === 1 ? '' : 's'} in window`),
    );
  },
});

/**
 * Parses a message text into a command name and its arguments.
 * Returns null if the text is not a command (does not start with "/").
 * Supports the "/cmd@botname" form by stripping the "@..." suffix.
 */
export function parseCommand(text: string): { name: string; args: string[]; rawArgs: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;

  const [head, ...rest] = trimmed.slice(1).split(/\s+/);
  if (!head) return null;

  const name = head.split('@')[0].toLowerCase();
  const rawArgs = trimmed.slice(trimmed.indexOf(head) + head.length).trim();
  return { name, args: rest, rawArgs };
}
