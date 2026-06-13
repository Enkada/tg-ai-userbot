/**
 * Local llama.cpp provider — the primary backend. Talks to the server's
 * OpenAI-compatible endpoints plus a few llama.cpp-only ones (`/props`,
 * `/apply-template`, `/tokenize`) for exact token accounting and vision detection.
 */
import { config } from '../config.js';
import {
  type ChatMessage,
  type LlmProvider,
  type ProviderStatus,
  captionMessages,
  openaiChatCompletion,
  withSystem,
} from './types.js';

const cfg = config.llm.local;
const gen = config.llm;
const CHAT_URL = `${cfg.baseUrl}/v1/chat/completions`;

/**
 * llama.cpp (and reasoning models like Gemma) emit a `<think>` block that the server
 * parses into `reasoning_content`, leaving the OpenAI-standard `content` empty until the
 * reasoning finishes — and the reasoning routinely eats the whole `max_tokens` budget,
 * yielding an empty reply. This companion bot needs no chain-of-thought, so disable it via
 * the template's `enable_thinking` kwarg.
 */
const REASONING_OFF = { chat_template_kwargs: { enable_thinking: false } } as const;

/**
 * Whether the loaded model accepts image input — i.e. llama.cpp was started with an
 * `--mmproj` projector. Read from /props `modalities.vision`; any failure yields `false`.
 */
async function getVisionSupport(): Promise<boolean> {
  try {
    const res = await fetch(`${cfg.baseUrl}/props`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const data = (await res.json()) as { modalities?: { vision?: boolean } };
    return data.modalities?.vision === true;
  } catch {
    return false;
  }
}

export const llamaCpp: LlmProvider = {
  id: 'llamacpp',
  label: 'llama.cpp (local)',

  // Local server is always "configured"; whether it's reachable is what status() reports.
  isConfigured: () => true,

  async chat(systemPrompt, history) {
    return openaiChatCompletion({
      url: CHAT_URL,
      model: cfg.model,
      messages: withSystem(systemPrompt, history),
      temperature: gen.temperature,
      maxTokens: gen.maxTokens,
      timeoutMs: gen.timeoutMs,
      extraBody: REASONING_OFF,
      label: 'LLM',
    });
  },

  async describeImage(base64, mime = 'image/jpeg') {
    const { content: caption } = await openaiChatCompletion({
      url: CHAT_URL,
      model: cfg.model,
      messages: captionMessages(base64, mime),
      temperature: gen.captionTemperature,
      maxTokens: gen.captionMaxTokens,
      timeoutMs: gen.timeoutMs,
      extraBody: REASONING_OFF,
      label: 'Caption',
    });
    // Collapse newlines — a caption is a single inline block inside `[image: …]`.
    return caption.replace(/\s*\n+\s*/g, ' ');
  },

  async status(): Promise<ProviderStatus> {
    try {
      const res = await fetch(`${cfg.baseUrl}/v1/models`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return { online: false, model: null, vision: false };
      const data = (await res.json()) as { data?: { id?: string }[] };
      const vision = await getVisionSupport();
      return { online: true, model: data.data?.[0]?.id ?? null, vision };
    } catch {
      return { online: false, model: null, vision: false };
    }
  },

  async getMaxContext(): Promise<number | null> {
    try {
      const res = await fetch(`${cfg.baseUrl}/props`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return null;
      const data = (await res.json()) as { default_generation_settings?: { n_ctx?: number } };
      return data.default_generation_settings?.n_ctx ?? null;
    } catch {
      return null;
    }
  },

  /**
   * Exact prompt-token count using the server's own chat template (/apply-template)
   * and tokenizer (/tokenize).
   */
  async countContextTokens(systemPrompt, history): Promise<number> {
    const messages = withSystem(systemPrompt, history);

    const tplRes = await fetch(`${cfg.baseUrl}/apply-template`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages }),
      signal: AbortSignal.timeout(5000),
    });
    if (!tplRes.ok) throw new Error(`apply-template HTTP ${tplRes.status}`);
    const { prompt } = (await tplRes.json()) as { prompt: string };

    const tokRes = await fetch(`${cfg.baseUrl}/tokenize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: prompt }),
      signal: AbortSignal.timeout(5000),
    });
    if (!tokRes.ok) throw new Error(`tokenize HTTP ${tokRes.status}`);
    const { tokens } = (await tokRes.json()) as { tokens: number[] };
    return tokens.length;
  },
};
