/**
 * Tavily web search — the backend for the model's `web_search` tool. Tavily is an
 * AI-native search API: one POST returns a synthesized `answer` plus cleaned, relevant
 * page snippets (no HTML), so no separate extraction LLM pass is needed. We distill the
 * response into a compact, model-readable summary that gets stored against the user's
 * message and injected into the context window (see {@link saveSearch}).
 */
import { config } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('search');
const cfg = config.tavily;

/** Whether search is usable at all (an API key is configured). */
export function isSearchConfigured(): boolean {
  return Boolean(cfg.apiKey);
}

/** One result page from Tavily's `results` array (the fields we use). */
interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
}

interface TavilySearchResponse {
  answer?: string | null;
  results?: TavilyResult[];
}

/** Trims a snippet to a sane length so a single source can't dominate the summary. */
function clip(text: string, max = 280): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Runs one web search and returns a distilled, model-readable summary string. Tavily's
 * synthesized `answer` is used on its own when present — it's clean and self-contained,
 * and the companion never cites sources, so the raw result list would just add noisy,
 * persisted tokens (login walls, video metadata, etc.). Only when there's no answer do we
 * fall back to the top cleaned snippets. Throws on a transport/HTTP error; never empty.
 */
export async function webSearch(query: string): Promise<string> {
  if (!cfg.apiKey) throw new Error('Tavily not configured');

  const res = await fetch(`${cfg.baseUrl}/search`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.apiKey}`,
    },
    signal: AbortSignal.timeout(cfg.timeoutMs),
    body: JSON.stringify({
      query,
      search_depth: cfg.searchDepth,
      include_answer: 'advanced',
      max_results: cfg.maxResults,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Tavily HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as TavilySearchResponse;
  const answer = data.answer?.trim();
  if (answer) return answer;

  // No synthesized answer — fall back to the top cleaned snippets (with a host label for
  // a little provenance), since there's nothing else to ground the reply on.
  const fallback = (data.results ?? [])
    .slice(0, cfg.maxSources)
    .map((r) => {
      const host = r.url ? r.url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0] : '';
      const snippet = r.content ? clip(r.content) : '';
      return snippet ? `- ${host ? `${host}: ` : ''}${snippet}` : '';
    })
    .filter(Boolean)
    .join('\n');

  return fallback.trim() || 'no relevant results found.';
}

// ---- Usage / status (for /status) ----

/** Account usage snapshot from GET /usage, for `/status`. */
export interface SearchUsage {
  /** Plan name, e.g. "Researcher". */
  plan: string | null;
  /** Credits used this billing period. */
  used: number | null;
  /** Plan credit allowance. */
  limit: number | null;
}

let usageCache: { at: number; usage: SearchUsage | null } | null = null;
const USAGE_TTL_MS = 60_000;

/** Fetches Tavily account usage (cached 60s). Returns null on any error. Never throws. */
export async function getSearchUsage(): Promise<SearchUsage | null> {
  if (!cfg.apiKey) return null;
  if (usageCache && Date.now() - usageCache.at < USAGE_TTL_MS) return usageCache.usage;
  try {
    const res = await fetch(`${cfg.baseUrl}/usage`, {
      headers: { authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      usageCache = { at: Date.now(), usage: null };
      return null;
    }
    const data = (await res.json()) as {
      account?: { current_plan?: string; plan_usage?: number; plan_limit?: number };
    };
    const a = data.account ?? {};
    const usage: SearchUsage = {
      plan: a.current_plan ?? null,
      used: a.plan_usage ?? null,
      limit: a.plan_limit ?? null,
    };
    usageCache = { at: Date.now(), usage };
    return usage;
  } catch (err) {
    log.debug('Tavily usage fetch failed:', err);
    return null;
  }
}
