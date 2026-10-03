# Deploy

Host-specific details (address, paths, proxy, panel) live in
[`docs/private/ops/prod-server.md`](../private/ops/prod-server.md), which is private and local
only (gitignored). This page is the generic procedure.

## How prod runs

pm2 runs `ecosystem.config.cjs`: `node --import tsx src/index.ts`, with `cwd` set to the repo,
`autorestart`, `max_restarts: 10`, and `NODE_ENV=production`. The process is named
`tg-ai-userbot`.

The **TypeScript source runs directly**. There is no build artifact. `package.json` still has
`build` (`tsc`) and `serve` (`node dist/index.js`), but **don't reintroduce `dist/` in
production**: a past deploy pulled new `src/` while pm2 kept running stale compiled JS, and a
feature silently never fired. With no build step, there is nothing to drift.

The prod host is a VDS where Telegram's data centres are blocked, so MTProto goes through
`PROXY_URL`. Some API edges also block the host's IP, so OpenRouter and Tavily calls go through
the same proxy when it's an `http(s)://` URL (`src/proxyAgent.ts`).

## Procedure

1. **Locally:** commit and push to `master`.
2. **On the server**, in the repo:
   ```sh
   git status            # prompts may have been tuned in place on prod - check before pulling
   git pull --ff-only
   ```
   If `git status` shows local edits (typically `prompts/**`), commit them back or reconcile
   them first. Never discard them blindly.
3. **Only if dependencies changed** (`package.json` / `pnpm-lock.yaml`):
   ```sh
   pnpm install --frozen-lockfile
   ```
4. **Migrations** apply automatically at startup (`runMigrations()`). A new migration only
   needs the commit of `drizzle/` (generated locally with `pnpm db:generate`).
5. **Restart:**
   ```sh
   pm2 restart tg-ai-userbot --update-env
   ```
6. **Verify:**
   ```sh
   pm2 logs tg-ai-userbot --lines 50
   ```
   Look for `Logged in as …` and `UserBot is online and listening for messages.`, plus the
   expected feature lines (e.g. `Long-term memory ON`, `Long-term facts ON`). Prompt-file or
   `schedule.txt` errors show up here as a startup failure.

## Editing the server `.env`

The server's `.env` is different from any local one: it contains `PROXY_URL`, prod keys, and
prod-only settings such as `CHAT_COMMANDS=none`.

- **Back it up first**, e.g. `cp .env .env.bak-$(date +%Y%m%d-%H%M)`.
- **Edit only the key you're changing, in place.** Never copy a local `.env` over it.
- **Restart with `--update-env`.**
- **Keep app keys out of the `env` block in `ecosystem.config.cjs`.** dotenv does not override
  variables already in `process.env`, so a key set there would silently shadow `.env`. That
  block only holds `NODE_ENV`.

## Database

SQLite in WAL mode at `DB_PATH` (default `data/userbot.db`).

- **Back up before any data change** (manual SQL, purges, persona rows). Use the SQLite backup
  API, not a plain `cp` of a live WAL database, e.g. with the bundled better-sqlite3:
  ```sh
  node -e "require('better-sqlite3')('data/userbot.db').backup('data/userbot-backup.db').then(() => console.log('ok'))"
  ```
- After purging rows, run `VACUUM` to reclaim space.
- Rows are normally soft-deleted (`deleted = 1`). Hard deletes must cascade by hand:
  `attachments`, `searches`, `message_revisions` and `photo_gens` reference `messages.id`, and
  foreign keys are enforced.

## Persona changes

The persona is the newest row of `persona_versions`; `prompts/system/persona.default.txt` is only
the first-run seed. With chat commands off on prod, `/persona set` isn't available, so a change
is shipped as **a new `persona_versions` row with `source = 'claude'`**. The column has no CHECK
constraint, though the TypeScript type only lists `migrated` / `set` / `undo` / `default`.

- The persona is cached in memory at startup (`initPersona`), so **restart after inserting**.
- Ship a persona change only with replay evidence: before/after generations on real turns
  ([evals.md](../development/evals.md)).
- Rolling back means appending the previous text as a new row. Never delete rows; the table is
  the change journal.

## One account, one process

A Telegram account must not be logged in by the bot locally and on prod at the same time. Both
processes would receive and answer the same messages, and both would write to their own
databases. Stop one before starting the other. For local work against prod data, use a DB
snapshot and the replay harness rather than a live session.
