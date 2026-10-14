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
import { NO_ANSWER_FALLBACK, TOOLS_SCAFFOLD } from './prompts/index.js';
import { isSearchConfigured } from './search.js';
import { isSelfieAvailable } from './selfie.js';
import { stripHardTics } from './tics.js';
import { createLogger } from './logger.js';
import { locateToolCall } from './toolSyntax.js';

const log = createLogger('tools');

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
 * The selfie tool — gated on RunPod + OpenRouter being configured (see selfie.ts). Its usage
 * rules live in their own prompt section (prompts/tools/selfie.txt, appended in prompt.ts),
 * not in this one-liner. The arrow (not a direct reference) keeps the tools ↔ selfie import
 * cycle safe at module-init time.
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

/**
 * Renders the tool section appended to the system prompt: the {@link TOOLS_SCAFFOLD} text
 * (search-decision rule, call syntax, worked example) with its {{tools}} tag substituted for
 * the available-tools list. Returns '' when no tool is available, so the prompt is unchanged
 * then.
 *
 * NOTE: the call syntax the scaffold describes is parsed in toolSyntax.ts — if you change the
 * <tool_call> protocol in one place, change it in the other.
 */
export function renderToolsBlock(tools: ToolDef[] = availableTools()): string {
  if (tools.length === 0) return '';
  const list = tools.map((t) => `- ${t.name}(${t.args.join(', ')}): ${t.description}`).join('\n');
  return TOOLS_SCAFFOLD.replace(/\{\{\s*tools\s*\}\}/g, list);
}

export { parseToolCall, stripToolCalls, type ParsedToolCall } from './toolSyntax.js';

/**
 * A model-written imitation of the photo-record block ("[you sent a photo: …]") — the shape
 * old windows injected for real photo turns. Detection only: the reply is sent and persisted
 * verbatim (no silent censorship — the raw output should be visible), the window builder
 * strips assistant brackets at prompt-build time so it can't re-teach itself (memory.ts),
 * and index.ts runs the promise gate on a detected block so the picture the model implied
 * still arrives via a *proper* tool call — or not at all. `[^\]]*` deliberately spans newlines.
 */
const FAKE_PHOTO_RE = /\[\s*you sent (?:a )?photo[^\]]*\]/i;

/** Whether a reply contains a fake photo-record block (see {@link FAKE_PHOTO_RE}). */
export function containsFakePhotoBlock(text: string): boolean {
  return FAKE_PHOTO_RE.test(text);
}

/**
 * Prepares a model reply for sending. Anything from a tool-call opener on is cut (toolSyntax.ts):
 * a valid call left over (the search loop hit its cap, or a context that executes the call
 * separately) or a garbled one alike, so no raw tag reaches the chat — falling back to
 * {@link NO_ANSWER_FALLBACK} if nothing remains. Garbled calls used to be sent as-is for
 * debugging; the raw tags in the chat cost more than they showed, so they're logged instead.
 *
 * NOTE: bracketed `[…]` text (an echoed cue, a fake photo-record block) is deliberately NOT
 * stripped here — model output reaches the chat and the DB unrewritten; only the prompt
 * builder cleans brackets out of what the model is later fed back (see memory.ts).
 */
export function finalizeReply(content: string): string {
  // The outgoing tic guard runs here too, so the saved row matches what send.ts streamed out
  // bubble by bubble (stripHardTics is local, so per-bubble and whole-text passes agree).
  const span = locateToolCall(content);
  if (!span) return stripHardTics(content).trim();
  if (!span.call) log.warn(`Dropped a garbled tool call: ${content.slice(span.start, span.start + 300)}`);
  return stripHardTics(content.slice(0, span.start)).trim() || NO_ANSWER_FALLBACK;
}
