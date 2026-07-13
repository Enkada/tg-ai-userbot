import 'dotenv/config';

// Lock the process timezone before any `Date` is constructed, so the {{period}} tag and
// the proactive scheduler agree on "what hour it is" regardless of the host's timezone.
// Node re-reads process.env.TZ on assignment, so setting it here is enough.
process.env.TZ = process.env.TIMEZONE?.trim() || 'Europe/Moscow';

/**
 * Reads a required environment variable, throwing a clear error if it is missing.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (check your .env file)`);
  }
  return value;
}

/**
 * Reads a numeric environment variable, falling back to `fallback` when unset and
 * throwing on a non-numeric value (so a typo fails loudly at startup instead of
 * silently becoming NaN in a request body).
 */
function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Environment variable ${name} must be a number, got: "${raw}"`);
  }
  return value;
}

/**
 * Reads an optional numeric environment variable: unset/blank ⇒ undefined (callers omit
 * the field from request bodies entirely, leaving the serving provider's default in
 * effect), non-numeric ⇒ throw, same as {@link numberEnv}.
 */
function optionalNumberEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Environment variable ${name} must be a number, got: "${raw}"`);
  }
  return value;
}

/**
 * Parses a comma-separated list of numeric Telegram user IDs.
 */
function parseIdList(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const id = Number(part);
      if (!Number.isInteger(id)) {
        throw new Error(`Invalid user ID in WHITELIST: "${part}"`);
      }
      return id;
    });
}

/** Splits a comma-separated env value into trimmed, non-empty strings. */
function parseCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Reads a boolean env var. Accepts true/1/yes/on and false/0/no/off (case-insensitive);
 * unset/empty falls back, anything else throws so a typo fails loudly at startup.
 */
function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;
  throw new Error(`Environment variable ${name} must be a boolean, got: "${raw}"`);
}

/** Recommended low-TTFT upstreams for the Gemma model (see provider-latency analysis). */
const DEFAULT_PROVIDER_ORDER = ['deepinfra', 'google-vertex', 'cloudflare'];

