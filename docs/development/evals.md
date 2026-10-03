# Evaluating behaviour changes

Prompt text is most of this app's logic, and the comments in `src/prompts/index.ts` record the
measurements behind each wording. The rule is: **no prompt, cue, persona or tic change ships
without replay evidence**. That means regenerating real historical turns through the production
prompt path, with and without the change.

## Typecheck

```sh
npx tsc --noEmit -p .
```

This covers `src/` only. `tsconfig.json` includes `src/**/*.ts`, so **`scripts/` is not
typechecked**. The scripts run through tsx, which strips types without checking them.

## Getting a snapshot

Every harness writes to the DB it's given, so always work on a scratch copy:

1. On the server, take a consistent copy with the SQLite backup API (see
   [deploy.md § Database](../operations/deploy.md#database)), e.g.
   `.backup('/tmp/snapshot.db')` via better-sqlite3.
2. `scp` it to your machine. A backup is a single consistent file. If you copy the raw DB file
   instead, take the `-wal` and `-shm` files with it.
3. Point `DB_PATH` at a **copy** of that file. **Never run a harness on `data/userbot.db`**.
   `scripts/replay.ts` refuses to.

Before reusing a scratch DB, delete its stale `-wal`/`-shm` files, because an old WAL replays
over a fresh copy.

## The replay harness: `scripts/replay.ts`

This is the general-purpose tool. For each given assistant message id it rewinds the DB to the
moment before that reply and rebuilds exactly what prod would have sent: the window, the system
prompt (rendered with the historical time as "now"), and the tail cue with the gap clause and the
avoid-list. Then it samples the model.

- **Rewind.** `cue-test.ts:atPosition` flags every row from that id onward as `deleted`, and
  restores those rows afterwards.
- **No future leakage.** `hideFuture` hides summaries and facts **created** after the moment.
  Facts edited or deleted later are not restored to their old state.

| Env | Meaning |
|:--|:--|
| `DB_PATH` | **required.** A scratch copy of a prod snapshot; the harness writes to it |
| `IDS` | Comma-separated assistant message ids to regenerate |
| `MODELS` | OpenRouter slugs, comma-separated. **Repeat a slug to draw several samples** (`a,a,a` = 3 samples). Default: `OPENROUTER_MODEL` |
| `OUT` | JSONL output, appended (default `replay.jsonl`). One line per sample: `pos`, `model`, `content`, `provider`, `finish`, `ttftMs`, `totalMs`, token counts, `cost`, `userMessage`, `accepted` |
| `PERSONA_FILE` | Optional persona text, inserted as the newest `persona_versions` row before the app modules load |
| `NOGAP=1` | Ablation: drop the gap heads-up |
| `NOMEM=1` | Ablation: drop the `# Memory` block |
| `NOAVOID=1` | Ablation: drop the tic avoid-list |
| `DRY=1` | No API calls. Prints prompt sizes and writes `prompt-<id>.txt` next to `OUT` |

```sh
DB_PATH=/tmp/arm-a.db IDS=4364,4401 MODELS=deepseek/deepseek-v4-flash,deepseek/deepseek-v4-flash,deepseek/deepseek-v4-flash \
  OUT=arm-a.jsonl npx tsx scripts/replay.ts
```

(On Windows PowerShell, set the variables with `$env:DB_PATH='…'` first.)

- Requests go straight to OpenRouter with `reasoning` off and the prod sampling knobs from `.env`.
  The prod model keeps the prod provider order; other models are routed latency-first.
- Set the sampling env vars to match prod, or the numbers describe a model nobody ships.
- `PERSONA_FILE` rows are inserted into the scratch DB with `source = 'bench'`. That's harmless
  on a scratch copy, which is one more reason to never point it at a real DB.

### Never run two arms concurrently on the same DB file

`atPosition` flips `deleted` flags in place. Two runs sharing one file corrupt each other's
windows (and can leave rows hidden if one is killed). Use one DB copy per arm, or run arms
sequentially.

### Cost

A 19-turn × 3-sample arm on the default chat model costs cents. `cost` is recorded per line, so
sum the JSONL to check.

## Workflow: ablate first, then add rules

When a behaviour is unwanted (reproach after a long gap, a recurring phrase, fixation on a
memory), first find **which prompt source drives it** before writing any new rule:

1. Collect the real turns where it happened (operator notes in `message_revisions` help;
   `cue-test.ts:notedPositions(re)` finds noted turns, `untouchedPositions()` gives a control
   set of turns that were left alone).
2. Replay them as a control, then with each candidate source removed (`NOGAP`, `NOMEM`,
   `NOAVOID`, a `PERSONA_FILE` without a given sentence, or a scrub change). A source whose
   removal kills the behaviour is the cause.
3. Fix it at the source (reword the clause, launder the examples), and only then consider an
   added prohibition. Several measured prohibitions backfired by priming or by creating
   fourth-wall comments; see the comments on `scheduleClause` and `gapHeadsUpClause`.
4. Re-run the fix against both the flagged set and the untouched control set. A change that fixes
   flagged turns and degrades untouched ones is a regression.

Absolute rates from replays are not live rates. The replayed window contains curated history
(the operator kept the good replies), so only the **control-vs-variant delta** means anything,
and the control must be measured in the same run.

## Blind judging

When the metric is a judgment ("which reply is better"), judge blind:

- generate both arms per turn;
- **shuffle** which side is A and which is B per round;
- keep the **key** (which arm is which) in a file the judging UI never reads;
- unblind only after all votes are in.

The earlier reasoning on/off study used this pattern: a generator wrote both variants per turn, a
small local judge page served `rounds.json` with the key stripped and recorded votes (A / B / tie /
both bad) to `votes.json` resumably, and a report script joined the votes back to the hidden key.
Those files are archived in the git-ignored `.scratch/reasoning-ab/`, so reuse the pattern rather
than expecting them in a fresh clone.

## Older experiment scripts

These predate `replay.ts`. They import the shared harness `scripts/cue-test.ts` (positions,
`atPosition`, arms, scoring) or copy its approach, and write raw output (`.jsonl`, `.md`
reports) into **`.scratch/rejections/runs/`** (gitignored). Most run in stages
(`inspect`/`dry` first, which make no API calls). Each header documents its stages and results.

| Script | What it tested |
|:--|:--|
| `cue-test.ts` | Shared A/B harness library: replay positions, `atPosition` rewind, arms, echo/similarity/sentence metrics, reports |
| `exp-clock.ts` | Moving the clock from the technical layer to the tail cue (time-ambiguous probes, LLM time judge) |
| `exp-echo.ts` | Anti-echo / no-preamble wording for the reply cue (8 wordings, ~1k generations) |
| `exp-facts.ts` | Whether rewording or moving the facts-block header stops fact contradictions (synthetic probes) |
| `exp-merge-proactive.ts` | The merged proactive bracket: recent-openers list + shape roll + anti-contradiction, with a leak check |
| `exp-merge-reactive.ts` | The merged reactive cue (anti-echo + clock on the length rule) and the reroll angle on top |
| `exp-openers.ts` | A recent-openers block in the system prompt (a regression) vs. the same list in the tail cue (shipped) |
| `exp-persona.ts` | Whether a persona sentence primes the body-lament behaviour it forbids |
| `exp-reroll.ts` | Reroll angle cue vs. the plain reroll (spree diversity) |
| `exp-shape.ts` | Rolling one opener shape in code instead of offering a menu |
| `schedule-cue-test.ts` | Schedule-awareness and gap clauses on real turns. It **hard-deletes** newer rows, so use a disposable copy |
| `diary-test.ts` | Diary prompt assembly and generation against a snapshot (writes `diary_posts`) |
| `reroll-test.ts` | Regression check for context-aware `/reroll` of reach-outs (seeds and deletes rows; `LIVE=1` generates) |
| `replay.ts` | The current general-purpose replay bench (above) |

Several older scripts pin `OPENROUTER_PROVIDER_ORDER` on the command line in their headers.
Check a header before running a script.
