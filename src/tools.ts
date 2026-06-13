/**
 * Tool registry + the pseudo "tool call" protocol.
 *
 * Neither of the bot's models does native OpenAI tool-calling reliably (the roleplay
 * finetune narrates instead of emitting a call; the free model's template has no tools
 * block), but BOTH reliably emit a tagged text protocol when instructed. So tools are
 * described in a block appended to the system prompt, and a call is a single line:
 *
 *   <tool_call>{"name": "web_search", "arguments": {"query": "…"}}</tool_call>
 *
 * The hard part is the *decision* (when to search), not the syntax — hence the firm
 * "treat your current-fact memory as unreliable" rule below, which is what made the
 * smaller model stop answering stale facts from memory in testing.
 */
import { isSearchConfigured } from './search.js';

/** A tool the model may call via the pseudo protocol. */
export interface ToolDef {
  name: string;
  /** Argument names, rendered as `name(arg1, arg2)`. */
  args: string[];
  /** One-line summary of what the tool does. */
  description: string;
  /** Whether the tool is currently usable (e.g. its API key is configured). */
  available: () => boolean;
}

/** The web search tool — gated on Tavily being configured. */
const WEB_SEARCH: ToolDef = {
  name: 'web_search',
  args: ['query'],
  description: 'look something up on the web',
  available: isSearchConfigured,
};

const ALL_TOOLS: ToolDef[] = [WEB_SEARCH];

/** Tools currently usable. Empty ⇒ no tool block is rendered and parsing is skipped. */
export function availableTools(): ToolDef[] {
  return ALL_TOOLS.filter((t) => t.available());
}

/**
 * Renders the tool section appended to the system prompt: the search-decision rule, the
 * call syntax, a worked example, and the available tools. Kept terse on purpose (it's in
 * every prompt). Returns '' when no tool is available, so the prompt is unchanged then.
 */
export function renderToolsBlock(tools: ToolDef[] = availableTools()): string {
  if (tools.length === 0) return '';

  const list = tools.map((t) => `- ${t.name}(${t.args.join(', ')}): ${t.description}`).join('\n');

  return `# Tools
Your knowledge has a cutoff, so treat your memory of anything current (who holds a role/title now, news, prices, weather, dates, a real person's latest status) as unreliable — look it up instead of guessing. Don't search for small talk, opinions, or creative/roleplay.

To call a tool, output ONE line, nothing else:
<tool_call>{"name": "TOOL_NAME", "arguments": { ... }}</tool_call>
The result returns as a [web search "…": …] block — use it in your own voice; don't mention searching or quote it verbatim.

Example — User: who's the president of france right now?
<tool_call>{"name": "web_search", "arguments": {"query": "current president of France"}}</tool_call>

Tools:
${list}`;
}

/** A parsed tool call from the model's output. */
export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i;

/**
 * Extracts the first well-formed `<tool_call>` from the model's output, or null. Returns
 * null both when there is no tag and when the tag's JSON is malformed — a malformed call
 * is therefore treated as ordinary text and sent to the user as-is (useful for debugging
 * a misbehaving model, by design).
 */
export function parseToolCall(text: string): ParsedToolCall | null {
  const m = text.match(TOOL_CALL_RE);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { name?: unknown }).name === 'string'
    ) {
      const obj = parsed as { name: string; arguments?: unknown };
      const args =
        typeof obj.arguments === 'object' && obj.arguments !== null
          ? (obj.arguments as Record<string, unknown>)
          : {};
      return { name: obj.name, arguments: args };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Removes every well-formed `<tool_call>…</tool_call>` block from text. Used only as a
 * safety net for the final reply when the model hit the per-turn search cap but still
 * emitted a call — so a raw tag never reaches the chat.
 */
export function stripToolCalls(text: string): string {
  return text.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').trim();
}

/** Fallback shown when a reply is nothing but an (unfulfillable) tool call. */
const NO_ANSWER = "couldn't dig that up, sorry — try rephrasing?";

/**
 * Prepares a model reply for sending. If it contains a *valid* tool call (e.g. the search
 * loop hit its cap, or a context like /reroll that doesn't run tools), the call is stripped
 * so no raw tag reaches the chat — falling back to {@link NO_ANSWER} if nothing remains. A
 * reply with no tag, or with a *malformed* tag, is returned unchanged (sent as-is, which
 * surfaces a misbehaving model for debugging by design).
 */
export function finalizeReply(content: string): string {
  if (!parseToolCall(content)) return content;
  return stripToolCalls(content) || NO_ANSWER;
}
