# Memory

Four layers, from short-term to long-term:

| Layer | What | Where it enters the prompt | Written by |
|:--|:--|:--|:--|
| Window | last 60-79 stored messages, verbatim (cleaned) | chat turns | every message |
| Daily summaries | one first-person diary entry per logical day | `# Memory` block (system prompt part 5) | `src/summary.ts`, nightly |
| Facts | durable third-person facts about the user | `# About <user>` block (part 4) | `src/facts.ts`, nightly; `/facts` |
| Diary | posts to a private channel | never enters the chat prompt | `src/diary.ts` (disabled) |

All of them are keyed by chat id (the DM peer id). Deletion is soft everywhere: rows get a
`deleted` flag, and `/nuke` flags messages, summaries and facts for the chat.

## Window

See [overview.md § Context window](overview.md#6-context-window-srcmemoryts-getwindowdetailed)
for the full build. In short: `windowSize()` keeps 60-79 rows (snapping back every 20 for KV-cache
reuse). Photo captions and search results are rendered as bracketed records. Her own turns are
bracket-stripped and tic-laundered, and selfie rows expand into tool-call / `[photo sent]` /
caption turns. The window carries no timestamps. Staleness reaches the model through the gap
heads-up in the tail cue instead.

`/delete`, `/trim`, `/reroll` and `/update` act on stored rows. Overwritten or deleted content is
snapshotted into `message_revisions` first. That table is a debugging corpus and **no prompt
ever reads it**.

## Daily summaries (`src/summary.ts`)

- **Logical day.** `dayStart()` runs from `SUMMARY_CUTOFF_HOUR` (default 03:00) to the same hour
  the next day, in the process timezone (`TIMEZONE`), so a session past midnight stays in one
  day. The arithmetic uses local `Date` fields and is DST-safe.
- **Scheduler.** A plain interval (`SUMMARY_TICK_MS`, first tick 10 s after start). It's not run
  through the chat queue, because it only reads completed past days. `summary_state.last_done_start`
  is a cursor: on first contact it's stamped to the previous day (history from before the feature
  was enabled is **never back-filled**), then the scheduler walks forward over every day that has
  fully ended, catching up after downtime.
- **Threshold.** A day is summarized only if it has more than `SUMMARY_MIN_MESSAGES` (10)
  non-deleted messages. Shorter days advance the cursor without a summary.
- **Pass.** The day's transcript comes from `getDayMessages()`, which renders the same records as
  the window, bracket-strips her turns, and narrates a selfie as `[<char> sent a photo: …]`. Each
  line is labeled with the real names. The system prompt is `prompts/passes/summary.txt` (tags
  substituted), and the call is `summarize()` on `SUMMARY_MODEL` through OpenRouter at low
  temperature with reasoning off.
