# Docs

| Folder | What's in it |
|---|---|
| [architecture/](architecture/) | How the bot works, from the code |
| [operations/](operations/) | Deploying and configuring it |
| [development/](development/) | Evaluating behaviour changes before shipping them |
| [design/](design/) | Principles the character and the codebase follow, and the roadmap |
| `private/` | Local only, git-ignored (see below) |

## Architecture

- [overview.md](architecture/overview.md): message pipeline, system-prompt layers, tail cue, context window, module map
- [memory.md](architecture/memory.md): context window, daily summaries, facts, diary
- [tics.md](architecture/tics.md): verbal-tic control (window laundering, outgoing guard, avoid-list)
- [control-plane.md](architecture/control-plane.md): chat commands, the panel, `CHAT_COMMANDS`, reroll angles
- [proactive-and-tools.md](architecture/proactive-and-tools.md): proactive engine, tool protocol, web search, selfies, photo captions, schedule awareness

## Operations

- [deploy.md](operations/deploy.md): deploy procedure, server `.env` rules, backups, persona changes
- [configuration.md](operations/configuration.md): environment variables by area

## Development

- [evals.md](development/evals.md): the replay harness (`scripts/replay.ts`), ablations, blind judging

## Design

- [principles.md](design/principles.md): honest bot, identity over rules, no guilt mechanics, how changes are made
- [roadmap.md](design/roadmap.md): shipped, next, hygiene backlog, parked

## Private docs

`docs/private/` is git-ignored because this repo is public. It holds the personal material: chat
analyses and agent reports, experiment data with chat excerpts, persona texts, the decisions
record, and prod host details. It exists only on the maintainer's machine; its index is
`docs/private/README.md`.

`.scratch/` (also git-ignored) is the archive: raw experiment output and old workbench files that
are no longer current.
