/**
 * LLM facade. Selects a provider once at startup (local llama.cpp if reachable, else
 * OpenRouter when configured) and re-exports the same function surface the rest of the
 * app already imports, delegating each call to the active provider. Callers keep
 * importing from `./llm.js` and need no changes.
 */
import { createLogger } from './logger.js';
import { llamaCpp } from './providers/llamacpp.js';
import { openRouter } from './providers/openrouter.js';
import type { ChatMessage, ChatResult, LlmProvider, ProviderId, ProviderStatus, TokenSink } from './providers/types.js';

export type { ChatMessage, ChatResult, TokenSink } from './providers/types.js';
export { getOpenRouterInfo } from './providers/openrouter.js';

const log = createLogger('llm');

/** The chosen backend. Defaults to local until {@link initProvider} runs at startup. */
let active: LlmProvider = llamaCpp;

/**
 * Picks the active provider once, at startup (per design: no mid-session re-probe).
 * Prefers the local server when it's reachable; otherwise falls back to OpenRouter if an
 * API key is configured. If neither is available, stays on local so `/status` reports it
 * offline and chat attempts surface the usual "couldn't reach the model" error.
 */
export async function initProvider(): Promise<LlmProvider> {
  const localOnline = (await llamaCpp.status()).online;
  if (localOnline) {
    active = llamaCpp;
  } else if (openRouter.isConfigured()) {
    active = openRouter;
    log.info('Local LLM offline — falling back to OpenRouter.');
  } else {
    active = llamaCpp;
    log.warn('Local LLM offline and OpenRouter not configured — no LLM available.');
  }
  log.info(`Active LLM provider: ${active.label}`);
  return active;
}

/** Id of the currently active provider (e.g. for `/context` to mark estimates). */
export function activeProviderId(): ProviderId {
  return active.id;
}

export const chat = (
  systemPrompt: string,
  history: ChatMessage[],
  onToken?: TokenSink,
): Promise<ChatResult> => active.chat(systemPrompt, history, onToken);

export const describeImage = (base64: string, mime?: string): Promise<string> =>
  active.describeImage(base64, mime);

export const getMaxContext = (): Promise<number | null> => active.getMaxContext();

export const countContextTokens = (systemPrompt: string, history: ChatMessage[]): Promise<number> =>
  active.countContextTokens(systemPrompt, history);

/** Whether the active provider's model accepts image input. */
export async function getVisionSupport(): Promise<boolean> {
  return (await active.status()).vision;
}

export interface LlmStatus extends ProviderStatus {}

/** Status of the active provider (used by `/status`). Never throws. */
export async function getLlmStatus(): Promise<LlmStatus> {
  return active.status();
}

/** One provider's row for the `/status` overview. */
export interface ProviderRow extends ProviderStatus {
  id: ProviderId;
  label: string;
  configured: boolean;
  active: boolean;
}

/** Probes both providers for `/status`. The active one is marked. Never throws. */
export async function getProvidersOverview(): Promise<ProviderRow[]> {
  const build = async (p: LlmProvider): Promise<ProviderRow> => {
    const status = p.isConfigured()
      ? await p.status()
      : { online: false, model: null, vision: false };
    return {
      id: p.id,
      label: p.label,
      configured: p.isConfigured(),
      active: p.id === active.id,
      ...status,
    };
  };
  return Promise.all([build(llamaCpp), build(openRouter)]);
}
