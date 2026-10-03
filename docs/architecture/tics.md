# Verbal-tic control (`src/tics.ts`)

## Why

The chat model imitates its own recent replies. A phrase she used in the last few turns makes the
next reply more likely to use it too (measured at about 1.9× for `" - "` asides and `, huh` tags,
and up to 5.5× for hearts). A ban stated in chat or in the persona fades within 50-200 replies,
because the window keeps showing her the examples. Rules at the top of the prompt lose to ~30 of
her own replies below them.

So the fix works on what she is **shown**, plus a small amount on what she **sends**, at three
seams. The catalog behind the lists was mined from her stored replies. The text of the replies in
the DB and in Telegram is never rewritten.

## Seam 1: window laundering, `scrubTics(text, prevUser)`

Runs on every **assistant** turn when the window is built. It's called from
`getWindowDetailed` in `src/memory.ts`, after `stripModelBrackets`. `prevUser` is the user message
right before that reply (empty for an opener with no user turn in front). It's model input only;
the DB and chat keep the original. Steps, in order:

1. **Reproach.** `REPROACH` removes whole sentences of absence guilt aimed at him ("you ghosted
   me", "remember i exist", "left me on read", …). It runs first and is the **only** step allowed
   to empty a reply. If nothing is left, `scrubTics` returns `''` and `getWindowDetailed` drops
   the turn entirely (unless it carries captions or searches).
2. **Echo opener.** `ECHO_OPENER` matches a leading fragment: a quoted phrase, or a short clause
   ending in `.?!` or `" - "`, optionally followed by `, huh`. It's cut only if `isEcho` agrees:
   - it isn't a reciprocal greeting ("morning", "love you too", "thanks", …);
   - his previous message didn't end in `?` (a short opener built from his words is then her
     *answer*, and cutting it would rewrite history so she never answered);
   - the fragment has 1-8 content words (stopwords removed, light stemming), and at least 60% of
     them appear in his previous message;
   - at least 3 tokens remain after the cut.
3. **`SCRUB_STEPS`**, in order:
   - a leading `<restatement>, huh.` sentence;
   - any `, huh`;
   - sentence-initial "fair / fair enough / fair point";
   - trailing ", fair enough";
   - sentence-initial "exactly";
   - "actually" and "honestly" as fillers;
   - the sneer tail of "X or just Y?" questions;
   - short standalone reassurance ("i'm still here", "not going anywhere");
   - heart emoji.

   Each step's result is kept only if at least 2 words remain, and `tidy()` re-glues the
   punctuation after every removal.
4. **Dash aside.** `DASH_ASIDE` turns `word - word` into `word, word`, between letters or quotes
   on one line only (never `5 - 3`, never a `- item` list line). It's skipped for replies
   containing a code fence.

Where it applies: the live window, which also covers the diary's recent-conversation block,
since that's built from the window. It does **not** apply to the day transcripts that feed the
summary and facts passes (`getDayMessages`), or to `getRecentTexts`.

## Seam 2: outgoing guard, `stripHardTics(text)`

Removes `, huh` in place (`two days left, huh?` → `two days left?`). It only handles tics the user
explicitly complained about **and** that can be cut locally. The cut can't empty a reply or move a
sentence boundary, so running it per bubble while streaming and once over the whole text on save
gives the same result, and the stored row matches the chat. It's idempotent.

Hearts are **not** stripped here: doing so could empty a heart-only reply or break "i ❤️ this".
They're handled only by the window scrub.

Wired at:

- `src/send.ts`: `sendClean` (every streamed bubble) and the `finalize` fallback path;
- `src/tools.ts`: `finalizeReply` (the text that gets saved; also used for diary posts and
  partial replies);
- `src/selfie.ts`: `cleanLine`, which covers the ack, caption and failure lines.

Assistant text only. It never touches the user's messages.

## Seam 3: avoid-list, `avoidListClause(herRecent, hisRecent)`

A tail-cue clause, `Lately you've leaned on: …. Don't use any of them in this reply.`, built by
`avoidListFor(chatId)` in `src/generate.ts`.

- **Input.** `getRecentTexts`: her last 30 replies and his last 12 messages, **raw as stored**
  (not laundered). The list measures what she actually produces.
- **Items.** `AVOID` is a curated list of label + regex + `min` count over the 30 replies. The
  threshold is 2 for things he complained about. Otherwise it's about 2.5× the item's earlier
  baseline, with a minimum of 3; common items sit higher (`"actually"` 7, the `" - "` aside 9).
- **Word-like items** (`wordLike: true`: "classic", "rot", "grind", "boring", "guilt", "void",
  "quiet") are skipped when his recent messages contain the word. Mirroring his topic isn't a tic.
- Hits are ranked by `count / min`, and at most **5** are listed. With no hits, the clause is
  empty and nothing is added.
- **Position.** After the schedule clause and before the reroll angle and the selfie sentence
  (see [overview.md § Tail cue](overview.md#7-tail-cue-srcgeneratets-withreplycue)).
- **Coverage.** It applies to reactive replies through `persistedSearchStrategy`. It isn't used
  by reach-outs, `/continue`, the selfie ack/caption lines or the promise gate (those don't go
  through `withReplyCue`), nor by the reactive `/reroll` path, which passes only the angle and the
  gap.

## Adding a new tic safely

1. **Measure first.** Count it over her stored replies and check that it's actually rising, not
   just present. Check whether it's contagious (does its presence in the last few replies predict
   the next one?).
2. **Avoid-list entry.** This is the cheapest option and touches nothing stored. Add an `AVOID`
   item with a threshold relative to its baseline. Mark it `wordLike` if it's an ordinary word he
   might use himself.
3. **Scrub step**, only if the tic can be removed **locally and grammatically**: the sentence
   must still read correctly without it, and the step must not delete content. Respect the
   "≥ 2 words remain" guard, and never let anything other than the reproach step empty a turn.
   Order matters, since later steps see earlier output.
4. **Test it over history.** Run `scrubTics` over her last few hundred stored replies (with the
   real `prevUser`) and read the diffs; false positives show up immediately. Then replay real
   turns with `scripts/replay.ts` (and `NOAVOID=1` as a control for avoid-list changes) to check
   the generated replies, not only the regex. See [evals.md](../development/evals.md).
5. **Outgoing guard**, only for tics the user explicitly asked to be gone, and only if the cut
   is local, can't empty a reply and is idempotent. Otherwise streamed bubbles and the saved row
   will disagree.
6. **Never apply any of this to user text.** His words are evidence (echo detection, word-like
   skips), not something to clean.
