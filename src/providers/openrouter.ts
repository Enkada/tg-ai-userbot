/**
 * OpenRouter provider — the cloud fallback used when the local llama.cpp server is
 * offline. OpenRouter is OpenAI-compatible, so the chat/caption calls reuse the shared
 * helper; the extras are Bearer auth + ranking headers, per-model metadata from /models
 * (context length, vision), key usage/limits from /key, and a tokenizer-based estimate
 * for token counting (OpenRouter has no tokenize endpoint).
 */
import { encode } from 'gpt-tokenizer';
import { fetch } from 'undici';
import { config } from '../config.js';
import { getOpenRouterDispatcher } from './proxyAgent.js';
import {
  type LlmProvider,
  type ProviderStatus,
  captionMessages,
  openaiChatCompletionStream,
  withSystem,
} from './types.js';

const cfg = config.llm.openrouter;
const gen = config.llm;
const CHAT_URL = `${cfg.baseUrl}/chat/completions`;
/** Optional proxy for OpenRouter's calls (see {@link getOpenRouterDispatcher}); undefined ⇒ direct. */
const dispatcher = getOpenRouterDispatcher();

/**
 * Upstream provider routing (the `provider` request field). `order` lists preferred
 * providers tried first in sequence; with `allow_fallbacks` true, OpenRouter then routes
 * to the rest if none are available. Returns undefined when no preference is configured,
 * so we send no `provider` field and get OpenRouter's default routing. Built once — config
 * is static.
 */
function buildProviderRouting(): Record<string, unknown> | undefined {
  const hasPreference = cfg.providerOrder.length > 0 || Boolean(cfg.providerSort);
  if (!hasPreference) return undefined;
  const routing: Record<string, unknown> = { allow_fallbacks: cfg.allowFallbacks };
  if (cfg.providerOrder.length) routing.order = cfg.providerOrder;
  if (cfg.providerSort) routing.sort = cfg.providerSort;
  return routing;
}

const PROVIDER_ROUTING = buildProviderRouting();

/**
 * Extra request body for every OpenRouter call:
 * - `reasoning.enabled: false` — OpenRouter has no llama `enable_thinking` kwarg; this is
 *   its unified way to turn off chain-of-thought, keeping replies in the standard `content`
 *   field and not burning `max_tokens` on hidden reasoning.
 * - `provider` — upstream routing preference (omitted when none is configured).
 */
const EXTRA_BODY: Record<string, unknown> = {
  reasoning: { enabled: false },
  ...(PROVIDER_ROUTING ? { provider: PROVIDER_ROUTING } : {}),
};

