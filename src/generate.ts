/**
 * Reply generation with the model's `web_search` tool loop, in one place.
 *
 * The control flow is identical wherever the bot generates a reply — issue a completion,
 * and while the model answers with a `<tool_call>` for `web_search`, run the search, feed
 * the result back, and ask again, up to a per-turn cap (anti-loop). Only *two* things differ
 * between callers, captured by {@link ToolLoopStrategy}:
 *
 *  - **reactive** (an incoming user message): the search is persisted against the user's
 *    message row, and each follow-up call rebuilds the window from the DB — so the search
 *    result enters long-term context like any other turn. See {@link persistedSearchStrategy}.
 *  - **proactive** (a bot-initiated opener): the trigger is an ephemeral "reach out first"
 *    cue that is deliberately never stored, so it has no row to hang a search on. The search
 *    is kept in memory and appended to the cue for the next call only; nothing is persisted
 *    except the final opener text the caller sends. See {@link ephemeralSearchStrategy}.
 *
 * Keeping the loop here means the search cap, parsing, logging, and error handling live once.
 */
import { config } from './config.js';
import { createLogger } from './logger.js';
import { chat, type ChatMessage, type ChatResult } from './llm.js';
import { getWindow, saveSearch, withSearches, type SearchEntry } from './memory.js';
import { isSearchConfigured, webSearch } from './search.js';
import { parseToolCall } from './tools.js';

const log = createLogger('generate');

/**
 * The two caller-specific seams of the tool loop: how to assemble the history for the next
 * model call (reflecting every search recorded so far), and how to record a completed search.
 */
export interface ToolLoopStrategy {
  /** History (system prompt is added separately) for the next `chat` call. */
  buildHistory(): ChatMessage[];
  /** Record one finished search at 0-based position `idx`, so the next {@link buildHistory} includes it. */
  recordSearch(idx: number, query: string, summary: string): void;
}

/**
 * Generates a reply, running the model's `web_search` tool calls in a loop. The first call
 * is the normal reply; if its output is a `<tool_call>`, the search runs, the strategy
 * records it, and the model is asked again — now grounded — until it answers in prose or the
 * per-turn cap is hit. When search is unconfigured there are no tools, so this is one call.
 * `label` is a short context tag for log lines (e.g. `chat 42`, `proactive chat 42`).
 */
export async function generateReply(
  systemPrompt: string,
  strategy: ToolLoopStrategy,
  label: string,
): Promise<ChatResult> {
  let result = await chat(systemPrompt, strategy.buildHistory());
  if (!isSearchConfigured()) return result;

  const max = config.tavily.maxSearchesPerTurn;
  for (let searchCount = 0; searchCount < max; searchCount++) {
    const call = parseToolCall(result.content);
    if (!call || call.name !== 'web_search') break;
    const query = String(call.arguments.query ?? '').trim();
    if (!query) break;

    let summary: string;
    try {
      summary = await webSearch(query);
      log.info(`Web search ${searchCount + 1}/${max} for ${label}: ${query}`);
    } catch (err) {
      log.error('Web search failed:', err);
      summary = 'search failed — no results available right now.';
    }
    strategy.recordSearch(searchCount, query, summary);
    result = await chat(systemPrompt, strategy.buildHistory());
  }
  return result;
}

/**
 * Reactive strategy: persist each search against the triggering user message (`userRowId`)
 * and rebuild the window from the DB, so the result is injected as a `[web search …]` block
 * on that turn and carried into future context.
 */
export function persistedSearchStrategy(chatId: number, userRowId: number): ToolLoopStrategy {
  return {
    buildHistory: () => getWindow(chatId),
    recordSearch: (idx, query, summary) => saveSearch(userRowId, idx, query, summary),
  };
}

/**
 * Proactive strategy: hold searches in memory and append them to the ephemeral opener `cue`
 * for the next call only. Nothing is persisted — the cue must not leak into stored context
 * (it would corrupt the user-activity timer and plant a phantom user turn), so neither may a
 * search hung off it. The final opener text the caller sends is what gets remembered.
 */
export function ephemeralSearchStrategy(chatId: number, cue: string): ToolLoopStrategy {
  const searches: SearchEntry[] = [];
  return {
    buildHistory: () => [
      ...getWindow(chatId),
      { role: 'user', content: withSearches(cue, searches) },
    ],
    recordSearch: (_idx, query, summary) => {
      searches.push({ query, summary });
    },
  };
}
