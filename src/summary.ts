/**
 * Long-term memory — nightly per-day summaries.
 *
 * Every conversation day is compressed, once it's over, into a short first-person diary entry
 * (Headline/Happened/Mood/Follow-ups) that {@link renderSystemPrompt} injects as a `# Memory`
 * block. The newest {@link config.summary.maxKept} entries stay live; older ones fall off (a
 * future weekly/monthly roll-up tier will fold them up — not built yet).
 *
 * A **logical day** runs from {@link config.summary.cutoffHour} to the same hour next day (default
 * 3am→3am, in the process timezone), so a late-night session that crosses midnight stays in one
 * entry instead of being bisected. A day is summarized only after it has fully ended and only if
 * it holds more than {@link config.summary.minMessages} messages.
 *
 * The scheduler is a plain interval (not tied to the proactive loop, and not run inside a chat's
 * message queue): it reads completed, immutable past days, so it can't race a live reply, and its
 * multi-second OpenRouter call must stay off the hot path. State lives in the DB
 * ({@link summaryState}) so it survives restarts and catches up on any day missed during downtime;
 * existing history before the feature is switched on is never back-filled.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { getCharName } from './settings.js';
import { createLogger } from './logger.js';
import { summarize } from './providers/openrouter.js';
import {
  getDayMessages,
  getSummaryState,
  messageCountInRange,
  saveSummary,
  setSummaryCursor,
  summaryExists,
} from './memory.js';

const log = createLogger('summary');

/** The app-owned summarizer system prompt, loaded once. */
const SUMMARY_TEMPLATE = readFileSync(resolve(process.cwd(), config.summary.promptPath), 'utf8').trim();

// ---- Logical-day arithmetic --------------------------------------------------------------

/**
 * Epoch ms of the start of the logical day containing `ms` — i.e. the most recent
 * `cutoffHour:00` boundary at or before it, in local (process-TZ) time. Computed with local
 * `Date` field math so it's correct across DST, not by flooring UTC.
 */
export function dayStart(ms: number): number {
  const cutoff = config.summary.cutoffHour;
  const d = new Date(ms);
  // Shift back by the cutoff so a pre-cutoff time lands on the previous calendar date, then
  // pin to that date's cutoff hour.
  d.setHours(d.getHours() - cutoff);
  d.setHours(cutoff, 0, 0, 0);
  return d.getTime();
}

/** Start of the logical day after the one beginning at `start` (DST-safe +1 day). */
export function nextDayStart(start: number): number {
  const d = new Date(start);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Start of the logical day before the one beginning at `start` (DST-safe −1 day). */
export function prevDayStart(start: number): number {
  const d = new Date(start);
  d.setDate(d.getDate() - 1);
  return d.getTime();
}

// ---- Generating one day's summary --------------------------------------------------------

/** Renders the summarizer system prompt with the character/user names substituted. */
function renderSummaryPrompt(charName: string, userName: string): string {
  return SUMMARY_TEMPLATE.replaceAll('{{char}}', charName).replaceAll('{{user}}', userName);
}

/**
 * Summarizes one completed logical day `[start, end)` for a chat and stores the row. Builds the
 * transcript from the day's messages (captions + search results inline), labels each turn with
 * the real names, and asks the dedicated summary model for a first-person diary entry.
 */
async function summarizeDay(chatId: number, start: number, end: number): Promise<void> {
  const charName = getCharName();
  const userName = getSummaryState(chatId)?.userName ?? 'they';
  const msgs = getDayMessages(chatId, start, end);

  const transcript = msgs
    .map((m) => `${m.role === 'user' ? userName : charName}: ${m.content}`)
    .join('\n');
  const dateLabel = new Date(start).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  const system = renderSummaryPrompt(charName, userName);
  const user = `Date: ${dateLabel}\n\n<transcript>\n${transcript}\n</transcript>\n\nWrite ${charName}'s diary entry for this day.`;

  const content = (await summarize(system, user)).trim();
  // Shape guard: a valid entry carries all four labeled lines. A response that lost one —
  // truncation by a flaky upstream, or plain garbage — must throw instead of being stored,
  // so the scheduler's retry-next-tick path covers bad *output*, not just failed calls.
  const labels = ['Headline:', 'Happened:', 'Mood:', 'Follow-ups:'];
  if (!labels.every((l) => content.includes(l))) {
    throw new Error(`Summary failed the shape check (missing labels): "${content.slice(0, 120)}…"`);
  }
  saveSummary(chatId, 0, start, end, content);
  log.info(`Summarized chat ${chatId} — ${dateLabel} (${msgs.length} msgs → ${content.length} chars)`);
}

// ---- The per-chat scheduler --------------------------------------------------------------

/**
 * Processes any completed-but-unsummarized logical days for one chat, advancing the cursor as it
 * goes. On first contact (no cursor) it *activates* by stamping the previous day as done, so
 * pre-existing history is never back-filled — the day the feature was switched on becomes the
 * first entry, the night it ends.
 */
async function summarizeChat(chatId: number): Promise<void> {
  const now = Date.now();
  const state = getSummaryState(chatId);

  if (!state || state.lastDoneStart == null) {
    // Activation: everything up to and including yesterday is treated as already handled.
    setSummaryCursor(chatId, prevDayStart(dayStart(now)));
    return;
  }

  let cursor = state.lastDoneStart;
  for (;;) {
    const start = nextDayStart(cursor);
    const end = nextDayStart(start);
    if (end > now) break; // this day hasn't ended yet — nothing more to do

    if (messageCountInRange(chatId, start, end) > config.summary.minMessages && !summaryExists(chatId, 0, start)) {
      try {
        await summarizeDay(chatId, start, end);
      } catch (err) {
        // Leave the cursor where it is so this day is retried next tick (don't skip it).
        log.error(`Summary failed for chat ${chatId} day starting ${new Date(start).toISOString()}:`, err);
        return;
      }
    }
    cursor = start;
    setSummaryCursor(chatId, start);
  }
}

/** One scheduler tick: walk every whitelisted chat. Guarded against overlapping runs. */
let ticking = false;
export async function runSummaryTick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    for (const chatId of config.whitelist) {
      await summarizeChat(chatId).catch((err) => log.error(`Summary tick failed for chat ${chatId}:`, err));
    }
  } finally {
    ticking = false;
  }
}

/**
 * Starts the summary scheduler. No-op (with a warning) unless the feature is enabled *and*
 * OpenRouter is configured — summaries always run through OpenRouter.
 */
export function startSummaryLoop(): void {
  if (!config.summary.enabled) return;
  if (!config.llm.openrouter.apiKey) {
    log.warn('SUMMARY_ENABLED is set but OPENROUTER_API_KEY is missing — summaries are off.');
    return;
  }
  const s = config.summary;
  log.info(
    `Long-term memory ON — model ${s.model}, day cutoff ${s.cutoffHour}:00, ` +
      `min ${s.minMessages} msgs, keep ${s.maxKept}, tick ${Math.round(s.tickMs / 1000)}s.`,
  );
  // Run one tick shortly after startup (catches up a day missed during downtime), then on the interval.
  setTimeout(() => void runSummaryTick(), 10_000);
  setInterval(() => void runSummaryTick(), s.tickMs);
}
