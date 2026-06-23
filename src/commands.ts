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
import { renderSystemPrompt } from './prompt.js';
import {
  deleteLastMessages,
  getLastAssistant,
  getLastRole,
  getWindow,
  getWindowInfo,
  resetMemory,
  updateMessageContent,
  MIN_WINDOW,
  STEP,
} from './memory.js';
import { renderMarkdown } from './format.js';
import { withTyping } from './typing.js';
import { getSearchUsage, isSearchConfigured } from './search.js';
import { finalizeReply } from './tools.js';
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
   * Sends a message as command output. Tracked so it can be auto-deleted (for both
   * sides) once the user sends their next normal message. Use this instead of
   * `client.answerText` in command handlers.
   */
  reply: (content: InputText) => Promise<Message>;
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
  name: 'reset',
  description: 'Clear conversation memory',
  handler: async ({ reply, chatId }) => {
    const cleared = resetMemory(chatId);
    await reply(md`🗑️ Memory cleared (**${cleared}** messages removed).`);
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

    // Soft-flag the rows (like /reset), then revoke those messages in the chat.
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
  name: 'clear',
  description: 'Erase the whole Telegram chat for both sides + clear memory',
  handler: async ({ client, msg, reply, chatId }) => {
    // Same as /reset: soft-delete the conversation memory.
    resetMemory(chatId);
    // Then wipe the Telegram chat history for both participants. `revoke` deletes
    // for everyone; maxId 0 (default) removes all messages — including this command,
    // so no confirmation is sent (the now-empty chat is the result).
    try {
      await client.deleteHistory(msg.chat, { mode: 'revoke' });
    } catch (err) {
      await reply('⚠️ Memory cleared, but could not erase the Telegram chat history.');
      throw err;
    }
  },
});

register({
  name: 'reroll',
  aliases: ['r'],
  description: 'Regenerate the last reply, editing it in place',
  handler: async ({ client, msg, reply, chatId, userName }) => {
    const last = getLastAssistant(chatId);
    if (!last) {
      await reply('Nothing to reroll — no previous reply.');
      return;
    }
    if (last.tgMessageId === null) {
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
    // so the model answers the last user message afresh.
    const history = getWindow(chatId);
    while (history.length && history[history.length - 1].role === 'assistant') history.pop();

    const systemPrompt = renderSystemPrompt({ userName });
    let regenerated: ChatResult;
    try {
      regenerated = await withTyping(client, msg.chat, () => chat(systemPrompt, history));
    } catch {
      await reply('⚠️ Could not reach the language model.');
      return;
    }

    // Reroll doesn't run the search loop, so strip any tool call the model emits rather
    // than leak a raw tag into the chat (the stored search blocks still ground the reply).
    const regenText = finalizeReply(regenerated.content);
    // Override the existing record in place (no new row), refreshing provenance to the
    // model that just regenerated it, and edit the sent message.
    updateMessageContent(last.id, regenText, {
      provider: activeProviderId(),
      model: regenerated.model,
    });
    try {
      await client.editMessage({
        chatId: msg.chat,
        message: last.tgMessageId,
        text: renderMarkdown(regenText),
      });
    } catch {
      // Most likely MESSAGE_NOT_MODIFIED — the reroll produced an identical reply.
      await reply('Reroll produced the same reply.');
    }
  },
});

register({
  name: 'update',
  aliases: ['u'],
  description: 'Replace the last reply with your own text: /u <new text>',
  handler: async ({ client, msg, reply, chatId, rawArgs }) => {
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
    if (last.tgMessageId === null) {
      await reply('Cannot update — this reply predates message-id tracking.');
      return;
    }

    // Override the existing record in place (no new row). The text is now human-authored,
    // so clear the provider/model provenance (pass null), then edit the sent message.
    updateMessageContent(last.id, text, null);
    try {
      await client.editMessage({
        chatId: msg.chat,
        message: last.tgMessageId,
        text: renderMarkdown(text),
      });
    } catch {
      await reply('Could not edit the message.');
    }
  },
});

register({
  name: 'proactive',
  aliases: ['pro'],
  description: 'Show the proactive schedule; /proactive test | followup previews an opener now',
  handler: async ({ client, reply, chatId, userName, args }) => {
    const sub = args[0]?.toLowerCase();
    if (sub === 'test' || sub === 'followup') {
      const kind = sub === 'followup' ? 'followup' : 'reachout';
      const result = await runProactiveNow(client, chatId, userName, kind);
      await reply(md(`🛎️ **Proactive ${sub}**\n${result}`));
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
    const systemPrompt = renderSystemPrompt({ userName });

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

register({
  name: 'prompt',
  aliases: ['p'],
  description: 'Show the prompt the LLM receives (system, then first 2 + last 3 messages)',
  handler: async ({ reply, chatId, userName }) => {
    const systemPrompt = renderSystemPrompt({ userName });
    const conversation = getWindow(chatId);

    // Telegram caps messages at 4096 chars; keep each <pre> block under that. The system
    // prompt and the conversation are sent as two separate messages so neither truncates
    // the other (the system prompt alone — persona + tools — can approach the limit).
    const MAX = 3900;
    const clip = (s: string) => (s.length > MAX ? `${s.slice(0, MAX)}\n… (truncated)` : s);

    // 1) The full system prompt.
    await reply(html`<pre>${clip(`[System]\n${systemPrompt}`)}</pre>`);

    // 2) The conversation: first 2 + last 3 messages, eliding the middle of long histories.
    const HEAD = 2;
    const TAIL = 3;
    const parts: ChatMessage[] =
      conversation.length <= HEAD + TAIL
        ? conversation
        : [
            ...conversation.slice(0, HEAD),
            { role: 'system', content: `… (${conversation.length - HEAD - TAIL} messages omitted) …` },
            ...conversation.slice(-TAIL),
          ];

    const convText = conversation.length
      ? parts
          .map((m) =>
            m.role === 'system' && m.content.startsWith('…')
              ? m.content
              : `[${ROLE_LABELS[m.role]}]\n${m.content}`,
          )
          .join('\n\n')
      : '(no conversation yet)';

    await reply(html`<pre>${clip(convText)}</pre>`);
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
