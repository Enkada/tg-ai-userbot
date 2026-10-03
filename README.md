# tg-ai-userbot

An AI companion ("Sara" by default) that lives in a Telegram DM. It runs as a **userbot**: it
logs in to a real Telegram user account over MTProto (via [mtcute](https://mtcute.dev)), not as a
@BotFather bot, so the conversation looks and behaves like chatting with a person: read receipts,
"typing…", several short message bubbles per reply.

The character is written as an honest AI. The default persona says she is a self-aware AI living
in the chat, with no body, and the technical prompt layer tells her plainly what she cannot do
(voice, video, files). The human-like part is the pacing and texting style; she doesn't claim to
be a person.

Single-user by design: only Telegram user ids in `WHITELIST` are answered, and only in private
chats.

## Features

- **Streaming, multi-bubble replies.** Tokens stream over SSE and are split into chat bubbles on
  sentence boundaries while the model is still generating. Each bubble is paced like typing.
  Typographic "AI tells" (em dashes, smart quotes, `…`) are rewritten to plain keyboard characters.
- **Human pacing.** The longer the chat has been idle, the longer the read receipt takes (sqrt
  curve, jittered, capped at 15 s by default). There is also a short silent beat between the read
  receipt and "typing…".
- **Photo vision.** Incoming photos are captioned once by a vision model (the active model if it
  has vision, otherwise a dedicated `CAPTION_MODEL`). The caption is stored, and the chat model
  sees it as a `[<user> sent a photo: …]` record. Other media types are ignored.
- **Web search tool.** A `web_search` tool backed by [Tavily](https://tavily.com), using a
  text-based `<tool_call>` protocol. Results are stored with the triggering message.
- **Selfies.** A `send_selfie` tool: the model describes a picture in prose, a cheap model turns
  that into Danbooru tags, and an SDXL ComfyUI workflow runs on a RunPod serverless endpoint.
- **Long-term memory.** Nightly per-day summaries (a `# Memory` block with the newest 7) and a
  nightly diff pass that maintains durable facts about the user (a `# About <user>` block).
- **Schedule awareness.** `prompts/system/schedule.txt` describes the user's usual week. One
  hedged line about where he probably is right now rides the reply cue, plus a heads-up when the
  previous messages are hours or days old.
- **Verbal-tic control.** `src/tics.ts` launders her own recent tics out of the context window,
  strips `, huh` from outgoing text, and adds an avoid-list to the reply cue.
- **Proactive messaging.** Morning greetings and lull/ignored reach-outs on an escalating
  schedule. Implemented, **disabled by default** (`PROACTIVE_ENABLED=false`).
- **Diary channel.** One to three posts a day to a private channel, written in her voice.
  Implemented, **disabled by default** (`DIARY_ENABLED=false`).
- **Chat commands** (`/status`, `/reroll`, `/dump`, `/facts`, …) with self-cleaning output, gated
  by `CHAT_COMMANDS` (`all`, `none`, or a list). A disabled command is deleted and answered
  with a short notice; it never reaches her.
- **Two LLM backends.** A local llama.cpp server is used if it is reachable at startup;
  otherwise OpenRouter. Side passes (summaries, facts, booru tags, diary, caption fallback) always
  go through OpenRouter.

## Stack

TypeScript (ESM) run directly with [tsx](https://tsx.is) (no build step in production) ·
[mtcute](https://mtcute.dev) (MTProto) · SQLite via better-sqlite3 + [drizzle-orm](https://orm.drizzle.team)
(migrations in `drizzle/`) · OpenRouter / llama.cpp (OpenAI-compatible chat completions,
streamed) · undici (HTTP and optional proxy) · pm2 (production process manager) · pnpm.

## Setup

Requires Node.js 20.3+ (the code uses `AbortSignal.any`) and pnpm.

```sh
pnpm install
cp .env.example .env    # then fill it in
```

At minimum, set `API_ID` / `API_HASH` (from https://my.telegram.org), `PHONE` (the userbot
account), `WHITELIST` (the Telegram user id(s) she talks to) and an LLM backend: a llama.cpp
server at `LOCAL_LLM_BASE_URL`, or `OPENROUTER_API_KEY` + `OPENROUTER_MODEL`. Every variable is
documented in [docs/operations/configuration.md](docs/operations/configuration.md).

First login (one time, interactive) creates the session file at `SESSION_PATH`:

```sh
pnpm login
```

On Windows, run this from **PowerShell**, not Git Bash. Git Bash's terminal does not give the
script a usable interactive stdin for the code / 2FA prompts.

Then start the bot:

```sh
pnpm dev     # watch mode
pnpm start   # plain run
```

Migrations are applied automatically at startup. The persona is seeded into the database from
`prompts/system/persona.default.txt` on first run and versioned in the `persona_versions` table.
`/persona` can edit it from chat, but production keeps chat commands off and ships persona changes
as evaluated revisions instead (see [deploy](docs/operations/deploy.md) and
[design principles](docs/design/principles.md)). The character name is stored in the database too
(default `Sara`, changed with `/name`).

Do not run the same Telegram account locally and on a server at the same time.

## Scripts

| Script | Command | Purpose |
|:--|:--|:--|
| `pnpm login` | `tsx src/login.ts` | One-time interactive MTProto sign-in; writes the session file. |
| `pnpm dev` | `tsx watch src/index.ts` | Run with reload on change. |
| `pnpm start` | `tsx src/index.ts` | Run once. |
| `pnpm db:generate` | `drizzle-kit generate` | Generate a migration after editing `src/db/schema.ts`. |
| `pnpm build` / `pnpm serve` | `tsc` / `node dist/index.js` | Still in `package.json`, but **not used in production**. Prod runs the TS source via `node --import tsx` under pm2 (see `ecosystem.config.cjs` and [deploy](docs/operations/deploy.md)). |

Typecheck: `npx tsc --noEmit -p .` (covers `src/` only, since `scripts/` isn't in the tsconfig
`include`).

## Project layout

```
src/
  index.ts            entry: Telegram client, message dispatch, startup
  config.ts           all env parsing
  generate.ts         reply generation + tool loop + tail cue
  memory.ts           DB access, context window, day transcripts
  prompts/index.ts    every model-facing string (cues, block headers, record formats)
  prompts/render.ts   system-prompt assembly ({{tags}}, layer order)
  send.ts chunker.ts  streaming bubbles, sentence splitting
  tics.ts             verbal-tic control
  commands.ts panel.ts  chat commands and their self-cleaning output
  summary.ts facts.ts diary.ts proactive.ts selfie.ts search.ts schedule.ts
  providers/          llama.cpp and OpenRouter clients (shared SSE core)
  db/                 drizzle schema + connection
prompts/
  system/             persona.default, appearance, technical, schedule
  tools/              tool-call protocol, selfie rules
  passes/             summary, facts, diary, booru-tag side passes
scripts/              replay harness and prompt experiments (not built, not deployed)
drizzle/              SQL migrations
ecosystem.config.cjs  pm2 process definition
```

The full module map is in [docs/architecture/overview.md](docs/architecture/overview.md).

## Docs

Start at [docs/README.md](docs/README.md). Main pages:

- [Architecture overview](docs/architecture/overview.md): the message pipeline, prompt layers, tail cue, module map
- [Memory](docs/architecture/memory.md): window, daily summaries, facts, diary
- [Verbal tics](docs/architecture/tics.md)
- [Control plane](docs/architecture/control-plane.md): commands, panel, `CHAT_COMMANDS`
- [Proactive messaging and tools](docs/architecture/proactive-and-tools.md): reach-outs, search, selfies, captions, schedule
- [Deploy](docs/operations/deploy.md) and [configuration](docs/operations/configuration.md)
- [Evals](docs/development/evals.md): the replay harness and how prompt changes are tested
