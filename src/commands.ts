import { html, md, type InputText, type Message, type TelegramClient } from '@mtcute/node';
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
  renderMemoryBlock,
  renderPersona,
  renderSystemPrompt,
  renderTechnical,
} from './prompt.js';
import {
  deleteLastMessages,
  getLastAssistant,
  getLastRole,
  getWindow,
  getWindowInfo,
  messageCount,
  resetMemory,
  summaryCount,
  updateMessageContent,
  upsertProactiveState,
  MIN_WINDOW,
  STEP,
} from './memory.js';
import { withReplyCue } from './generate.js';
import { forgetDebris } from './panel.js';
import { getPersona, resetPersona, setPersona, undoPersona } from './persona.js';
import { renderMarkdown } from './format.js';
import { withTyping } from './typing.js';
import { getSearchUsage, isSearchConfigured } from './search.js';
import { finalizeReply, renderToolsBlock } from './tools.js';
import { ReplyStreamer } from './send.js';
import { getProactiveStatus, runProactiveNow } from './proactive.js';

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
      await reply(
        md(`☢️ **Nuke** — erases this chat for both sides and wipes memory: **${total}** message${total === 1 ? '' : 's'}, **${nSummaries}** summar${nSummaries === 1 ? 'y' : 'ies'}. Cannot be undone.
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
type PromptPart = 'persona' | 'technical' | 'tools' | 'summaries' | 'chat';

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
  description: 'Show one slice of the LLM prompt: /p [p|tech|t|s|c|h] (default persona)',
  handler: async ({ reply, chatId, userName, args }) => {
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
  name: 'dump',
  description: 'Send the full prompt (system + conversation) as a .md file',
  handler: async ({ replyDocument, chatId, userName }) => {
    const systemPrompt = renderSystemPrompt({ userName, chatId });
    const conversation = getWindow(chatId);

    // Verbatim fidelity: each section's raw text goes inside a fenced block so the .md reader
    // shows exactly what the model receives (the prompt's own `#` headings don't become reader
    // headings). The fence is sized longer than any backtick run inside, so content that itself
    // contains ``` can't break out of the block.
    const fence = (content: string): string => {
      const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
      const ticks = '`'.repeat(Math.max(3, longest + 1));
      return `${ticks}\n${content}\n${ticks}`;
    };

    const convText = conversation.length
      ? conversation.map((m) => `[${ROLE_LABELS[m.role]}]\n${m.content}`).join('\n\n')
      : '(no conversation yet)';

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp =
      `${now.getFullYear()}_${pad(now.getMonth() + 1)}_${pad(now.getDate())}_` +
      `${pad(now.getHours())}${pad(now.getMinutes())}`;
    const heading = now.toLocaleString('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });

    const doc =
      `# Prompt dump — ${heading}\n\n` +
      `## System prompt\n\n${fence(systemPrompt)}\n\n` +
      `## Conversation — ${conversation.length} message${conversation.length === 1 ? '' : 's'}\n\n` +
      fence(convText) +
      '\n';

    await replyDocument(
      Buffer.from(doc, 'utf8'),
      `prompt_${stamp}.md`,
      md(`📄 Full prompt — system + ${conversation.length} message${conversation.length === 1 ? '' : 's'}`),
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
