/**
 * Splits an assistant reply into chat-sized bubbles for "streaming"-style delivery — the
 * way a person fires off several short texts instead of one wall of prose.
 *
 * A bubble boundary is a run of one or more terminators (`.`, `?`, `!`, or a newline)
 * that is *confirmed* by what follows it: the run must contain a newline, OR be followed
 * by whitespace, OR sit at the very end of the text. That confirmation is what stops mid-word
 * punctuation from splitting — `3.14` and `U.S.A` keep their dots because a letter, not a
 * space, follows. Each emitted bubble has its trailing dots stripped (people don't end chat
 * messages with a period) while `?`/`!` are kept, so `"that's sad."` → `"that's sad"` but
 * `"really?!"` survives intact.
 *
 * Fenced code blocks (```…```) are passed through untouched: while inside a fence, newlines
 * and punctuation never split, so a multi-line snippet stays in one bubble.
 *
 * {@link SentenceSplitter} applies these rules incrementally to a live token stream — `push`
 * each delta and it returns whatever bubbles are now complete, holding back any unconfirmed
 * tail (a terminator run at the very end, or a partial ``` fence) until more text arrives;
 * `flush` emits the final remainder. {@link splitMessage} is the one-shot wrapper over it.
 */

/** Characters that can end a bubble. A newline both terminates and forces a split. */
const TERMINATORS = new Set(['.', '?', '!', '\n']);

/** Trims a candidate bubble and strips trailing dots; returns '' if nothing meaningful remains. */
function cleanChunk(raw: string): string {
  // Strip trailing dots (but keep ? and !), then drop any whitespace they exposed.
  return raw.trim().replace(/\.+$/, '').trimEnd();
}

/**
 * Stateful splitter for a live token stream. `push` appends a delta and returns the bubbles
 * that are now fully confirmed, retaining any unconfirmed tail in an internal buffer; `flush`
 * emits whatever remains (end-of-text confirms a trailing terminator run). Feeding the whole
 * reply in one `push` + `flush` is identical to {@link splitMessage}.
 *
 * The retained buffer always begins outside a code fence (we never split inside one, so every
 * emitted boundary sits outside fences), which is why fence state can be recomputed from the
 * buffer start on each push without carrying it across calls.
 */
export class SentenceSplitter {
  private buf = '';

  /** Append `text`; return any bubbles completed by it (possibly none). */
  push(text: string): string[] {
    this.buf += text;
    const out: string[] = [];
    let start = 0; // start of the current (not-yet-emitted) bubble within buf
    let i = 0;
    let inFence = false;

    while (i < this.buf.length) {
      if (this.buf.startsWith('```', i)) {
        inFence = !inFence;
        i += 3;
        continue;
      }
      if (inFence || !TERMINATORS.has(this.buf[i])) {
        i++;
        continue;
      }

      // Extend the maximal run of terminators.
      let j = i;
      let hasNewline = false;
      while (j < this.buf.length && TERMINATORS.has(this.buf[j])) {
        if (this.buf[j] === '\n') hasNewline = true;
        j++;
      }
      // Run reaches the end of what we have — can't confirm the boundary yet (the next push
      // may extend the run or bring the confirming char). Stop and keep it buffered.
      if (j >= this.buf.length) break;

      if (hasNewline || /\s/.test(this.buf[j])) {
        const chunk = cleanChunk(this.buf.slice(start, j));
        if (chunk) out.push(chunk);
        start = j;
      }
      i = j;
    }

    // Retain everything from the last confirmed boundary onward (this still begins outside a
    // fence, so a half-arrived ``` or trailing terminator run is correctly re-examined next push).
    this.buf = this.buf.slice(start);
    return out;
  }

  /** Emit the final remainder (end-of-text confirms any trailing terminator run). */
  flush(): string[] {
    const chunk = cleanChunk(this.buf);
    this.buf = '';
    return chunk ? [chunk] : [];
  }
}

/**
 * Splits a complete `text` into ordered bubbles. Returns `[]` only when the text has no
 * sendable content (e.g. it was nothing but dots/whitespace); callers decide what to do then.
 */
export function splitMessage(text: string): string[] {
  const splitter = new SentenceSplitter();
  return [...splitter.push(text), ...splitter.flush()];
}