/** Headers for every OpenRouter call: Bearer auth plus optional app-ranking headers. */
function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${cfg.apiKey ?? ''}` };
  if (cfg.appUrl) headers['HTTP-Referer'] = cfg.appUrl;
  if (cfg.appName) headers['X-Title'] = cfg.appName;
  return headers;
}

// ---- Cached metadata lookups ----
// status()/getVisionSupport are hit per photo and per /status; cache to avoid hammering.

/**
 * Usage/limits as returned by GET /key (`.data`). Note: the API's `rate_limit` field is
 * deprecated (returns `requests: -1`), so it's intentionally not modelled here.
 */
export interface KeyInfo {
  label?: string;
  /** Credits spent so far, all-time (USD). */
  usage?: number;
  /** Credits spent today / this week / this month (USD). */
  usage_daily?: number;
  usage_weekly?: number;
  usage_monthly?: number;
  /** Hard credit limit (USD), or null for none. */
  limit?: number | null;
  /** Remaining credits (USD), or null when there's no limit. */
  limit_remaining?: number | null;
  is_free_tier?: boolean;
}

/** Per-model facts pulled from GET /models for the configured slug. */
export interface ModelInfo {
  contextLength: number | null;
  vision: boolean;
  /** True when every price field is "0" (a free model). */
  free: boolean;
}

let keyCache: { at: number; info: KeyInfo | null } | null = null;
let modelCache: { at: number; info: ModelInfo | null } | null = null;
const KEY_TTL_MS = 60_000;
const MODELS_TTL_MS = 5 * 60_000;

async function fetchKeyInfo(): Promise<KeyInfo | null> {
  if (!cfg.apiKey) return null;
  if (keyCache && Date.now() - keyCache.at < KEY_TTL_MS) return keyCache.info;
  try {
    const res = await fetch(`${cfg.baseUrl}/key`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(5000),
      dispatcher,
    });
    const info = res.ok ? ((await res.json()) as { data?: KeyInfo }).data ?? null : null;
    keyCache = { at: Date.now(), info };
    return info;
  } catch {
    return null;
  }
}

async function fetchModelInfo(): Promise<ModelInfo | null> {
  if (!cfg.apiKey) return null;
  if (modelCache && Date.now() - modelCache.at < MODELS_TTL_MS) return modelCache.info;
  try {
    const res = await fetch(`${cfg.baseUrl}/models`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(5000),
      dispatcher,
    });
    if (!res.ok) {
      modelCache = { at: Date.now(), info: null };
      return null;
    }
    const data = (await res.json()) as {
      data?: {
        id?: string;
        context_length?: number;
        architecture?: { input_modalities?: string[] };
        top_provider?: { context_length?: number };
        pricing?: Record<string, string>;
      }[];
    };
    const m = data.data?.find((x) => x.id === cfg.model);
    const info: ModelInfo | null = m
      ? {
          contextLength: m.context_length ?? m.top_provider?.context_length ?? null,
          vision: Array.isArray(m.architecture?.input_modalities)
            ? m.architecture.input_modalities.includes('image')
            : false,
          free: m.pricing
            ? Object.values(m.pricing).every((p) => Number(p) === 0)
            : cfg.model.endsWith(':free'),
        }
      : null;
    modelCache = { at: Date.now(), info };
    return info;
  } catch {
    return null;
  }
}

export const openRouter: LlmProvider = {
  id: 'openrouter',
  label: 'OpenRouter (cloud)',

  isConfigured: () => Boolean(cfg.apiKey),

  async chat(systemPrompt, history, onToken) {
    return openaiChatCompletionStream({
      url: CHAT_URL,
      headers: authHeaders(),
      model: cfg.model,
      messages: withSystem(systemPrompt, history),
      temperature: gen.temperature,
      topP: gen.topP,
      minP: gen.minP,
      presencePenalty: gen.presencePenalty,
      frequencyPenalty: gen.frequencyPenalty,
      maxTokens: gen.maxTokens,
      timeoutMs: gen.timeoutMs,
      extraBody: EXTRA_BODY,
      label: 'OpenRouter',
      onToken,
      dispatcher,
    });
  },

  async describeImage(base64, mime = 'image/jpeg') {
    // No sink: the SSE stream is just collected into the full caption.
    const { content: caption } = await openaiChatCompletionStream({
      url: CHAT_URL,
      headers: authHeaders(),
      model: cfg.model,
      messages: captionMessages(base64, mime),
      temperature: gen.captionTemperature,
      maxTokens: gen.captionMaxTokens,
      timeoutMs: gen.timeoutMs,
      extraBody: EXTRA_BODY,
      label: 'OpenRouter caption',
      dispatcher,
    });
    return caption.replace(/\s*\n+\s*/g, ' ');
  },

  async status(): Promise<ProviderStatus> {
    if (!cfg.apiKey) return { online: false, model: null, vision: false };
    // Reachable + key valid ⇒ online. Vision comes from the model's metadata.
    const [key, model] = await Promise.all([fetchKeyInfo(), fetchModelInfo()]);
    return {
      online: key !== null,
      model: key !== null ? cfg.model : null,
      vision: model?.vision ?? false,
    };
  },

  async getMaxContext(): Promise<number | null> {
    return (await fetchModelInfo())?.contextLength ?? null;
  },

  /**
   * Approximate prompt-token count. OpenRouter has no tokenize endpoint, so this uses a
   * GPT tokenizer (gpt-tokenizer) as a proxy — not exact for Gemma's tokenizer, but close
   * enough for a usage gauge. The `+4` per message is the usual role/format overhead.
   */
  async countContextTokens(systemPrompt, history): Promise<number> {
    const messages = withSystem(systemPrompt, history);
    let tokens = 0;
    for (const m of messages) tokens += encode(m.content).length + 4;
    return tokens;
  },
};

/** Whether the dedicated OpenRouter caption fallback is available (key + CAPTION_MODEL set). */
export function isCaptionConfigured(): boolean {
  return Boolean(cfg.apiKey && gen.captionModel);
}

/**
 * Dedicated image-captioning call, used as the vision fallback when the *active* chat model
 * can't see images (see {@link import('../llm.js').describeImage}). Like {@link summarize}, it
 * targets its own slug ({@link config.llm.captionModel}, not the chat one), is non-streaming,
 * and omits the chat path's upstream {@link PROVIDER_ROUTING} (that order is tuned for the Gemma
 * chat model and would mis-route a vision model). Throws if key or CAPTION_MODEL is missing.
 */
export async function captionImage(base64: string, mime = 'image/jpeg'): Promise<string> {
  if (!cfg.apiKey || !gen.captionModel) {
    throw new Error('Caption fallback requires OpenRouter (OPENROUTER_API_KEY) and CAPTION_MODEL');
  }
  const { content: caption } = await openaiChatCompletionStream({
    url: CHAT_URL,
    headers: authHeaders(),
    model: gen.captionModel,
    messages: captionMessages(base64, mime),
    temperature: gen.captionTemperature,
    maxTokens: gen.captionMaxTokens,
    timeoutMs: gen.timeoutMs,
    extraBody: { reasoning: { enabled: false } },
    label: 'OpenRouter caption (fallback)',
    dispatcher,
  });
  return caption.replace(/\s*\n+\s*/g, ' ');
}

/**
 * One-shot summarization call, used by the long-term-memory scheduler. Deliberately separate
 * from {@link openRouter.chat}: it targets a dedicated model ({@link config.summary.model}, not
 * the chat slug), is non-streaming, carries no `web_search` tools, and — crucially — omits the
 * chat path's upstream {@link PROVIDER_ROUTING} (that order is tuned for the Gemma chat model and
 * would mis-route the summarizer). Throws if OpenRouter isn't configured or the call fails.
 */
export async function summarize(systemPrompt: string, transcript: string): Promise<string> {
  if (!cfg.apiKey) throw new Error('Summary requires OpenRouter (OPENROUTER_API_KEY is missing)');
  const { content } = await openaiChatCompletionStream({
    url: CHAT_URL,
    headers: authHeaders(),
    model: config.summary.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: transcript },
    ],
    temperature: config.summary.temperature,
    maxTokens: config.summary.maxTokens,
    timeoutMs: config.summary.timeoutMs,
    extraBody: { reasoning: { enabled: false } },
    label: 'Summary',
    dispatcher,
  });
  return content;
}

/** The active upstream routing preference, as configured. */
export interface RoutingInfo {
  order: string[];
  sort: string | undefined;
  allowFallbacks: boolean;
}

/** Combined snapshot for the `/openrouter` command. Never throws. */
export async function getOpenRouterInfo(): Promise<{
  configured: boolean;
  model: string;
  key: KeyInfo | null;
  modelInfo: ModelInfo | null;
  routing: RoutingInfo;
}> {
  const routing: RoutingInfo = {
    order: cfg.providerOrder,
    sort: cfg.providerSort,
    allowFallbacks: cfg.allowFallbacks,
  };
  const configured = Boolean(cfg.apiKey);
  if (!configured) return { configured, model: cfg.model, key: null, modelInfo: null, routing };
  const [key, modelInfo] = await Promise.all([fetchKeyInfo(), fetchModelInfo()]);
  return { configured, model: cfg.model, key, modelInfo, routing };
}
