# Proactive messaging and tools

## Proactive engine (`src/proactive.ts`), disabled

`PROACTIVE_ENABLED=false` is the default and the current setting. When it's off,
`startProactiveLoop` is never called and `onUserActivity` is a no-op.

### State machine

There's one `proactive_state` row per chat (`due_at`, `is_morning`, `ignored_count`, cached
`user_name`), stored in the DB so it survives restarts. Every `PROACTIVE_TICK_MS` the loop
enqueues an evaluation for each whitelisted chat on that chat's queue, so it never races a reply.
`evaluateReachout` then does the first matching step:

1. **Outside** `PROACTIVE_WINDOW_START` ≤ hour < `PROACTIVE_WINDOW_END`: unarm (`due_at = null`).
   The ignored count survives the night.
2. **`ignored_count ≥ PROACTIVE_MAX_IGNORED`**: hard block. Nothing is sent, not even the
   morning greeting, until the user replies.
3. **Unarmed**:
   - before `PROACTIVE_MORNING_END`, arm a morning greeting at a random time in
     `PROACTIVE_MORNING_START`-`END`;
   - otherwise arm the daytime gap.
4. **Due**: send the reach-out, set `ignored_count = attempt` and arm the next gap, or unarm at
   the cap. A failed send is not counted as ignored; the same gap level is retried.

The **daytime gap** is `SILENCE_MIN + (SILENCE_MAX − SILENCE_MIN) · random()^SKEW` minutes, plus
`ESCALATION_STEP` minutes per ignored reach-out.

