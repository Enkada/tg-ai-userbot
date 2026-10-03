# Configuration

All configuration comes from environment variables, loaded from `.env` by `dotenv` and parsed in
`src/config.ts`. Start from `.env.example`. Parsing is strict:

- a non-numeric number throws at startup;
- booleans accept `true/1/yes/on` and `false/0/no/off`, and anything else throws;
- unknown `CHAT_COMMANDS` names throw.

Runtime state that can change from the chat (persona, character name, selfie upscale) lives in the
database, not here.

**Off by default:** proactive messaging, summaries, facts, diary. Search and selfies are off until
their keys are set. Variables marked † are read by `config.ts` but missing from `.env.example`.

## Telegram and core

| Var | Default | What it does |
|:--|:--|:--|
| `API_ID` | **required** | MTProto app id from my.telegram.org (must be an integer) |
| `API_HASH` | **required** | MTProto app hash |
| `PHONE` | **required** | Phone number of the userbot account (international format) |
| `WHITELIST` | empty | Comma-separated Telegram user ids she answers. Empty means nobody. Also the set of chats the background loops walk; the diary uses the first one |
| `SESSION_PATH` | `data/userbot.session` | mtcute session storage, created by `pnpm login` |
| `DB_PATH` | `data/userbot.db` | SQLite database (directory created if missing) |
| `PROXY_URL` | unset | Proxy for the MTProto connection: `socks5://`, `http://`, or an MTProxy `https://t.me/proxy?...` link. When it's `http(s)://`, it's also used for OpenRouter and Tavily calls |
| `CHAT_COMMANDS` | `all` | `all`, `none`, or a comma list of command names/aliases. Disabled commands reach her as plain text. See [control-plane.md](../architecture/control-plane.md) |
| `TIMEZONE` | `Europe/Moscow` | IANA zone, assigned to `process.env.TZ` before any `Date` is created. Drives the clock, `{{period}}`, logical days, schedule, proactive and diary windows |

## LLM: shared generation

| Var | Default | What it does |
|:--|:--|:--|
| `LLM_TEMPERATURE` | `0.7` | Chat temperature (also used by the diary) |
| `LLM_MAX_TOKENS` | `512` | Chat reply cap |
| `LLM_TOP_P`, `LLM_MIN_P`, `LLM_PRESENCE_PENALTY`, `LLM_FREQUENCY_PENALTY` | unset | Chat-path sampling knobs. **Unset means the field isn't sent** and the serving provider's default applies. `.env.example` lists suggested values for the current model |
| `LLM_TIMEOUT_MS` † | `120000` | Cap on one chat or caption request (generation plus streaming) |
| `CAPTION_MODEL` | unset | OpenRouter vision slug for captioning photos when the active model is text-only. Unset, with a text-only model, means photos are ignored |
| `LLM_CAPTION_TEMPERATURE` | `0.3` | Caption pass temperature |
| `LLM_CAPTION_MAX_TOKENS` | `150` | Caption length cap |

Reasoning is always disabled in code: `enable_thinking: false` for llama.cpp, and
`reasoning: { enabled: false }` on every OpenRouter call. There's no variable for it.

## LLM: local llama.cpp (preferred when reachable at startup)

| Var | Default | What it does |
|:--|:--|:--|
| `LOCAL_LLM_BASE_URL` | `http://localhost:5001` | llama.cpp server root (OpenAI-compatible `/v1/chat/completions`, plus `/props`, `/tokenize`, `/apply-template`) |
| `LOCAL_LLM_MODEL` | `local` | Model name sent in the body (ignored by llama.cpp) |

## LLM: OpenRouter (used when local is offline at startup; always used for side passes)

| Var | Default | What it does |
|:--|:--|:--|
| `OPENROUTER_API_KEY` | unset | Enables OpenRouter. Also required by summaries, facts, diary, selfies and `CAPTION_MODEL` |
| `OPENROUTER_MODEL` | `google/gemma-4-26b-a4b-it:free` | Chat model slug (also the diary model) |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | API root |
| `OPENROUTER_APP_NAME` | `tg-ai-userbot` | Sent as `X-Title` |
| `OPENROUTER_APP_URL` | unset | Sent as `HTTP-Referer` |
| `OPENROUTER_PROVIDER_ORDER` | *unset:* `deepinfra,google-vertex,cloudflare` | Preferred upstream providers, in order (chat and diary calls only). **Set but blank** means no order (OpenRouter decides). `.env.example` ships the Gemma-tuned list; change it when you change the model |
| `OPENROUTER_ALLOW_FALLBACKS` | `true` | Allow providers outside the order list |
| `OPENROUTER_PROVIDER_SORT` | unset | `price`, `throughput` or `latency` for the rest |

