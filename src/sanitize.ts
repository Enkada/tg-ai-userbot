/**
 * "Anti-AI" typographic cleanup, in one place.
 *
 * Language models reach for typesetter's punctuation that no one actually types into a chat box:
 * em-dashes, smart quotes, the single-glyph ellipsis, non-breaking spaces. Left alone they're an
 * instant tell. {@link sanitize} rewrites them to their plain-keyboard equivalents and is applied
 * at every text boundary — DB write ({@link saveMessage}/{@link updateMessageContent}), window
 * build ({@link getWindow}/{@link getDayMessages}), and outgoing render ({@link renderMarkdown}) —
 * so what the user reads, what is stored, and what the model is shown of its own history all read
 * like a person typed them.
 *
 * It MUST stay idempotent: the same text is cleaned more than once (a reply is sanitized when sent,
 * again when saved, and again when later rebuilt into the window), so `sanitize(sanitize(x))` has
 * to equal `sanitize(x)`. Every replacement's output lies outside its own match class (a hyphen is
 * not in the dash class, a straight quote not in the smart-quote class), so a second pass is a no-op.
 */
export function sanitize(text: string): string {
  return (
    text
      // Em-dash, horizontal bar, and en-dash → a spaced hyphen, the way people write an aside in a
      // chat. Spaces/tabs already around the dash are absorbed, so `a—b`, `a —b`, and `a — b` all
      // become `a - b` — never `a-b` (which would fuse the words) and never a double space.
      .replace(/[ \t]*[—―–][ \t]*/g, ' - ')
      // Smart double/single quotes → straight quotes (also fixes the model's `don’t` → `don't`).
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      // Single-glyph ellipsis → three dots.
      .replace(/…/g, '...')
      // A period the model tucked inside a closing quote (American typesetting style). When a
      // terminator already follows the quote (`world.".`), the inner period is redundant — drop
      // it. Otherwise move it outside (`talks."` → `talks".`) so the chunker sees a confirmed
      // boundary and can split there and strip the dot. Single periods only: a quoted trail-off
      // (`"i mean..."`) is expressive and stays put — the `(?<!\.)` guard skips ellipsis runs.
      // Neither output has a period left before a quote, so a second pass is a no-op.
      .replace(/(?<!\.)\.(["'])(?=[.?!])/g, '$1')
      .replace(/(?<!\.)\.(["'])/g, '$1.')
      // Non-breaking and narrow no-break spaces → an ordinary space.
      .replace(/[  ]/g, ' ')
      // The dash rule can leave a stray space at a line's end (a dash that sat before a newline);
      // drop trailing whitespace per line without collapsing the blank lines between paragraphs.
      .replace(/[ \t]+$/gm, '')
  );
}