**Resets.** `onUserActivity` runs on every non-command text or photo message (unsupported media
types don't count). It resets
`ignored_count` to 0, arms the base gap, and cancels a pending morning greeting. Commands never
reset it.

### Kinds and director cues

A reach-out is generated through the normal persona path with an **ephemeral director cue** as
the last user turn. The cue is never stored. The stored row records which cue produced it
(`messages.kind`), which is what lets `/reroll` rebuild it.

| Kind | When | Cue (`src/prompts/index.ts`) |
|:--|:--|:--|
| `reachout_morning` | the armed morning slot | `morningReachoutCue`: greet warmly; schedule clause; recent-openers list |
| `reachout_lull` | first daytime reach-out since he last replied | `lullReachoutCue`: one rolled **opener shape**; schedule clause; "don't comment on them being quiet"; recent-openers list |
| `reachout_ignored` | a previous reach-out went unanswered | `ignoredReachoutCue`: she may let that show lightly; recent-openers list; deliberately **no** schedule clause (that pairing is untested) |

- The hour count and attempt number are never passed to the cue, only the lull/ignored
  distinction.
- Reach-outs render the system prompt **without the `# Memory` block** (summaries caused
  fixation when there's no user message to anchor on). Facts stay.
- Reach-outs don't get the reactive tail cue. Each director cue carries its own "keep it short".

**Opener shapes** (`OPENER_SHAPES`) are rolled in code with weights 3/3/2/1/1/1/1, rather than
offered to the model as a menu (which it collapsed to one item):

- pick one thing they said earlier and say what you make of it now;
- a flat statement about something in his world, with no question;
- poke or tease;
- a nudge of a handful of words;
- ask something you want to know;
- say what you want right now;
- an unconnected tangent with an anti-fabrication clause.

**Recent openers** (`recentOpenersClause`) quotes her last `PROACTIVE_RECENT_OPENERS` (8)
openers inside the cue's bracket. That includes **soft-deleted** ones (marked "went over
especially badly"), because a deleted opener otherwise vanishes from her context and comes back.
Keep the cap around 8; at 14 the cue started leaking into the output as a fabricated
`[System note …]`.

`/continue [directive]` uses the same send path (`sendCued`) with `continueCue` /
`continueDirectiveCue`, keeps the memory block, is stored as `kind = reply`, is interruptible by
`/stop`, and never touches the schedule. `/proactive test` sends a lull or ignored preview without
changing state.

Reach-outs and `/continue` can run the search tool. Their searches live in memory for the next
call only (`ephemeralSearchStrategy`), and nothing but the final text is persisted. They can also
send a selfie.

## Tool protocol (`src/tools.ts`)

Neither chat model did native tool-calling reliably, so tools are described in a text block
(`prompts/tools/tools.txt`, with `{{tools}}` filled from `availableTools()`), and a call is one
line:

```
<tool_call>{"name": "web_search", "arguments": {"query": "…"}}</tool_call>
```

| Tool | Args | Available when |
|:--|:--|:--|
| `web_search` | `query` | `TAVILY_API_KEY` set |
| `send_selfie` | `prompt` | `RUNPOD_API_KEY` + `RUNPOD_ENDPOINT_ID` + `OPENROUTER_API_KEY` set |

- `parseToolCall` returns the first well-formed call. Malformed JSON counts as plain text and is
  sent as-is, on purpose, so a misbehaving model is visible.
- `stripToolCalls` / `finalizeReply` remove well-formed calls before sending or saving.
- The streamer suppresses tool-call passes and truncates prose at a mid-stream `<tool_call>`.
- With no tools available, the tools block renders empty and the loop is a single call.
- **If you change the tag format**, update both `tools.txt` and `TOOL_CALL_RE`.

## Web search (`src/search.ts`)

`webSearch` POSTs to Tavily `/search` with `include_answer: 'advanced'`, `search_depth`
(`TAVILY_SEARCH_DEPTH`, default `basic`) and `max_results`. Tavily's synthesized `answer` is used
on its own when present. Otherwise the top `TAVILY_MAX_SOURCES` snippets are used, clipped to
280 chars each with a host label. A failed search feeds back "search failed — no results
available right now."

Reactive searches are stored in `searches` against the user's message and rendered after it as
`[you already searched the web for "…" - results: …]`. The "already" wording is what stops the
model from re-issuing the same call. At most `TAVILY_MAX_SEARCHES` (3) searches run per turn.

Calls (and `/status`'s `/usage` lookup) go through `getProxyDispatcher()` (`src/proxyAgent.ts`):
an undici `ProxyAgent` built from `PROXY_URL` when it's an `http(s)://` URL, otherwise direct.
This is needed where an API's edge blocks the host's IP; OpenRouter uses the same dispatcher.
SOCKS5 and MTProxy URLs can't be tunnelled by undici, so with those the HTTP calls go direct.

## Selfies (`src/selfie.ts`)

Pipeline, per picture:

1. **Tool call.** The chat model replies with a short line, then
   `send_selfie({"prompt": "<plain-prose description>"})` (rules in `prompts/tools/selfie.txt`).
   The streamer shows only the prose. A bare call with no prose gets an **ack line** from
   `ackLine()`, a one-shot chat call with `selfieAckCue`, falling back to `gimme a sec`.
2. **Reply saved first**, then `runSelfieFlow` runs inside the same queue task, so messages that
   arrive meanwhile wait. The panel shows "📸 Making a picture…".
3. **Caption line** generated in parallel (`selfieCaptionCue`).
4. **Capacity check.** `assertCapacity()` reads the endpoint's `/health` and fails fast if every
   worker is throttled. An unreachable `/health` or a scaled-to-zero endpoint doesn't block.
5. **Booru pass** (`proseToTags`). A cheap OpenRouter model (`SELFIE_MODEL`, low temperature,
   reasoning off) turns the prose into Danbooru tags using `prompts/passes/booru.txt`, whose
   `{{identity}}` / `{{outfit_*}}` tags are filled from `prompts/passes/booru-appearance.txt`.
   Shape guard: the output must contain the identity block's first tag. Quality tags are appended
   in code.
6. **Workflow built in code** (`buildWorkflow`, ComfyUI API format):
   - `SELFIE_CHECKPOINT` → CLIP skip 2 → `SELFIE_LORA` at `SELFIE_LORA_STRENGTH`;
   - base pass: 30 steps, euler, CFG 5 at `SELFIE_WIDTH`×`SELFIE_HEIGHT` (720×1280);
   - optional 2× bislerp latent upscale with a 20-step, CFG 7, denoise 0.5 second pass. The
     toggle is `/img upscale on|off`, stored in `settings`.
7. **RunPod job.** `POST /v2/<endpoint>/run`, then poll `/status/<id>` every `SELFIE_POLL_MS`
   until `COMPLETED`, a failure status, `/stop`, or the `SELFIE_TIMEOUT_MS` budget (default 300 s,
   which covers cold workers). On timeout or abort the job is cancelled via `/cancel/<id>`, and a
   failed cancel is logged because the job may still bill. Transient poll errors are retried; a
   response with no `status` is fatal.
8. **Send.** The PNG goes out as one photo message with the caption, saved under
   `SELFIE_PHOTOS_DIR`. The `messages` row holds the caption, the `attachments` row holds the
   prose (the window renders this as tool call → `[photo sent]` → caption), and `photo_gens`
   records tags, seed, job id and timings.
9. **Failure.** The attempt is recorded as failed, and an in-character line is sent and stored
   (`SELFIE_FAILURE_CUE`, falling back to `ugh, it came out cursed. not sending that`). A `/stop`
   abort ends silently.

There is no daily cap: `isSelfieAvailable()` equals `isSelfieConfigured()`. `photosToday()` is
only shown in `/img`.

**Promise gate.** Sometimes the model promises a picture without calling the tool, or writes a
fake `[you sent a photo …]` record. If a reply has no valid call but matches
`looksLikePhotoPromise` (promise words + visual noun) or `containsFakePhotoBlock`,
`maybeRepairPromise` asks the chat model to reread its last message and output either the
`send_selfie` call or `no`. Only a **well-formed parsed call** starts the flow; any other output
is discarded. The raw reply is never edited.

The tail cue's selfie sentence ("Bracketed [...] lines in the chat are system records - never
write one yourself; to send a picture, output the send_selfie tool call.") is what keeps the
model from imitating photo records once a photo turn is in the window.

## Photo captioning

When a photo arrives, `canCaptionImages()` passes if either:

- the active chat model has vision (llama.cpp with `--mmproj`, or an OpenRouter model with image
  input), in which case it captions with its own model; or
- `CAPTION_MODEL` and `OPENROUTER_API_KEY` are set, in which case `captionImage()` uses that slug
  with reasoning off and without the chat routing.

The caption pass uses a neutral describer prompt (`CAPTION_SYSTEM_PROMPT`: one or two sentences,
no preamble), `LLM_CAPTION_TEMPERATURE` and `LLM_CAPTION_MAX_TOKENS`, and newlines collapsed. The
caption is stored in `attachments` and is all the model ever sees of the image, as
`[<user> sent a photo: …]`. The technical layer tells her to treat it as seeing the photo. With
no caption path, photos are ignored (and a caption-less photo gets no reply).

## Schedule awareness (`prompts/system/schedule.txt` + `src/schedule.ts`)

`schedule.txt` is operator-edited and documents its own syntax:

- weekday sections: `[Mon-Fri]`, `[Sat]`, `[Mon,Wed,Fri]`;
- date-override sections: `[YYYY-MM-DD]` or `[YYYY-MM-DD..YYYY-MM-DD]`;
- blocks: `HH:MM text`, each running until the next block's start. A day's last block runs into
  the next day's first.

Rules:

- A matching date section beats any weekday section, and later sections win on overlap.
- It's parsed at import, so a malformed line fails the boot.
- A file with no blocks (or no block covering a day) turns the feature off: `scheduleNow()`
  returns null and no clause is rendered.
- When the last block of a single-block day would loop around to its own start time, the
  `until` is suppressed.

`scheduleNow()` returns `{ text, until }`, rendered by `scheduleClause` as "Going by his usual
routine, <user> is probably <text> right now (until ~HH:MM)." It appears in the reactive tail cue
(after the clock and gap heads-up) and in the morning and lull reach-out cues. It never enters
the system prompt. It's paired with the gap heads-up (`gapHeadsUpClause`), because the window
has no timestamps and an hours-old "working lol" otherwise reads as current.