Side passes (summary, facts, booru, caption fallback) use their own slugs and send no provider
routing.

## Streaming and pacing

| Var | Default | What it does |
|:--|:--|:--|
| `STREAMING_DELAY_BASE_MS` | `400` | Inter-bubble "typing" delay: base, also the floor |
| `STREAMING_DELAY_PER_CHAR_MS` | `30` | ... plus this per character of the next bubble |
| `STREAMING_DELAY_MAX_MS` | `3000` | ... capped here. Time already elapsed is subtracted |
| `READ_DELAY_THRESHOLD` | `3` | Minutes of chat idle under which messages are read instantly |
| `READ_DELAY_MAX` | `15` | Read-delay cap, in seconds |
| `READ_DELAY_FULL_AT` | `130` | Idle minutes at which the sqrt curve reaches the cap |
| `READ_DELAY_INSTANT_CHANCE` | `0.15` | Past 10 min idle, chance of a 2-3 s read instead |
| `READ_PAUSE_BASE_MS` | `400` | Silent read→typing beat: base |
| `READ_PAUSE_PER_CHAR_MS` | `25` | ... plus this per character of the incoming text |
| `READ_PAUSE_MAX_MS` | `2500` | ... capped here. Photos use a 1-2 s beat with the caption pass inside it |

## Web search (Tavily)

| Var | Default | What it does |
|:--|:--|:--|
| `TAVILY_API_KEY` | unset | Enables the `web_search` tool. Unset means the tool isn't offered |
| `TAVILY_BASE_URL` † | `https://api.tavily.com` | API root |
| `TAVILY_SEARCH_DEPTH` † | `basic` | `basic` (1 credit) or `advanced` (2) |
| `TAVILY_MAX_RESULTS` † | `5` | Results requested per query |
| `TAVILY_MAX_SOURCES` † | `3` | Snippets kept when Tavily returns no synthesized answer |
| `TAVILY_MAX_SEARCHES` † | `3` | Max searches per turn (anti-loop cap) |
| `TAVILY_TIMEOUT_MS` † | `15000` | Per-request timeout |

## Proactive messaging (off)

| Var | Default | What it does |
|:--|:--|:--|
| `PROACTIVE_ENABLED` | `false` | Master switch. Off means the scheduler never starts |
| `PROACTIVE_WINDOW_START` / `_END` | `7` / `23` | Local hours in which she may initiate (start ≤ h < end) |
| `PROACTIVE_MORNING_START` / `_END` | `7` / `8` | Hour range for the random morning-greeting time |
| `PROACTIVE_SILENCE_MIN` / `_MAX` | `45` / `180` | Base gap range (minutes) before the first reach-out |
| `PROACTIVE_SILENCE_SKEW` | `2` | Gap = min + span·random()^skew. 1 is uniform; >1 favours short gaps |
| `PROACTIVE_ESCALATION_STEP` | `60` | Minutes added per unanswered reach-out |
| `PROACTIVE_MAX_IGNORED` | `8` | After this many unanswered, silent until the user replies |
| `PROACTIVE_RECENT_OPENERS` † | `8` | Past openers quoted in the cue. Don't raise much past 8 |
| `PROACTIVE_TICK_MS` | `60000` | Scheduler tick |

## Long-term memory: summaries (off)

| Var | Default | What it does |
|:--|:--|:--|
| `SUMMARY_ENABLED` | `false` | Master switch (also needs `OPENROUTER_API_KEY`) |
| `SUMMARY_MODEL` | `deepseek/deepseek-v4-flash` | Summarizer slug |
| `SUMMARY_MIN_MESSAGES` | `10` | A day is summarized only with **more** than this many messages |
| `SUMMARY_MAX_KEPT` | `7` | Newest summaries injected as `# Memory` |
| `SUMMARY_CUTOFF_HOUR` | `3` | Logical-day boundary (local hour). Shared with facts |
| `SUMMARY_TICK_MS` | `600000` | Scheduler tick |
| `SUMMARY_TEMPERATURE` | `0.3` | |
| `SUMMARY_MAX_TOKENS` | `400` | |
| `SUMMARY_TIMEOUT_MS` | `60000` | |

