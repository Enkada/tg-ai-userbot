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
  character: {
    /** Name substituted for the {{char}} tag in the system prompt. */
    name: process.env.CHAR_NAME ?? 'Sara',
  },
  llm: {
    /** Path to the system prompt file, relative to the project root. */
    systemPromptPath: process.env.SYSTEM_PROMPT_PATH ?? 'prompts/system.txt',
    // ---- Shared generation params (apply to whichever provider is active) ----
    temperature: numberEnv('LLM_TEMPERATURE', 0.7),
    maxTokens: numberEnv('LLM_MAX_TOKENS', 512),
    /** Hard cap on an image caption's length — the backstop against verbose descriptions. */
    captionMaxTokens: numberEnv('LLM_CAPTION_MAX_TOKENS', 150),
    /** Lower than chat temperature: captions should be factual, not creative. */
    captionTemperature: numberEnv('LLM_CAPTION_TEMPERATURE', 0.3),
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
    /** Daytime silence: re-check this many minutes (random in range) after the last activity. */
    silenceMinMinutes: numberEnv('PROACTIVE_SILENCE_MIN', 45),
    silenceMaxMinutes: numberEnv('PROACTIVE_SILENCE_MAX', 90),
    /** How often the scheduler evaluates each chat (ms). */
    tickMs: numberEnv('PROACTIVE_TICK_MS', 600_000),
    /** Max tokens for the yes/no gate completion (it answers a single word). */
    gateMaxTokens: numberEnv('PROACTIVE_GATE_MAX_TOKENS', 8),
    /** How many recent messages the gate sees when judging. */
    gateTranscriptDepth: numberEnv('PROACTIVE_GATE_DEPTH', 20),
    /** Path to the neutral evaluator prompt, relative to the project root. */
    gatePromptPath: process.env.PROACTIVE_GATE_PROMPT_PATH ?? 'prompts/proactive-gate.txt',
  },
} as const;

if (!Number.isInteger(config.apiId)) {
  throw new Error('API_ID must be a valid integer');
}

/** Returns true if the given user ID is allowed to interact with the bot. */
export function isWhitelisted(userId: number): boolean {
  return config.whitelist.has(userId);
}
