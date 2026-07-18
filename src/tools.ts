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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { isSearchConfigured } from './search.js';
import { isSelfieAvailable } from './selfie.js';

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

/**
 * The selfie tool — gated on RunPod + OpenRouter being configured and the daily cap not yet
 * hit (see selfie.ts). Its usage rules live in their own prompt section (prompts/selfie.txt,
 * appended in prompt.ts), not in this one-liner. The arrow (not a direct reference) keeps
 * the tools ↔ selfie import cycle safe at module-init time.
 */
const SEND_SELFIE: ToolDef = {
  name: 'send_selfie',
  args: ['prompt'],
  description: 'make and send a picture of yourself',
  available: () => isSelfieAvailable(),
};

const ALL_TOOLS: ToolDef[] = [WEB_SEARCH, SEND_SELFIE];

/** Tools currently usable. Empty ⇒ no tool block is rendered and parsing is skipped. */
export function availableTools(): ToolDef[] {
  return ALL_TOOLS.filter((t) => t.available());
}

/** The tool-protocol scaffold (search rule, call syntax, example) with a {{tools}} placeholder. */
let toolsTemplate: string | undefined;

/**
 * Renders the tool section appended to the system prompt: the search-decision rule, the
 * call syntax, a worked example (all from prompts/tools.txt), and the available-tools list
 * substituted for the file's {{tools}} tag. Returns '' when no tool is available, so the
 * prompt is unchanged then. The template is read lazily and cached — code paths that only
 * parse tool calls (no prompt building) don't depend on the file existing.
 *
 * NOTE: the call syntax described in tools.txt is parsed by TOOL_CALL_RE below — if you
 * change the <tool_call> protocol in one place, change it in the other.
 */
export function renderToolsBlock(tools: ToolDef[] = availableTools()): string {
  if (tools.length === 0) return '';

  if (toolsTemplate === undefined) {
    toolsTemplate = readFileSync(resolve(process.cwd(), config.llm.toolsPromptPath), 'utf8').trim();
  }

  const list = tools.map((t) => `- ${t.name}(${t.args.join(', ')}): ${t.description}`).join('\n');
  return toolsTemplate.replace(/\{\{\s*tools\s*\}\}/g, list);
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
 *
 * NOTE: an echoed leading `[…]` annotation (the model copying an injected cue like
 * `[<user> sent a photo: …]`) is deliberately NOT stripped here — the cue-format prompt
 * changes drove organic echoes to ~0, and we keep the raw output transparent (visible in
 * chat and persisted) rather than silently repairing it. See {@link withCaptions}.
 */
export function finalizeReply(content: string): string {
  if (!parseToolCall(content)) return content;
  return stripToolCalls(content) || NO_ANSWER;
}
