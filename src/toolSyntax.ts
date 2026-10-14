/**
 * Parsing for the pseudo tool-call protocol (see tools.ts for the protocol itself). Pure and
 * import-free so the window builder and the tests can use it without loading config.
 *
 * The model reliably *opens* a call correctly but often fumbles the close: the 2026-10-11 model
 * A/B found 7 of 26 V4 Flash calls (11 of 26 on 0731) closed with `</tool_calls>`, `</tool_code>`,
 * `</tool_cost>`, `</tool_called`, `</tool_cal>`… and prod had leaked 4 such raw tags. Instead
 * of listing closers, a call is read as opener + one balanced JSON object, and *everything after
 * that object is dropped*: the protocol says the call ends the turn, and send.ts already stops
 * streaming at the opener, so this keeps the stored row equal to what reached the chat. Text
 * after a call is junk in practice (a mangled closer, or an invented result like "double
 * checked, it's $0.15").
 */

/** Opening tags accepted as a call. Only `<tool_call>` has been seen; the rest are cheap insurance. */
export const TOOL_CALL_OPENERS = ['<tool_call>', '<tool_calls>', '<tool_code>'] as const;

const OPENER_RE = /<tool_(?:calls?|code)>/i;

/** A parsed tool call from the model's output. */
export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** Where a call starts in a text, and the call itself (null when the JSON after the opener is unusable). */
export interface ToolCallSpan {
  start: number;
  call: ParsedToolCall | null;
}

/** Index just past the balanced JSON object starting at `from` (a `{`), or -1 if it never closes. */
function endOfJsonObject(text: string, from: number): number {
  let depth = 0;
  let inString = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * Finds the first tool-call opener. Returns null when there is none; otherwise its position and
 * the parsed call, or `call: null` when the opener isn't followed by a complete JSON object with
 * a string `name` (truncated or garbled). Either way the text from `start` on is not prose.
 */
export function locateToolCall(text: string): ToolCallSpan | null {
  const m = OPENER_RE.exec(text);
  if (!m) return null;
  const start = m.index;
  const brace = text.indexOf('{', start + m[0].length);
  if (brace === -1 || text.slice(start + m[0].length, brace).trim() !== '') return { start, call: null };
  const end = endOfJsonObject(text, brace);
  if (end === -1) return { start, call: null };
  try {
    const parsed = JSON.parse(text.slice(brace, end)) as { name?: unknown; arguments?: unknown };
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.name !== 'string') {
      return { start, call: null };
    }
    const args =
      typeof parsed.arguments === 'object' && parsed.arguments !== null
        ? (parsed.arguments as Record<string, unknown>)
        : {};
    return { start, call: { name: parsed.name, arguments: args } };
  } catch {
    return { start, call: null };
  }
}

/** The first well-formed tool call in the model's output, or null. */
export function parseToolCall(text: string): ParsedToolCall | null {
  return locateToolCall(text)?.call ?? null;
}

/**
 * The prose before the first tool-call opener (valid or not), trimmed; the whole text, trimmed, when
 * there's no opener. A garbled call is cut too: a raw tag must never reach the chat.
 */
export function stripToolCalls(text: string): string {
  const span = locateToolCall(text);
  return (span ? text.slice(0, span.start) : text).trim();
}
