import { md, type InputText } from '@mtcute/node';

/**
 * Models emit standard-Markdown italics as `*text*`, but mtcute's `md` parser uses
 * `__text__` for italic (single `*` is rendered literally). Rewrite single-asterisk
 * emphasis to `__…__`, leaving `**bold**` untouched: the `(?<!\*)…(?!\*)` guards on
 * each delimiter reject any `*` adjacent to another `*`, and requiring non-whitespace
 * at both edges avoids eating bullets (`* item`) and multiplication (`2 * 3`).
 */
function normalizeEmphasis(text: string): string {
  return text.replace(/(?<!\*)\*(?!\s)(?!\*)([^*\n]+?)(?<!\s)\*(?!\*)/g, '__$1__');
}

/**
 * Parses the model's output as Markdown (bold, code, links, etc.) into Telegram
 * entities. Falls back to plain text if the Markdown is malformed.
 */
export function renderMarkdown(text: string): InputText {
  try {
    return md(normalizeEmphasis(text));
  } catch {
    return text;
  }
}
