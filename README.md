# tg-ai-userbot

A Telegram **UserBot** built on the MTProto API (via [mtcute](https://mtcute.dev)) — _not_ a @BotFather bot. It logs in as a real user account and will grow into an "AI Companion" (local LLMs / OpenRouter, queue system, memory) in later steps.

## Current features

- Logs in as a user account via MTProto.
- **LLM chat with fallback**: non-command DMs are answered by a local llama.cpp model
  (OpenAI-compatible `/v1/chat/completions`, no streaming). If the local server is offline
  at startup, the bot falls back to [OpenRouter](https://openrouter.ai) (cloud) when an API
  key is configured. The provider is chosen once, at startup.
- **Conversation memory**: every user/AI message is stored in SQLite (Drizzle ORM).
  The model is given a cache-friendly context window (see below).
- **Long-term memory** (opt-in): each conversation day is compressed overnight into a short
  first-person diary entry; the newest few are injected into the system prompt as a `# Memory`
  block, so the character recalls past days beyond the live window (see below).
- Renders **Markdown** in replies (bold, code, links…).
- Shows a live **"typing…"** status while the model generates (refreshed every ~5s).
- Marks incoming messages as **read** on arrival.
- **Commands**: `/help`, `/status` (`/s`), `/openrouter` (`/or`), `/nuke`, `/delete` (`/d`), `/reroll` (`/r`), `/update` (`/u`), `/context` (`/c`), `/prompt` (`/p`), `/persona`, `/dump`.
- **Self-cleaning commands**: a command message is deleted (for both sides) once handled,
  and command output lives in a single reusable **panel** message that each command edits
  in place — swept away as soon as you send your next normal message. The bookkeeping is
  persisted in SQLite, so a restart can't orphan stray output.
- **DMs only**: groups, supergroups and channels are ignored.
- **Whitelist**: only configured Telegram user IDs are served; everyone else is ignored.
- Ignores its own outgoing messages (no feedback loops).

### Commands

| Command           | Description                                                            |
| ----------------- | --------------------------------------------------------------------- |
| `/help`           | List available commands                                               |
| `/status` (`/s`)  | Bot uptime/account + both LLM providers (state, model, vision, which is active) |
| `/openrouter` (`/or`) | OpenRouter config, model context/vision, and free-tier usage/limits (`/key`) |
| `/nuke`           | Erase the whole Telegram chat for both sides (revoke) **and** wipe memory + summaries; asks for `/nuke confirm` above 20 stored messages |
| `/delete` (`/d`)  | Delete the last N messages for both sides — `/d` = 1, `/d N` = N; soft-flags memory like `/nuke` |
| `/reroll` (`/r`)  | Regenerate the last reply (re-runs the model without it) and edits the message in place |
| `/update` (`/u`)  | Replace the last reply with your own text — `/u <new text>`; edits the message in place |
| `/context` (`/c`) | Token usage (system prompt + window) vs. the model's max context, plus window re-anchoring state |
| `/prompt` (`/p`)  | Show the prompt the LLM receives — system prompt + the first 3 and last 3 messages — as a code block |
| `/persona`        | View or edit the persona layer from chat, no restart: `/persona` shows the raw text (`{{tags}}` intact, ready to copy), `set <text>` replaces it, `undo` swaps with the previous version (run twice to redo — handy for A/B), `default` resets to the shipped default |

Single-letter shorthands: `/s`, `/d`, `/r`, `/u`, `/c`, `/p`. `/reroll` and `/update` rewrite the
last reply **in place** — they overwrite that one record instead of appending, so memory and
the Telegram message stay in sync without piling up edits.

Commands keep the chat tidy: the `/command` message itself is deleted (for both sides)
as soon as it's handled, and output is rendered into one reusable **panel** message per
chat — a follow-up command edits the panel in place instead of adding another bubble, and
your next normal (non-command) message sweeps it away entirely. So checking `/context`,
then replying, leaves no trace of either the command or its output. `/dump`'s file (which
can't be an edit) and error notices are tracked the same way and swept with the panel.
The tracked message ids live in SQLite (`command_debris`), so output stranded by a
restart or crash is collected on the next interaction. `/reroll` and `/update` remove the
panel instead of writing to it — their real output is the replaced reply itself.

### Memory & the context window

Messages are stored in SQLite. Rather than a 1-message sliding window (which would
shift the prompt prefix on every message and force llama.cpp to re-evaluate the entire
conversation each time), the window is **anchored and grows from 60 up to 79 messages,
then snaps back to 60** every 20th message. Between snaps the older messages are
byte-identical, so the llama.cpp KV cache is reused — roughly 19 cheap turns per 1 full
recompute. `/nuke` and `/delete` soft-delete via a `deleted` flag (nothing is physically
removed).

Before the window is sent to the model, **consecutive messages from the same role are
merged into one** (their text joined by a blank line). Chat templates assume strictly
alternating user/assistant turns, so two `user` (or two `assistant`) objects in a row can
make the template throw or produce a malformed prompt — which happens naturally after
`/delete`-ing a reply, or when several messages arrive back-to-back.

The system prompt is assembled from these layers, in order:

| Layer | File | Owner | Notes |
| ----- | ---- | ----- | ----- |
| Persona | DB (`persona_versions`) | **user** | Who the character is + chat style. Edited from chat via `/persona` (applies instantly, no restart). Never overwritten by app updates. |
| Technical | `prompts/technical.txt` | app | Current literal app limits (no audio/video/files yet) + dynamic context. Evolves as features land. |
| Memory | _(generated)_ | app | The newest daily summaries for this chat as a `# Memory` block (see below). Per-chat and dynamic; omitted when there are none. |
| Tools | `prompts/tools.txt` | app | The tool-call protocol scaffold; its `{{tools}}` tag is filled with the available tools, and the whole layer is omitted when no tool is configured. |

The persona lives in the DB as an **append-only version log** — the newest row is the
active persona, every `/persona set|undo|default` appends a row, so the full edit history
is inspectable in SQLite and one-step undo (which is itself undoable) survives restarts.
On first start with an empty table it's seeded from the legacy `prompts/persona.txt` if
one exists (a pre-DB install keeps its tweaked persona; the file is only read, never
written), otherwise from `persona.default.txt` — the shipped, neutral starting persona
and the source for `/persona default`.

All layers support `{{tag}}` placeholders that are substituted per message:

| Tag          | Substituted with                                   |
| ------------ | -------------------------------------------------- |
| `{{char}}`   | Character name (`CHAR_NAME` in `.env`, default `Sara`) |
| `{{user}}`   | The Telegram user's display name (not username)    |
| `{{date}}`   | Current date, e.g. `June 10, 2026`                 |
| `{{day}}`    | Day of week, e.g. `Monday`                         |
| `{{period}}` | Day period: `morning` / `afternoon` / `evening` / `night` |

Unknown tags are left as-is. Because `{{date}}`/`{{day}}`/`{{period}}` change over time,
they shift the cached prompt prefix at those boundaries (e.g. when the period flips) —
expected, given they're meant to be dynamic.

### Long-term memory (daily summaries)

The context window only holds the last ~60–79 messages. To remember further back, a scheduler
(`src/summary.ts`) compresses each finished day of conversation into a short first-person diary
entry — `Headline` / `Happened` / `Mood` / `Follow-ups` — and the newest `SUMMARY_MAX_KEPT`
entries are injected as the **`# Memory`** layer above. Off by default (`SUMMARY_ENABLED=true`);
always runs through **OpenRouter** (`SUMMARY_MODEL`, default `google/gemini-2.5-flash-lite`),
independent of the active chat provider, so it has full context regardless of the local model.

- **Logical day**: a "day" runs `SUMMARY_CUTOFF_HOUR`→cutoff (default 3am→3am, in `TIMEZONE`),
  so a late-night session crossing midnight stays in one entry instead of being split.
- **When**: a day is summarized only after it has fully ended and only if it holds more than
  `SUMMARY_MIN_MESSAGES` messages. The scheduler is a plain interval (`SUMMARY_TICK_MS`), not tied
  to the message queue — it reads completed, immutable past days, so it never races a live reply.
- **State** (`summary_state`) lives in the DB, so the schedule survives restarts and catches up on
  any day missed during downtime. Existing history from before the feature is switched on is **not**
  back-filled — the day you enable it becomes the first entry.
- `/nuke` soft-deletes a chat's summaries along with its messages.
- **Reactive replies only**: the `# Memory` block is withheld from proactive openers. With no
  user message to anchor on, an opener otherwise fixates on the single most salient summary and
  rehashes it every reach-out; openers still carry the live recent-message window for short-term
  continuity.
- Roll-ups (weekly/monthly tiers, the `level` column) are reserved but not produced yet.

## Stack

- Node.js + TypeScript (ESM)
- [mtcute](https://mtcute.dev) (`@mtcute/node`) — MTProto client + SQLite session storage
- Planned: better-sqlite3 + Drizzle ORM, LLM queue, memory management

## Setup

1. Install dependencies:
   ```sh
   npm install
   ```
2. Configure `.env` (already populated for this account). See `.env.example` for the keys:
   - `API_ID`, `API_HASH` — from https://my.telegram.org
   - `PHONE` — account phone in international format
   - `WHITELIST` — comma-separated Telegram user IDs allowed to interact
   - `SESSION_PATH` — where the SQLite session is stored (default `data/userbot.session`)
   - `LOCAL_LLM_BASE_URL` / `LOCAL_LLM_MODEL` — the local llama.cpp server (primary)
   - `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` — cloud fallback (leave the key blank to disable)
   - `LLM_TEMPERATURE`, `LLM_MAX_TOKENS`, … — shared generation params (apply to either provider)

## First login (one-time, interactive)

Run the dedicated, watch-free login script (NOT `npm run dev` — watch mode intercepts
keystrokes and breaks the code prompt):

```sh
npm run login
```

> **Run this in PowerShell or Windows Terminal, not Git Bash.** Git Bash uses MinTTY,
> which Node does not treat as a real TTY, so interactive input is unreliable there.

Telegram sends a login code to your Telegram app (or SMS); type it at the prompt. If the
account has 2FA, you'll also be asked for the password.

```
Enter the login code: 12345
Enter your 2FA password: ********   # only if 2FA is enabled
```

After a successful login the session is saved to `data/userbot.session`, and subsequent
runs (`npm run dev` / `npm run start`) connect without prompting.

## Scripts

| Script          | Description                                  |
| --------------- | -------------------------------------------- |
| `npm run dev`   | Run with `tsx` + watch (auto-reload on edit) |
| `npm run start` | Run once with `tsx` (no watch)               |
| `npm run build` | Compile TypeScript to `dist/`                |
| `npm run serve` | Run the compiled build from `dist/`          |
| `npm run db:generate` | Generate a new Drizzle migration after editing `src/db/schema.ts` |

Migrations in `./drizzle` are applied automatically at startup.

## Project layout

```
src/
  index.ts      Entry point: client setup, message handling, login, shutdown
  config.ts     Env loading, validation, whitelist, LLM + DB settings
  commands.ts   Command registry + parser (/help, /status, /openrouter, /reroll, …)
  panel.ts      Command-output panel (edit-in-place message) + debris tracking/sweep
  llm.ts        Provider facade: picks a backend at startup, re-exports the chat API
  providers/
    types.ts    Shared message helpers + provider interface + OpenAI-compatible call
    llamacpp.ts Local llama.cpp backend (chat, vision, exact token count, max ctx)
    openrouter.ts OpenRouter backend (chat, vision, /key usage, estimated tokens)
  prompt.ts     System prompt assembly (persona + technical) + {{tag}} templating
  persona.ts    Persona layer state: DB-backed version log, /persona set/undo/default
  tools.ts      Tool registry + pseudo tool-call protocol (renders prompts/tools.txt)
  format.ts     Model-output → Telegram Markdown rendering
  typing.ts     "typing…" status helper
  memory.ts     Conversation memory + cache-friendly context windowing
  db/
    schema.ts   Drizzle schema (messages table)
    index.ts    SQLite connection + migrations
  logger.ts     Timestamped logger
prompts/
  persona.default.txt  Shipped default persona (tracked; source for /persona default)
  persona.txt          Legacy persona file (git-ignored; only read once to seed the DB)
  technical.txt        App-owned technical layer (limits + dynamic context)
  tools.txt            App-owned tool-protocol scaffold (has {{tools}})
drizzle/        Generated SQL migrations (committed)
data/           SQLite session + memory DB (git-ignored)
```

## Adding a command

Register it in `src/commands.ts`:

```ts
register({
  name: 'ping',
  description: 'Reply with pong',
  handler: async ({ reply }) => {
    await reply('pong');
  },
});
```

It is automatically picked up by `/help` and the router. Use `ctx.reply` for output —
it renders into the self-cleaning panel; a raw `client.sendText` would leave a message
nothing ever sweeps up.

## Notes

- `.env`, `data/`, and `*.session` files are git-ignored — never commit credentials or sessions.
- This is a userbot: automating a user account is against Telegram's ToS if abused. Use responsibly on your own account.