- **Output shape.** Four labeled lines in **her first-person voice**: `Headline:`, `Happened:`,
  `Mood:`, `Follow-ups:`. A response missing any label throws, and the day is retried on the
  next tick (the cursor doesn't move).
- **Injection.** `renderMemoryBlock()` takes the newest `SUMMARY_MAX_KEPT` (7) non-deleted
  level-0 rows, oldest first, each under a `[Weekday, Month D]` label, below a header that frames
  them as her own memories ("never quote them, list them, or mention having notes").
- **Withheld from openers.** Reach-outs (and `/reroll` of a reach-out) render the system prompt
  with `includeMemory: false`. With no user message to anchor on, the model fixated on the most
  salient summary. `/continue` and the diary keep the block. Facts are never withheld.
- **Requirements.** `SUMMARY_ENABLED=true` and `OPENROUTER_API_KEY`.

`summaries.level` exists for weekly/monthly roll-ups; only level 0 is written.

## Facts (`src/facts.ts`)

- **What.** Durable facts about the user (one short third-person sentence each) in a fixed
  category set: `work`, `home`, `people`, `health`, `likes`, `backstory`, `us`, `other`
  (`FACT_CATEGORIES` in `src/db/schema.ts`).
- **Diff pass.** One call per completed logical day, same days and cutoff as summaries, with its
  own cursor (`facts_state`) so the two jobs fail and retry independently. First tick is 25 s
  after start. The threshold is lower: more than `FACTS_MIN_MESSAGES` (3).
  - The user message (`factsPassUserMessage`) carries the current fact list as
    `[id] (category, learned YYYY-MM-DD) content`, then the day's transcript with `[HH:MM]`
    labels.
  - The model (`FACTS_MODEL`, reasoning off) answers with JSON `{"ops": [...]}` containing
    `add` / `edit` / `delete`, each with a `reason`.
- **Guards.** `parseOps` tolerates a code fence and preamble, but rejects the whole batch on any
  structural error (bad op, bad category, missing content/id). `applyOps` drops individual edits
  or deletes that name unknown ids, and edits whose content is unchanged. Every applied or
  dropped op is logged with its reason; the log is the only audit trail.
- **Injection.** `renderFactsBlock()` puts **every** live fact into the system prompt on
  **every** turn, grouped under capitalized category headers in fixed order, without ids or
  dates, below a "background knowledge you simply carry" header. There is no retrieval step.
- **Curation.** `/facts` (`/f`) sends the list as a `.md` file with ids and dates, and supports
  `add` / `set` / `delete`. `/prompt f` shows the block exactly as the model sees it.
- **Requirements.** `FACTS_ENABLED=true` and `OPENROUTER_API_KEY`.

## Diary (`src/diary.ts`), disabled

Posts to a private Telegram channel (`DIARY_CHANNEL_ID`). It's a one-way surface: nothing posted
there re-enters the chat, the summaries or the facts.

- **Plan.** Once per calendar day it rolls 1-3 posts (45/40/15%) at random times inside
  `DIARY_WINDOW_START`-`DIARY_WINDOW_END`, at least `DIARY_MIN_GAP_MINUTES` apart, and stores the
  plan in the singleton `diary_state` row so a restart resumes it. A slot missed by more than
  `DIARY_GRACE_MINUTES` is skipped.
- **Prompt.** The system prompt is persona → a `Now:` line → facts → memory → (optionally) the
  last `DIARY_TRANSCRIPT_HOURS`/`DIARY_TRANSCRIPT_MAX` messages as a flattened transcript →
  her last `DIARY_RECENT_ENTRIES` posts under a no-reuse header → `prompts/passes/diary.txt`.
  The user turn is a director cue with a rolled length, mood register, focus, and
  `DIARY_SPARKS` optional spark words from `diary-words.txt`.
- **Focus.** Only `DIARY_ABOUT_CHANCE` (30%) of entries may involve the user. The rest get an
  explicit exclusion line *and* no transcript.
- **Model.** The chat model through OpenRouter (`diaryEntry`), capped at `DIARY_MAX_TOKENS`.
- **Records.** Posts are stored in `diary_posts` with the rolled cue (for debugging only).
- **Requirements.** `DIARY_ENABLED=true`, `DIARY_CHANNEL_ID`, `OPENROUTER_API_KEY` and a
  non-empty whitelist (the first whitelisted chat supplies context). `/diary` lists postable
  channels when no id is set.

## Tables involved (`src/db/schema.ts`)

| Table | Role |
|:--|:--|
| `messages` | every user message and assistant reply. `tg_message_ids` (JSON array of bubble ids), `provider`, `model`, `kind` (`reply` / `reachout_morning` / `reachout_lull` / `reachout_ignored`), `proactive`, `deleted`, `created_at` |
| `attachments` | photo captions per message (user photos), or the selfie prose (her photos) |
| `searches` | web-search query + distilled result per triggering user message |
| `message_revisions` | pre-action snapshots from `/reroll`, `/update`, `/trim`, `/delete` (never read by prompts) |
| `summaries` | daily summaries (`level` 0), keyed by chat + period start |
| `summary_state` | summary cursor + the cached user display name (also used for photo records and transcripts) |
| `facts` | facts with category, created/updated times |
| `facts_state` | facts cursor |
| `diary_posts`, `diary_state` | diary entries and the day plan |
| `proactive_state` | reach-out schedule per chat |
| `persona_versions` | append-only persona history; the newest row is active |
| `settings` | singleton: character name, selfie upscale |
| `photo_gens` | every selfie attempt (prose, tags, seed, RunPod job id, timings, file path) |
| `command_debris` | panel / file / command messages awaiting deletion |

## Known limitations

- The facts block is injected whole on every turn, roughly 2k tokens at the current fact count
  (`/dump` shows the exact share). It grows linearly with no cap.
- Facts have no expiry, no source links (the diff pass's `reason` is only logged, not stored) and
  no verification step. A wrong fact stays until the diff pass or `/facts` removes it, and
  removal of resolved temporary facts depends on the pass prompt following its own rule.
- Summaries are written in her first-person voice and include a `Mood:` line, so the memory block
  carries interpretation, not just events. Nothing edits or corrects a stored summary (there is
  no command for it).
- "Newest 7 summaries" counts summaries, not days. Days at or below the message threshold produce
  none, so with sparse usage the block can span weeks.
- Day transcripts for summaries and facts are bracket-stripped but not tic-laundered. They see
  her replies as sent.
- There's no retrieval: anything older than the window survives only in whatever the summaries
  and facts happened to keep. Older summaries simply fall out of the block, because the
  roll-up levels aren't implemented.

A rebuild of the long-term memory is planned; see [docs/design/roadmap.md](../design/roadmap.md).
