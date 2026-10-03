# Control plane: commands, panel, `CHAT_COMMANDS`

Slash commands are typed into the same DM the companion lives in. They're control UI, not
conversation: no human pacing, no proactive-timer reset, and their output never enters the
model's context.

**Prod currently runs `CHAT_COMMANDS=none`.** Every slash command is intercepted, deleted and answered
with a short panel notice; none reach her. No rerolls, no deletes: what's said stays said. The operator surface lives outside the chat.

## `CHAT_COMMANDS`

Parsed in `src/config.ts` (`parseChatCommands`), enforced by `isCommandEnabled()` in
`src/commands.ts`.

| Value | Meaning |
|:--|:--|
| unset, empty, or `all` | every command is enabled (unknown `/foo` answers "Unknown command") |
| `none` | no command is enabled |
| `status,stop,r` | only these. Names are case-insensitive, a leading `/` is allowed, and aliases count (`r` enables `/reroll` and therefore `/r` too) |

- **Disabled means intercepted, not executed.** Any message starting with `/` is treated as a
  command. A disabled (or, under a restricted list, unknown) command gets a panel notice
  (`disabledCommandNotice`: "/x is disabled here… Nothing was sent to her."), the command message is
  revoked, and the notice is swept by the next normal message. It never reaches the model or the DB.
  (Until 2026-10-03 a disabled command fell through to her as plain text; that leaked commands into
  the conversation.)
- **Startup validation.** After all commands are registered, every name in the list must
  resolve to a command or alias. A typo throws at boot (`CHAT_COMMANDS: unknown command "…"`).
- `/help` lists only enabled commands.
- A photo caption is never parsed as a command.

## Registered commands

From `src/commands.ts`, in registration order:

| Command | Aliases | What it does |
|:--|:--|:--|
| `/help` | | List enabled commands |
| `/status` | `/s` | Uptime, account, both LLM providers (online/model/vision/active), caption fallback, Tavily usage |
| `/openrouter` | `/or` | OpenRouter key usage/limits, model context/vision/tier, routing preference |
| `/delete [N] [reason]` | `/d` | Soft-delete the last N rows (default 1) and revoke all their bubbles for both sides; logs a `delete` revision with the note |
| `/trim [N] [reason]` | `/t` | Revoke the last N bubbles of her latest reply and shorten the stored row. Refuses if the bubbles don't re-split cleanly (e.g. after `/u`) or if the reply is a photo |
| `/nuke [confirm]` | | Delete the whole Telegram history for both sides, soft-delete all messages, summaries and facts, reset proactive state. Over 20 messages it asks for `/nuke confirm` |
| `/clear` | `/cls` | Drop the panel without sending anything |
| `/reroll [reason]` | `/r` | Regenerate her last reply in place (see below) |
| `/update <text>` | `/u` | Replace her last reply with your own text, sent as one message; clears provenance |
| `/continue [directive]` | `/go` | Have her send the next turn unprompted, optionally steered ("ask about the weekend") |
| `/stop` | | Abort the in-flight generation (fast path, see below) |
| `/proactive [test]` | `/pro` | Show the reach-out schedule; `test` sends a preview reach-out without changing the schedule |
| `/diary [test]` | | Show the diary plan, or list postable channels when no id is set; `test` posts an entry now |
| `/img` | | Selfie endpoint health, today's count, last generation. `/img upscale on\|off` toggles the 2× pass; `/img gen <prose>` tests the pipeline outside the conversation |
| `/context` | `/c` | Window size, re-anchor countdown, prompt tokens vs. the model's max context |
| `/prompt [part]` | `/p` | Show one prompt slice: `p` persona (default), `a`, `tech`, `f` (sent as `.md`), `s` memory, `t` tools, `pic` selfie, `c` chat peek, `h` help |
| `/persona [set <text>\|undo\|default]` | | View or edit the persona layer (new `persona_versions` row; `undo` toggles between the last two) |
| `/name [<name>]` | | Show or set the `{{char}}` name (stored in `settings`) |
| `/facts [add\|set\|delete …]` | `/f` | Facts as a `.md` file with ids; manual add, edit, delete |
| `/dump` | | The full annotated prompt (every system part plus the window, with token shares, timestamps and models) as a `.md` file |