## Long-term memory: facts (off)

| Var | Default | What it does |
|:--|:--|:--|
| `FACTS_ENABLED` | `false` | Master switch (also needs `OPENROUTER_API_KEY`) |
| `FACTS_MODEL` | `deepseek/deepseek-v4-flash` | Diff-pass slug |
| `FACTS_MIN_MESSAGES` | `3` | A day is scanned only with **more** than this many messages |
| `FACTS_TICK_MS` | `600000` | Scheduler tick |
| `FACTS_TEMPERATURE` | `0.3` | |
| `FACTS_MAX_TOKENS` | `2000` | Cap on the ops JSON |
| `FACTS_TIMEOUT_MS` | `90000` | |

## Diary (off)

| Var | Default | What it does |
|:--|:--|:--|
| `DIARY_ENABLED` | `false` | Master switch (also needs `DIARY_CHANNEL_ID`, `OPENROUTER_API_KEY` and a whitelist) |
| `DIARY_CHANNEL_ID` | unset | Marked channel id (`-100…`) the account can post to. `/diary` lists candidates |
| `DIARY_WINDOW_START` / `_END` | `7` / `23` | Posting window (local hours) |
| `DIARY_MIN_GAP_MINUTES` | `120` | Minimum spacing between same-day entries |
| `DIARY_GRACE_MINUTES` | `60` | A slot missed by more than this is skipped |
| `DIARY_ABOUT_CHANCE` | `0.3` | Share of entries allowed to involve the user |
| `DIARY_RECENT_ENTRIES` | `8` | Prior entries fed back as the no-reuse block |
| `DIARY_TRANSCRIPT_HOURS` / `_MAX` | `48` / `40` | Reach and cap of the recent-conversation block |
| `DIARY_SPARKS` | `8` | Spark words offered per entry |
| `DIARY_MAX_TOKENS` | `700` | Entry cap |
| `DIARY_TICK_MS` | `60000` | Scheduler tick |

## Selfies (RunPod ComfyUI)

The feature exists only when `RUNPOD_API_KEY`, `RUNPOD_ENDPOINT_ID` **and** `OPENROUTER_API_KEY`
are all set.

| Var | Default | What it does |
|:--|:--|:--|
| `RUNPOD_API_KEY` | unset | RunPod API key |
| `RUNPOD_ENDPOINT_ID` | unset | Serverless ComfyUI endpoint id |
| `SELFIE_MODEL` | `deepseek/deepseek-v4-flash` | Booru-pass slug (prose → tags) |
| `SELFIE_TEMPERATURE` | `0.3` | |
| `SELFIE_MAX_TOKENS` | `400` | |
| `SELFIE_LLM_TIMEOUT_MS` | `60000` | Timeout for the booru pass |
| `SELFIE_CHECKPOINT` | `waiIllustriousSDXL_v160.safetensors` | Checkpoint filename on the endpoint's volume |
| `SELFIE_LORA` | `ramdomrot_v2_illustrious_locon-000009.safetensors` | LoRA filename on the volume |
| `SELFIE_LORA_STRENGTH` | `0.85` | Applied to both model and CLIP |
| `SELFIE_WIDTH` / `_HEIGHT` | `720` / `1280` | Base latent size (the upscale pass doubles it) |
| `SELFIE_TIMEOUT_MS` | `300000` | Wall-clock budget per image, submit to result (covers cold starts) |
| `SELFIE_POLL_MS` | `4000` | Job status poll interval |
| `SELFIE_PHOTOS_DIR` | `data/photos` | Local copies of generated PNGs |

The 2× upscale pass is toggled at runtime with `/img upscale on|off` (stored in `settings`,
default on).

## Not configurable by env

- **Character name:** `settings.char_name`, default `Sara`, changed with `/name`.
- **Persona:** `persona_versions`, changed with `/persona` or a new row.
- **Prompt file paths:** hard-coded in `config.ts`
  (`prompts/system/*`, `prompts/tools/*`, `prompts/passes/*`).
- **Window size:** 60-79 rows (`MIN_WINDOW`, `STEP` in `src/memory.ts`).
