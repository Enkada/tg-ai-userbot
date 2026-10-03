# Roadmap

Technical roadmap as of 2026-10-03. Done items move to the "Shipped" list with their commit.

## Shipped

- **2026-10-03 (`f6759b0`)**
  - Verbal-tic control (`src/tics.ts`): window laundering, outgoing ", huh" guard, dynamic avoid-list
    in the tail cue.
  - Gap heads-up says "an earlier day" from 24 h instead of a number of days.
  - Four reroll angles removed: "say what you want", "react to how he sounds", "ask instead of
    answering", "get filthy".
  - `CHAT_COMMANDS` flag; prod runs `none`.
  - Persona rewrite (friend framing, honest AI, no guilt mechanics), deployed as a DB row.

## Next

1. **Memory rebuild: verifiable memory.**
   - Facts carry a source quote and message id; a verifier pass checks each new or edited fact
     against the transcript before it's stored. Facts get `as_of`, expiry and supersede handling, plus
     a sensitivity flag.
   - A small always-on core profile (~300 tokens instead of ~2.2k for the whole fact list) plus
     retrieval for the rest: FTS5 and embeddings over messages and summaries, and a `recall` tool she
     can call.
   - Summaries in a neutral third-person voice: drop the first-person "Mood" line and the "Follow-ups"
     nag list in favour of resolvable open threads; weekly roll-ups (the `summaries.level` column is
     reserved); relevance-based retrieval instead of "always the newest 7".
   - A relationship-state record (current agreement, intimacy, which habits she may raise) that the
     persona reads instead of hard-coded text.
   - Metrics and a fixed test set for memory quality: accuracy, staleness, invented facts.
2. **Web panel overhaul**: status, logs, prompt and memory inspection, persona history, eval runs.
   Everything that left the chat.
3. **Persona iteration** with replay evals once memory is clean.
4. **Classifier experiment (TypeSafe Jev or an LLM judge)**: classify the incoming message (needs an
   answer vs banter, mood) to steer reply shape, and judge drafts for sycophancy and deflection.
   Adopt only if it beats a plain LLM judge or regex on the rejection corpus.
5. **Model re-bench** after 1–3 (candidates: Gemini 3.8 Flash, DeepSeek V4 Flash 0731, Claude Sonnet
   5.5), blind, with the new persona and memory.
6. **Provider routing:** cheaper and more reliable upstream order for V4 Flash.
7. **Ironman review** (around 2026-10-17): keep in-chat commands off, or bring back a plain `/r`, or
   a `/r` that feeds the user's note into the retry.

## Hygiene backlog

- Persist the bubbles actually sent instead of the raw model text (`src/index.ts` save path), so any
  future send-side transform can't desync the DB.
- Clock (`Now:` line) in proactive and `/continue` director cues.
- Treat SSE `error` payloads and `finish_reason: length` as failures; retry/fallback before the
  first token; quarantine nightly days that keep failing (poison-pill days block later days).
- Fix Gemma-era defaults (`DEFAULT_PROVIDER_ORDER`, default model) and stale comments.
- A generation log table (cue, angle, params, provider, TTFT, tokens, cost, finish reason).
- Unit tests for the pure modules (`SentenceSplitter`, `sanitize`, `tics`, schedule parsing,
  `parseToolCall`, `parseOps`).
- Dead code: `getLlmStatus`, `getLastMessageMeta`, `proactive_state.followupDueAt`,
  `evaluateChat`, `isSelfieAvailable` vs `isSelfieConfigured`, the `build`/`serve` scripts.
- Add `scripts/` to typechecking.
- `/reroll` doesn't pass the tic avoid-list into its tail cue, and isn't registered as
  interruptible, so `/stop` can't abort it. Dormant while `CHAT_COMMANDS=none`.
- Stale references: `src/login.ts` (npm commands), `src/tools.ts` ("appended in prompt.ts"), old
  prompt paths in comments (`prompts/diary.txt`, `prompts/facts.txt`, …), the daily-selfie-cap
  comment in `src/prompts/render.ts`, `"main": "dist/index.js"` in `package.json`.
- `.env.example` is missing `LLM_TIMEOUT_MS`, `PROACTIVE_RECENT_OPENERS` and the six `TAVILY_*`
  tuning variables.
- Prompt text outside `src/prompts/`: the promise-gate cue in `src/selfie.ts`, the diary moods and
  lengths in `src/diary.ts`.
- Decide whether the summary and facts passes should read tic-laundered transcripts. Today they
  see her replies as sent.
- `scripts/replay.ts` hides facts and summaries created after the replayed moment, but doesn't roll
  back later edits or deletions.

## Parked

- News-based proactive messages: tested, very low hit rate.
- Event-timed follow-ups: the user brings up his own events.
- Proactivity in general: off until she has real input of her own.
- Reasoning mode for chat: blind-tested, null result, slower.