`/r`, `/u` and `/t` refuse when the last row isn't her reply, when the reply predates bubble-id
tracking, or when it's a photo turn. `/d`, `/t`, `/r` and `/u` snapshot what they destroy into
`message_revisions` (the rejection corpus). The optional reason text becomes the `note`.

## The panel and debris (`src/panel.ts`)

All command output goes to **one reusable message per chat** (the panel), edited in place by each
command, so command output never stacks. Messages that must be cleaned up later are tracked in
`command_debris`:

| Kind | What |
|:--|:--|
| `panel` | the panel message (at most one per chat) |
| `file` | document or photo output: `/dump`, `/facts`, `/prompt f`, `/img gen` |
| `command` | the user's own `/command` message, tracked from dispatch until its delete succeeds |

- **When a command arrives**, leftover `file` and `command` debris is swept first. The panel is
  kept so the handler can edit it. After the handler runs, the command message is revoked for
  both sides, and its row is released only once the revoke succeeds.
- **When a normal message arrives**, all debris for the chat is revoked, after the read receipt
  and before generation.
- **Persistence.** The rows live in SQLite, so a restart can't orphan anything; the next
  interaction collects it.
- **Edit failures.** If editing the panel fails (for example past Telegram's 48 h edit window),
  the old panel is demoted to `file` and replaced. Identical content (`MESSAGE_NOT_MODIFIED`)
  counts as success.
- **Commands that answer in the conversation** (`/r`, `/u`, `/go`) drop the panel instead.
  `/nuke` forgets all debris rows, because the history wipe removed the messages.

The panel is also used outside commands, so it shows up even with `CHAT_COMMANDS=none`: the
apology when generation fails before any bubble was sent, and the "📸 Making a picture…" progress
note during a selfie.

## `/stop` fast path

`handleMessage` (`src/index.ts`) checks for `/stop` **before** the per-chat queue, when `stop` is
enabled. `stopInFlight(chatId)` (`src/inflight.ts`):

- aborts the registered `AbortController`, which cancels the SSE request (and a running selfie's
  booru pass and RunPod job);
- sets the streamer's stop flag, so no further bubble is sent, including one waiting in its
  typing pause.

The `/stop` message is marked read and deleted. Whatever already landed is persisted as the reply,
with no apology. Interruptible generations are reactive replies (including their selfie flow) and
`/continue`. Automated reach-outs and `/reroll` don't register, so `/stop` doesn't reach them. The
registered `stop` command handler is only a fallback, kept so it appears in `/help`.

## `/reroll`

- **Reply.** For an ordinary reply, the window is rebuilt and trailing assistant turns are
  popped. It regenerates with the normal tail cue (including the gap heads-up) plus a **reroll
  angle**. It's a single pass with no search loop; searches already stored on the user turn
  still ground it.
- **Reach-out.** For a reach-out (`kind` `reachout_*`), the director cue is rebuilt from the
  stored kind with `buildReachoutCue`: fresh schedule slot, freshly rolled lull shape, and a
  recent-openers list that now includes the opener being replaced. It runs with the memory block
  withheld and the opener's own row excluded from the window.
- **The swap.** It happens when the first new bubble is ready: the old bubbles, the `/r`
  message and the panel are revoked together. If generation fails before any bubble, the old
  reply is untouched.
- **Saving.** On success the old content goes to `message_revisions`, and the same row is
  repointed at the new text and bubble ids, which refreshes `created_at` for the read-delay clock.
- A `send_selfie` call in the regenerated reply is executed.

**Angles** (`REROLL_ANGLES` in `src/prompts/index.ts`) are stances, never topics. They're dealt
without replacement per message and reshuffled when exhausted, so a reroll spree explores
instead of re-sampling one attractor. The current five:

1. push back on part of it - you see it differently
2. tease him about it, let some air out of it
3. be blunt - one short line, nothing softened
4. find the joke in it and riff
5. drop the wry act and be sincere about it

The angle is spliced into the tail cue as "You already answered this once - come at it from a
different angle this time: <angle>. It's a way into what <user> just said, not a new subject."
It's never stored.
