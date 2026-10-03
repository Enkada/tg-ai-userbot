# CLAUDE.md

Working guide for agents in this repo. Read it fully before changing anything.

## What this is

A Telegram **userbot** (MTProto via mtcute, logged in as a real account, not a @BotFather bot) that
runs "Sara": an AI companion for a single whitelisted user, living in their DM. TypeScript ESM, run
straight from source with `tsx`; SQLite via better-sqlite3 + drizzle; LLM via OpenRouter (chat model
`deepseek/deepseek-v4-flash`); pnpm. One user, one production server.

## Start of every session

1. Read `docs/private/decisions/2026-10-03-rebuild.md` if it exists (local only). It's the current
   decisions and roadmap record. Then `docs/README.md` for the public docs map.
2. Check the agent memory notes for anything newer.
3. For anything touching her behaviour, read `docs/design/principles.md` first.

## The repo is public

GitHub `Enkada/tg-ai-userbot` is public. Never commit:
- chat content, quotes, analyses of the conversations, persona texts, or anything personal about the
  user;
- server addresses, ssh targets, passwords, account or endpoint ids, phone numbers, Telegram ids.

That material belongs in `docs/private/` (git-ignored). Commit messages and code comments are public
too: describe behaviour and evidence generically ("return-turn guilt 60% → 30%"), not chat excerpts.
Before committing, check `git status` doesn't include `docs/private/`, `.scratch/`, `data/` or `.env`.

## Where things go

| Path | Purpose | Tracked |
|---|---|---|
| `src/` | the bot | yes |
| `prompts/` | prompt text files (`system/`, `tools/`, `passes/`); `prompts/system/persona.txt` is a legacy seed (ignored) | yes |
| `scripts/` | replay harness (`replay.ts`) and older experiment scripts | yes |
| `docs/` | public docs: architecture, operations, development, design | yes |
| `docs/private/` | personal docs: decisions record, agent reports, analyses, experiment data, persona texts, prod host specifics | **no** |
| `.scratch/` | archive of obsolete material and raw experiment output (`scripts/exp-*.ts` still write to `.scratch/rejections/runs/`) | **no** |
| `data/` | session + SQLite DB | **no** |

New agent reports and analyses go to `docs/private/analysis/<date>/` or
`docs/private/experiments/<date>-<topic>/`, with a line added to `docs/private/README.md`.

## Commands

```bash
pnpm install
pnpm dev                     # tsx watch (local; uses the SAME Telegram account as prod, never run both at once)
pnpm start                   # tsx, no watch
pnpm login                   # one-time interactive MTProto login (PowerShell, not Git Bash)
pnpm db:generate             # drizzle migration after editing src/db/schema.ts (auto-applied at startup)
npx tsc --noEmit -p .        # typecheck (covers src/ only; scripts/ aren't in tsconfig include)
```

## Production ("prod")

"prod", "live server" and "the server" all mean the one VDS. Host specifics (address, paths, proxy,
panel, backups) are in `docs/private/ops/prod-server.md`; the generic procedure is
`docs/operations/deploy.md`. Essentials:
- Prod runs `src/index.ts` via `node --import tsx` under pm2 (`ecosystem.config.cjs`). There's no
  build step; never reintroduce `dist/`.
- Deploy = push → on the server `git status` (prompt files are sometimes tuned there) →
  `git pull --ff-only` → `pnpm install --frozen-lockfile` only if deps changed →
  `pm2 restart tg-ai-userbot --update-env` → check the logs for "online and listening".
- The server `.env` is the source of truth and has server-only keys (`PROXY_URL`). Back it up, edit
  only the keys involved in place, and never copy the local `.env` over it.
- Telegram and some API edges are blocked from the server's IP: all outbound HTTP must go through
  `src/proxyAgent.ts`.
- Back up the DB (sqlite backup API) before any data change. `VACUUM` after deleting anything that
  must really be gone.
- Commit, push and deploy only when the user asks.

## Changing her behaviour

- **Find the cause first.** Ablate the prompt sources (tail cue, `# Memory`, window, persona) with
  `scripts/replay.ts` and report which one drives the behaviour before proposing a fix. Prefer
  removing or laundering inputs over adding instructions.
- **Every prompt, persona or cue change ships with replay evidence:** real turns, a control arm,
  several samples, blind judgment for taste questions. See `docs/development/evals.md`.
- **Never run two replay arms concurrently on the same DB file.** The harness flips `deleted`
  flags in place. Use one scratch copy per arm, and never the real `data/userbot.db`.
- **Persona:** owned by the maintainers, not edited from chat. A change is a new `persona_versions`
  row (source `claude`) inserted on prod, with the eval behind it recorded in `docs/private/`. The
  persona is cached at startup, so it takes effect only after a pm2 restart. Keep it short: identity,
  voice and values, not a list of trigger rules.
- **Tail cue** (`src/prompts/index.ts`, spliced in `src/generate.ts:withReplyCue`): order is
  load-bearing; later clauses win. Each string's doc comment records the measurement behind it; keep
  that convention when editing.
- **Hard rules:** no guilt mechanics (no reproach for absence, no score-keeping, no "never end the
  conversation"); she doesn't claim to suffer; intimacy is never her opening move; every generated
  character is an adult. Details in `docs/design/principles.md`.

## Code conventions

- Comments explain *why*, and for prompt text, the evidence. Match the surrounding density.
- Prompt strings live in `src/prompts/` or `prompts/`, not inline in feature code.
- `sanitize()` must stay idempotent. Any transform on outgoing text must be *local* (like
  `stripHardTics`), so per-bubble streaming and whole-text saving produce the same stored row.
- Window laundering (`scrubTics`, `stripModelBrackets`) changes model input only, never the DB or the
  chat, and never the user's own messages.
- In-chat commands are gated by `CHAT_COMMANDS` (prod: `none`). New operator features go to the web
  panel or scripts, not into the conversation.
