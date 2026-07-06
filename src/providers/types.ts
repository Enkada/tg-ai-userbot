/**
 * Shared, provider-agnostic core for the LLM layer: the message types and history
 * helpers, the provider interface every backend implements, and a single
 * OpenAI-compatible chat-completion call used by both llama.cpp and OpenRouter
 * (they differ only in URL, auth headers, and a few body fields).
 */
import { fetch as undiciFetch, type Dispatcher } from 'undici';

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

/** Identifier of an LLM backend. */
export type ProviderId = 'llamacpp' | 'openrouter';

/**
 * Per-token callback for streaming completions. Receives each content delta as it arrives;
 * may be async (the reply streamer awaits it to pace bubble sends), in which case the SSE
 * reader pauses until it settles. Omit it to consume a completion non-interactively.
 */
export type TokenSink = (delta: string) => void | Promise<void>;

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
  /**
   * One chat completion. Always streamed under the hood (SSE); pass `onToken` to receive
   * tokens as they arrive (the bot streams the reply as bubbles), or omit it to just collect
   * the full text. Returns the complete reply either way. `systemPrompt` is already rendered.
   */
  chat(systemPrompt: string, history: ChatMessage[], onToken?: TokenSink): Promise<ChatResult>;
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
 * Performs one OpenAI-compatible `/chat/completions` POST with `stream: true`, parses the
 * Server-Sent-Events response, and returns the trimmed assistant text plus the served model.
 * This is the *only* transport: callers that want tokens live (the reply streamer) pass an
 * `onToken` sink; callers that just need the final text (image captions, etc.) omit it and the
 * stream is simply collected. Both providers funnel through here; their differences are passed
 * in via `headers` (OpenRouter auth/ranking) and `extraBody` (llama.cpp's `chat_template_kwargs`,
 * OpenRouter's `reasoning`). Throws on a non-2xx or an empty reply.
 *
 * `onToken` may be async; it's awaited per delta, so a sink that paces bubble sends naturally
 * backpressures the read (tokens buffer at the socket while it sleeps). The `timeoutMs` abort
 * caps the whole exchange (generation + any sink delays) so a hung server can't wedge the queue.
 */
export async function openaiChatCompletionStream(opts: {
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
  /** Per-token sink; omit to collect the completion without streaming it anywhere. */
  onToken?: TokenSink;
  /** Undici dispatcher (e.g. a ProxyAgent) to route this call through. Omit to connect direct. */
  dispatcher?: Dispatcher;
}): Promise<ChatResult> {
  const { url, headers, model, messages, temperature, maxTokens, timeoutMs, extraBody, label = 'LLM', onToken, dispatcher } = opts;

  const fetchOpts = {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      temperature,
      max_tokens: maxTokens,
      ...extraBody,
    }),
  };
  // See the module-doc note above: a dispatcher requires undici's own fetch, not the global one.
  const res = dispatcher ? await undiciFetch(url, { ...fetchOpts, dispatcher }) : await fetch(url, fetchOpts);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${label} HTTP ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  if (!res.body) throw new Error(`${label} returned no response body`);

  let content = '';
  let servedModel: string | null = null;

  // Handle one SSE `data:` payload: accumulate the content delta and forward it to the sink.
  const handleData = async (data: string): Promise<void> => {
    if (data === '[DONE]') return;
    let parsed: {
      model?: string;
      choices?: { delta?: { content?: string } }[];
    };
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // ignore keep-alives / malformed lines
    }
    if (!servedModel && typeof parsed.model === 'string') servedModel = parsed.model;
    const delta = parsed.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta.length > 0) {
      content += delta;
      if (onToken) await onToken(delta);
    }
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        // Blank separators and SSE comments (": keep-alive") carry no data.
        if (line === '' || line.startsWith(':')) continue;
        if (line.startsWith('data:')) await handleData(line.slice(5).trim());
      }
    }
    // A final line may arrive without a trailing newline.
    const tail = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
    if (tail.startsWith('data:')) await handleData(tail.slice(5).trim());
  } finally {
    // Release the connection if we bailed early (e.g. the sink threw mid-stream); a no-op
    // once the body is fully read.
    reader.cancel().catch(() => {});
  }

  const trimmed = content.trim();
  if (!trimmed) throw new Error(`${label} returned an empty response`);
  return { content: trimmed, model: servedModel };
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
