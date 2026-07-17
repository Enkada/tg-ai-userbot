import { md, type InputText } from '@mtcute/node';
import { sanitize } from './sanitize.js';

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
 * User-facing timestamp in 24-hour form — "Jul 17, 19:02", or "Jul 17, 2026, 19:02" with
 * `year: true`. Every date+time the app displays goes through here so nothing renders AM/PM.
 */
export function formatDateTime(ms: number, opts: { year?: boolean } = {}): string {
  return new Date(ms).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(opts.year ? { year: 'numeric' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Parses the model's output as Markdown (bold, code, links, etc.) into Telegram
 * entities. Falls back to plain text if the Markdown is malformed.
 *
 * Runs the {@link sanitize} "anti-AI" pass first, so every bubble that reaches the chat — and
 * the plain-text fallback — is free of em-dashes and smart quotes. This is the send-side seam of
 * the cleanup (the DB and window seams live in `memory.ts`); the pass is idempotent, so a reply
 * that was also sanitized at save time is unchanged here.
 */
export function renderMarkdown(text: string): InputText {
  const clean = sanitize(text);
  try {
    return md(normalizeEmphasis(clean));
  } catch {
    return clean;
  }
}