export const config = {
  apiId: Number(required('API_ID')),
  apiHash: required('API_HASH'),
  phone: required('PHONE'),
  whitelist: new Set(parseIdList(process.env.WHITELIST)),
  sessionPath: process.env.SESSION_PATH ?? 'data/userbot.session',
  dbPath: process.env.DB_PATH ?? 'data/userbot.db',
  /**
   * Optional proxy for the MTProto connection, used where Telegram's data centres are
   * blocked at the network level. Accepts any URL understood by
   * mtcute's `proxyTransportFromUrl`: `socks5://user:pass@host:port`,
   * `http://user:pass@host:port`, or an MTProxy `https://t.me/proxy?server=…&port=…&secret=…`.
   * Unset ⇒ connect directly. The proxy only sees encrypted MTProto, never message contents.
   */
  proxyUrl: process.env.PROXY_URL?.trim() || undefined,
  character: {
    /** Name substituted for the {{char}} tag in the system prompt. */
    name: process.env.CHAR_NAME ?? 'Sara',
  },
  llm: {
    // ---- System prompt, assembled from three layers (persona + technical + tools) ----
    /**
     * Legacy persona file, now only a migration seed: the persona lives in the DB
     * (persona_versions, edited via /persona) and this file is read once to seed the table
     * when it's empty — so a pre-DB install keeps its tweaked persona. Never written.
     */
    personaPromptPath: process.env.PERSONA_PROMPT_PATH ?? 'prompts/persona.txt',
    /** Shipped default persona: the first-run seed (when no legacy file exists) and the source for /persona default. */
    personaDefaultPath: 'prompts/persona.default.txt',
    /** App-owned technical layer (current app limits + dynamic context). Evolves with features; never user-copied. */
    technicalPromptPath: 'prompts/technical.txt',
    /** App-owned tool-protocol scaffold; its {{tools}} tag is filled with the available-tools list. */
    toolsPromptPath: 'prompts/tools.txt',
    // ---- Shared generation params (apply to whichever provider is active) ----
    temperature: numberEnv('LLM_TEMPERATURE', 0.7),
    maxTokens: numberEnv('LLM_MAX_TOKENS', 512),
    /**
     * Optional sampling knobs for the CHAT path only (captions and summaries keep their
     * own low-temperature settings). Each is sent verbatim as its OpenAI-style field when
     * set and omitted from the request entirely when blank — there are no code defaults,
     * so a blank knob means "whatever the serving provider defaults to". Guidance for the
     * current model lives in .env.example.
     */
    topP: optionalNumberEnv('LLM_TOP_P'),
    minP: optionalNumberEnv('LLM_MIN_P'),
    presencePenalty: optionalNumberEnv('LLM_PRESENCE_PENALTY'),
    frequencyPenalty: optionalNumberEnv('LLM_FREQUENCY_PENALTY'),
    /** Hard cap on an image caption's length — the backstop against verbose descriptions. */
    captionMaxTokens: numberEnv('LLM_CAPTION_MAX_TOKENS', 150),
    /** Lower than chat temperature: captions should be factual, not creative. */
    captionTemperature: numberEnv('LLM_CAPTION_TEMPERATURE', 0.3),
    /**
     * Optional dedicated OpenRouter vision slug used to caption photos when the *active* chat
     * model can't see images (e.g. a text-only local model). When the active model has vision,
     * it captions with its own model and this is unused; only the fallback path reads it. Unset
     * ⇒ no fallback, so a photo is dropped whenever the active model lacks vision. Routed through
     * OpenRouter like {@link config.summary.model}, so it also requires OPENROUTER_API_KEY.
     */
    captionModel: process.env.CAPTION_MODEL?.trim() || undefined,
    /** Hard cap on a single generation request, so a hung server can't wedge a chat. */
    timeoutMs: numberEnv('LLM_TIMEOUT_MS', 120_000),
    // ---- Local provider (llama.cpp, OpenAI-compatible) — the primary ----
    local: {
      /** Base URL of the local llama.cpp server. No trailing slash. */
      baseUrl: (process.env.LOCAL_LLM_BASE_URL ?? 'http://localhost:5001').replace(/\/+$/, ''),
      /** Model name sent in the request body. llama.cpp ignores it but the field is required. */
      model: process.env.LOCAL_LLM_MODEL ?? 'local',
    },
    // ---- OpenRouter (cloud) — the fallback when local is offline ----
    openrouter: {
      /** API key (sk-or-v1-…). Absent ⇒ OpenRouter is "not configured" and never used. */
      apiKey: process.env.OPENROUTER_API_KEY?.trim() || undefined,
      /** OpenRouter API root (already includes /api/v1). No trailing slash. */
      baseUrl: (process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
      /** Model slug, e.g. google/gemma-4-26b-a4b-it:free. */
      model: process.env.OPENROUTER_MODEL ?? 'google/gemma-4-26b-a4b-it:free',
      /** Sent as X-Title for OpenRouter's app-ranking leaderboard (optional). */
      appName: process.env.OPENROUTER_APP_NAME ?? 'tg-ai-userbot',
      /** Sent as HTTP-Referer for app ranking (optional). */
      appUrl: process.env.OPENROUTER_APP_URL?.trim() || undefined,
      // ---- Upstream provider routing (which backend serves the model) ----
      /**
       * Preferred upstream providers, tried first in this order. Unset ⇒ the recommended
       * low-latency default; set to a blank value to opt out (pure OpenRouter routing).
       */
      providerOrder:
        process.env.OPENROUTER_PROVIDER_ORDER === undefined
          ? DEFAULT_PROVIDER_ORDER
          : parseCsv(process.env.OPENROUTER_PROVIDER_ORDER),
      /** Optional ranking strategy for the rest: 'price' | 'throughput' | 'latency'. */
      providerSort: process.env.OPENROUTER_PROVIDER_SORT?.trim() || undefined,
      /** When true, fall back to other providers if the preferred ones are unavailable. */
      allowFallbacks: boolEnv('OPENROUTER_ALLOW_FALLBACKS', true),
    },
  },
  // ---- Streaming: deliver every reply as several chat bubbles instead of one block ----
  streaming: {
    /**
     * Inter-bubble pacing simulates someone typing the *next* bubble: the gap before it is
     * `base + length × perChar`, capped at `max`. Only the idle part is waited out — if the
     * previous send (or, in future, token generation) already took longer, the next bubble
     * goes immediately, so the real gap is MAX(elapsed, computed delay). `base` doubles as
     * the floor so even a one-word bubble pauses naturally rather than firing instantly.
     */
    delayBaseMs: numberEnv('STREAMING_DELAY_BASE_MS', 400),
    delayPerCharMs: numberEnv('STREAMING_DELAY_PER_CHAR_MS', 30),
    delayMaxMs: numberEnv('STREAMING_DELAY_MAX_MS', 3000),
  },
  // ---- Human pacing: delayed reads + a silent reading beat before typing (pacing.ts) ----
  pacing: {
    /** Idle gap (minutes) under which a message is read instantly — you're both in the chat. */
    thresholdMinutes: numberEnv('READ_DELAY_THRESHOLD', 3),
    /** Hard cap (seconds) on the read delay. */
    capSeconds: numberEnv('READ_DELAY_MAX', 15),
    /** Idle gap (minutes) at which the read delay reaches the cap (sqrt curve in between). */
    fullAtMinutes: numberEnv('READ_DELAY_FULL_AT', 130),
    /** Chance (0–1) a long-idle message is read in 2–3s anyway ("she had the phone in hand"). */
    instantChance: numberEnv('READ_DELAY_INSTANT_CHANCE', 0.15),
    /**
     * The silent read→typing pause: `base + textLength × perChar` ms, capped at `max` —
     * time spent reading the message before the typing indicator may appear.
     */
    pauseBaseMs: numberEnv('READ_PAUSE_BASE_MS', 400),
    pausePerCharMs: numberEnv('READ_PAUSE_PER_CHAR_MS', 25),
    pauseMaxMs: numberEnv('READ_PAUSE_MAX_MS', 2500),
  },
  // ---- Tavily web search (https://app.tavily.com) — powers the bot's web_search tool ----
  tavily: {
    /** API key (tvly-…). Absent ⇒ search is disabled and the tool is never offered. */
    apiKey: process.env.TAVILY_API_KEY?.trim() || undefined,
    /** Tavily API root. No trailing slash. */
    baseUrl: (process.env.TAVILY_BASE_URL ?? 'https://api.tavily.com').replace(/\/+$/, ''),
    /** 'basic' (1 credit) or 'advanced' (2 credits) — depth of crawl per query. */
    searchDepth: process.env.TAVILY_SEARCH_DEPTH ?? 'basic',
    /** How many result pages Tavily returns per query. */
    maxResults: numberEnv('TAVILY_MAX_RESULTS', 5),
    /** Snippets kept only as a fallback when Tavily returns no synthesized answer. */
    maxSources: numberEnv('TAVILY_MAX_SOURCES', 3),
    /** Max searches the model may run while answering one user message (anti-loop cap). */
    maxSearchesPerTurn: numberEnv('TAVILY_MAX_SEARCHES', 3),
    /** Per-request timeout (ms). */
    timeoutMs: numberEnv('TAVILY_TIMEOUT_MS', 15_000),
  },
  // ---- Proactive messaging — the bot initiating conversation on its own ----
  proactive: {
    /** Master switch. When false, the scheduler never starts (bot stays purely reactive). */
    enabled: boolEnv('PROACTIVE_ENABLED', false),
    /** Active window (local hours): the bot may only initiate while start ≤ hour < end. */
    windowStartHour: numberEnv('PROACTIVE_WINDOW_START', 7),
    windowEndHour: numberEnv('PROACTIVE_WINDOW_END', 23),
    /** The good-morning opener fires once at a random time within this hour range. */
    morningStartHour: numberEnv('PROACTIVE_MORNING_START', 7),
    morningEndHour: numberEnv('PROACTIVE_MORNING_END', 8),
    /**
     * Base daytime gap: the first reach-out comes a random number of minutes in this range
     * after the user goes quiet. Each *unanswered* reach-out then adds `escalationStepMinutes`
     * to the next gap (so they thin out the longer she's ignored).
     */
    silenceMinMinutes: numberEnv('PROACTIVE_SILENCE_MIN', 45),
    silenceMaxMinutes: numberEnv('PROACTIVE_SILENCE_MAX', 180),
    /**
     * Right-skew exponent for the base gap pick. The gap is `min + span * random()**skew`:
     * skew = 1 is flat/uniform; skew > 1 clusters gaps toward the short end with a long tail
     * toward the max (so she usually pings within a couple hours but sometimes leaves you alone
     * much longer — burstier and less learnable than a fixed band). Default 2.
     */
    silenceSkew: numberEnv('PROACTIVE_SILENCE_SKEW', 2),
    /** Minutes added to the gap per already-ignored reach-out (the escalation step). */
    escalationStepMinutes: numberEnv('PROACTIVE_ESCALATION_STEP', 60),
    /**
     * Cap on consecutive ignored reach-outs. Once hit, the bot goes fully silent — no more
     * openers, not even the next morning's greeting — until the user replies (which resets it).
     */
    maxIgnored: numberEnv('PROACTIVE_MAX_IGNORED', 8),
    /**
     * How often the scheduler evaluates each chat (ms). Default 1 min — fine enough granularity
     * for the reach-out gaps; the tick is cheap (a DB read, no LLM call).
     */
    tickMs: numberEnv('PROACTIVE_TICK_MS', 60_000),
  },
  // ---- Long-term memory: nightly per-day summaries appended to the system prompt ----
  summary: {
    /**
     * Master switch. Also requires `OPENROUTER_API_KEY` — summaries always run through
     * OpenRouter (full context, always reachable), independent of the active chat provider.
     */
    enabled: boolEnv('SUMMARY_ENABLED', false),
    /** Model slug used only for summaries. Default: the cheapest faithful summarizer we tested. */
    model: process.env.SUMMARY_MODEL ?? 'google/gemini-2.5-flash-lite',
    /** App-owned summarizer system prompt (first-person diary voice). */
    promptPath: process.env.SUMMARY_PROMPT_PATH ?? 'prompts/summary.txt',
    /** A logical day is only summarized when it holds MORE than this many non-deleted messages. */
    minMessages: numberEnv('SUMMARY_MIN_MESSAGES', 10),
    /** How many of the newest daily summaries are injected into the system prompt. */
    maxKept: numberEnv('SUMMARY_MAX_KEPT', 7),
    /**
     * Logical-day boundary (local hour, 0-23): a "day" runs cutoff→cutoff, so a late-night
     * session that crosses midnight stays in one summary. Default 3am.
     */
    cutoffHour: numberEnv('SUMMARY_CUTOFF_HOUR', 3),
    /** How often the scheduler checks for a completed, un-summarized day (ms). Default 10 min. */
    tickMs: numberEnv('SUMMARY_TICK_MS', 600_000),
    /** Low — summaries should be faithful, not creative. */
    temperature: numberEnv('SUMMARY_TEMPERATURE', 0.3),
    /** Hard cap on a summary's length. */
    maxTokens: numberEnv('SUMMARY_MAX_TOKENS', 400),
    /** Per-request timeout (ms). */
    timeoutMs: numberEnv('SUMMARY_TIMEOUT_MS', 60_000),
  },
} as const;

if (!Number.isInteger(config.apiId)) {
  throw new Error('API_ID must be a valid integer');
}

/** Returns true if the given user ID is allowed to interact with the bot. */
export function isWhitelisted(userId: number): boolean {
  return config.whitelist.has(userId);
}
