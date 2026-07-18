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
import { isSelfieAvailable } from './selfie.js';
import { parseToolCall } from './tools.js';
import type { ReplyStreamer } from './send.js';

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
 *
 * When a {@link ReplyStreamer} is supplied it's threaded in as the token sink so prose is sent
 * to the chat as it generates. Each completion is a fresh pass ({@link ReplyStreamer.beginPass}),
 * so the streamer suppresses the intermediate tool-call passes and streams only the final prose.
 * The caller still gets the full {@link ChatResult} back to finalize and persist.
 *
 * An optional `signal` aborts the in-flight model call (each pass) — `/stop` uses it to cut a
 * runaway generation short; the aborted call rejects with an `AbortError` for the caller to handle.
 */
export async function generateReply(
  systemPrompt: string,
  strategy: ToolLoopStrategy,
  label: string,
  streamer?: ReplyStreamer,
  signal?: AbortSignal,
): Promise<ChatResult> {
  const run = (): Promise<ChatResult> => {
    streamer?.beginPass();
    return chat(systemPrompt, strategy.buildHistory(), streamer?.onToken, signal);
  };

  let result = await run();
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
    result = await run();
  }
  return result;
}

/**
 * Ephemeral format cue appended to the final user turn of every reactive generation (and
 * reroll). It rides the prompt *tail* because that's the only position that out-competes the
 * in-context pattern: the window carries ~30 of the bot's own recent replies, and once those
 * run long the top-of-prompt persona rule loses to them (measured drift: 2.7 → 5.7 avg
 * sentences over 583 replies, while the tail-cued proactive openers held at ~3.2 in the same
 * windows). This wording tested at 2-3 sentences on casual turns, stretching to ~5 on packed
 * ones and fully opening on an explicit ask, with 0/108 echo/acknowledgment. The numeric
 * ceiling ("up to 5") is load-bearing — an open-ended "take the room you need" variant blew
 * up to 17-sentence walls. Never stored: applied at history-build time only, so the DB,
 * summaries, and /dump stay clean.
 */
export const REPLY_FORMAT_CUE =
  '[System note: you text in short bursts - answer in 1-3 casual sentences, single paragraph. ' +
  'If there is genuinely a lot to respond to, up to 5, never a wall of text. ' +
  'Longer only when explicitly requested.]';

/**
 * Extra tail-cue sentence appended while the selfie tool is offered. Once a photo turn
 * enters the window as a `[you sent a photo: …]` block, the model starts imitating that
 * block instead of calling the tool (measured 3/8 on the prod transcript that surfaced it).
 * A rule inside the selfie prompt section did nothing (3/8 imitation unchanged) — only the
 * tail position beats the in-context pattern, exactly like the reply-length cue: 0/8
 * imitation with this sentence riding REPLY_FORMAT_CUE (2026-07-19).
 */
export const SELFIE_FORMAT_CUE =
  ' Bracketed [...] lines in the chat are system records - never write one yourself; ' +
  'to send a picture, output the send_selfie tool call.';

/**
 * Returns `history` with {@link REPLY_FORMAT_CUE} appended to the trailing user turn — after
 * the photo/search blocks getWindow already composed into it. No-op when the last turn isn't
 * a user message. Proactive openers never pass through here: their director cue carries its
 * own "keep it short", and stacking both would double-cue the turn.
 */
export function withReplyCue(history: ChatMessage[]): ChatMessage[] {
  const last = history[history.length - 1];
  if (!last || last.role !== 'user') return history;
  // The selfie sentence joins the cue only while the tool is actually offered — otherwise
  // it would instruct the model to call a tool that isn't in its list.
  const cue = isSelfieAvailable()
    ? `${REPLY_FORMAT_CUE.slice(0, -1)}${SELFIE_FORMAT_CUE}]`
    : REPLY_FORMAT_CUE;
  return [...history.slice(0, -1), { role: 'user', content: `${last.content}\n${cue}` }];
}

/**
 * Reactive strategy: persist each search against the triggering user message (`userRowId`)
 * and rebuild the window from the DB, so the result is injected as a `[you already searched
 * the web …]` block on that turn and carried into future context. The rebuilt window gets
 * the format cue on its final user turn (see {@link REPLY_FORMAT_CUE}).
 */
export function persistedSearchStrategy(chatId: number, userRowId: number): ToolLoopStrategy {
  return {
    buildHistory: () => withReplyCue(getWindow(chatId)),
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
