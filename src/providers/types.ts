/**
 * Shared, provider-agnostic core for the LLM layer: the message types and history
 * helpers, the provider interface every backend implements, and a single
 * OpenAI-compatible chat-completion call used by both llama.cpp and OpenRouter
 * (they differ only in URL, auth headers, and a few body fields).
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Collapses runs of consecutive same-role messages into one, joining their text with
 * a blank line. Chat templates (ChatML, Llama, Mistral, …) assume strictly alternating
 * user/assistant turns — two `user` objects in a row makes some templates throw and
 * leads others to emit malformed prompts. Merging keeps the turn structure valid while
 * preserving every message's text. Reads as one person sending two bubbles in a row.
 */
export function mergeConsecutive(history: ChatMessage[]): ChatMessage[] {
  const merged: ChatMessage[] = [];
  for (const m of history) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) {
      prev.content = `${prev.content}\n\n${m.content}`;
    } else {
      merged.push({ ...m });
    }
  }
  return merged;
}

/** Prepends the (already-rendered) system prompt to a conversation history. */
export function withSystem(systemPrompt: string, history: ChatMessage[]): ChatMessage[] {
  return [{ role: 'system', content: systemPrompt }, ...mergeConsecutive(history)];
}

/** The exact message array (system prompt + history) that is sent to the model. */
export function buildMessages(systemPrompt: string, history: ChatMessage[]): ChatMessage[] {
  return withSystem(systemPrompt, history);
}

/** Identifier of an LLM backend. */
export type ProviderId = 'llamacpp' | 'openrouter';

/** A chat completion plus the model that actually served it (from the response). */
export interface ChatResult {
  content: string;
  /** Served model id echoed by the API, or null if the response omitted it. */
  model: string | null;
}

/** Live state of a provider, used by `/status`. */
export interface ProviderStatus {
  online: boolean;
  /** The model the provider would use, or null when offline/unknown. */
  model: string | null;
  /** Whether that model accepts image input. */
  vision: boolean;
}

/** Common surface every LLM backend exposes. The facade in `llm.ts` picks one. */
export interface LlmProvider {
  readonly id: ProviderId;
  /** Human-readable label for `/status`, e.g. "llama.cpp (local)". */
  readonly label: string;
  /** Whether this provider is usable at all (e.g. OpenRouter needs an API key). */
  isConfigured(): boolean;
  /** Single chat completion (no streaming). `systemPrompt` is already rendered. */
  chat(systemPrompt: string, history: ChatMessage[]): Promise<ChatResult>;
  /** One vision pass over an image, returning a concise one-line caption. */
  describeImage(base64: string, mime?: string): Promise<string>;
  /** Reachability + current model + vision. Never throws. */
  status(): Promise<ProviderStatus>;
  /** Max context window (n_ctx / model context_length), or null if unknown. */
  getMaxContext(): Promise<number | null>;
  /** Prompt-token count for system + history. Exact for llama.cpp, an estimate elsewhere. */
  countContextTokens(systemPrompt: string, history: ChatMessage[]): Promise<number>;
}

/** A message as sent to an OpenAI-compatible API — `content` may be a string or parts array. */
interface OutboundMessage {
  role: string;
  content: unknown;
}

/**
 * Performs one OpenAI-compatible `/chat/completions` POST and returns the trimmed
 * assistant text. Both providers funnel through here; their differences are passed in:
 * `headers` (OpenRouter's `Authorization`/ranking headers) and `extraBody` (llama.cpp's
 * `chat_template_kwargs`, OpenRouter's `reasoning`). Returns the reply text plus the
 * model the API reports having served. Throws on a non-2xx or empty reply.
 */
export async function openaiChatCompletion(opts: {
  url: string;
  headers?: Record<string, string>;
  model: string;
  messages: OutboundMessage[];
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  extraBody?: Record<string, unknown>;
  /** Prefix for error messages, e.g. "LLM" or "Caption". */
  label?: string;
}): Promise<ChatResult> {
  const { url, headers, model, messages, temperature, maxTokens, timeoutMs, extraBody, label = 'LLM' } = opts;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    // Generation can legitimately take a while, but an unbounded fetch lets a hung
    // server wedge the chat's queue forever. Cap it generously; on timeout the caller
    // saves nothing and sends a fallback.
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      temperature,
      max_tokens: maxTokens,
      ...extraBody,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${label} HTTP ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    model?: string;
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error(`${label} returned an empty response`);
  }
  return { content, model: data.model ?? null };
}

/**
 * System prompt for the image-captioning pass. A neutral describer — NOT the companion
 * persona — kept terse on purpose. The `max_tokens` cap is the real backstop against
 * runaway descriptions; this just steers tone and content. Shared by all providers.
 */
export const CAPTION_SYSTEM_PROMPT =
  'You describe images. Given an image, reply with one or two concise sentences naming the ' +
  'main subject, the setting, and any prominent text or notable detail. No preamble, no ' +
  'markdown, no lists — just the description.';

/** Builds the OpenAI-standard vision user-turn (text + image data URI) for a caption pass. */
export function captionMessages(base64: string, mime: string): OutboundMessage[] {
  return [
    { role: 'system', content: CAPTION_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image concisely.' },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
      ],
    },
  ];
}
