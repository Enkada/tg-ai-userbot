/**
 * Long-term memory, tier three — durable facts about the user.
 *
 * Where the daily summaries (summary.ts) are *episodic* memory ("what happened"), facts are
 * *semantic* memory ("who {@link PromptContext.userName} is"): workplace, living situation,
 * people, habits, likes — things that must survive the rolling window falling off. They're
 * injected into every system prompt by {@link renderFactsBlock}, grouped by category.
 *
 * The pipeline is a single **diff pass** per completed logical day, not separate
 * extract/merge phases: the model receives the current fact list (with ids) *and* the day's
 * transcript, and answers with the operations needed to reconcile them — `add`/`edit`/
 * `delete` as JSON. One call, and extraction can see what's already known, which is the only
 * way it can recognize "the cast is off" as a deletion rather than noise. Prompt and model
 * choice were validated against real transcripts (2026-07-17); the guards in
 * {@link applyOps} cover the failure modes observed there: invented ids, "confirmation"
 * edits whose content is unchanged, and fenced/preambled JSON.
 *
 * Scheduling mirrors summary.ts exactly — same logical days ({@link dayStart}, shared cutoff
 * hour), same cursor/activation/catch-up semantics, own state table so the two jobs fail and
 * retry independently. A malformed response leaves the cursor put, so the day is retried on
 * the next tick.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { FACT_CATEGORIES, type FactCategory, type FactRow } from './db/schema.js';
import { createLogger } from './logger.js';
import {
  addFact,
  deleteFact,
  editFact,
  getDayMessages,
  getFacts,
  getFactsState,
  getSummaryState,
  messageCountInRange,
  setFactsCursor,
} from './memory.js';
import { factsPass } from './providers/openrouter.js';
import { getCharName } from './settings.js';
import { dayStart, nextDayStart, prevDayStart } from './summary.js';

const log = createLogger('facts');

/** The app-owned diff-pass system prompt, loaded once. */
const FACTS_TEMPLATE = readFileSync(resolve(process.cwd(), config.facts.promptPath), 'utf8').trim();

// ---- The diff-pass exchange --------------------------------------------------------------

/** One reconciliation operation from the diff pass, already shape-checked by {@link parseOps}. */
type FactOp =
  | { op: 'add'; category: FactCategory; content: string; reason?: string }
  | { op: 'edit'; id: number; content: string; reason?: string }
  | { op: 'delete'; id: number; reason?: string };

/** Renders the diff-pass system prompt with the character/user names substituted. */
function renderFactsPrompt(charName: string, userName: string): string {
  return FACTS_TEMPLATE.replaceAll('{{char}}', charName).replaceAll('{{user}}', userName);
}

/** `[12] (work, learned 2026-07-03) Kirill works at …` — the fact list as the diff pass sees it. */
function renderFactList(rows: FactRow[]): string {
  if (rows.length === 0) return '(no facts recorded yet)';
  return rows
    .map((f) => `[${f.id}] (${f.category}, learned ${new Date(f.createdAt).toISOString().slice(0, 10)}) ${f.content}`)
    .join('\n');
}

/**
 * The diff pass's user message: current facts, then the day's transcript with `[HH:MM]`
 * time labels and real names. Everything is one `user` turn (never chat-shaped turns) so
 * the model reconciles the transcript instead of continuing the conversation.
 */
function buildUserMessage(chatId: number, start: number, end: number, userName: string): string {
  const charName = getCharName();
  const transcript = getDayMessages(chatId, start, end)
    .map((m) => {
      const t = new Date(m.at);
      const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
      return `[${hm}] ${m.role === 'user' ? userName : charName}: ${m.content}`;
    })
    .join('\n');
  const dateLabel = new Date(start).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  return (
    `# Current facts about ${userName}\n${renderFactList(getFacts(chatId))}\n\n` +
    `# Transcript — ${dateLabel}\n<transcript>\n${transcript}\n</transcript>`
  );
}

/**
 * Parses the model's response into ops, throwing on anything malformed — the caller treats
 * a throw as "retry this day next tick". Tolerates a ```json fence and prose before the
 * object (both observed), but not structural problems: a non-array `ops`, an unknown `op`
 * verb, a missing/empty `content`, or a bad `category` reject the whole batch, because a
 * response that gets the format wrong can't be trusted about the parts that parsed.
 */
export function parseOps(text: string): FactOp[] {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const brace = t.indexOf('{');
  if (brace > 0) t = t.slice(brace);

  const data: unknown = JSON.parse(t);
  const ops = (data as { ops?: unknown }).ops;
  if (!Array.isArray(ops)) throw new Error('response has no ops array');

  return ops.map((raw, i) => {
    const o = raw as Record<string, unknown>;
    const reason = typeof o.reason === 'string' ? o.reason : undefined;
    const content = typeof o.content === 'string' ? o.content.trim() : '';
    const id = typeof o.id === 'number' && Number.isInteger(o.id) ? o.id : null;
    switch (o.op) {
      case 'add': {
        const category = o.category as FactCategory;
        if (!FACT_CATEGORIES.includes(category)) throw new Error(`op ${i}: bad category "${String(o.category)}"`);
        if (!content) throw new Error(`op ${i}: add without content`);
        return { op: 'add', category, content, reason };
      }
      case 'edit':
        if (id === null) throw new Error(`op ${i}: edit without id`);
        if (!content) throw new Error(`op ${i}: edit without content`);
        return { op: 'edit', id, content, reason };
      case 'delete':
        if (id === null) throw new Error(`op ${i}: delete without id`);
        return { op: 'delete', id, reason };
      default:
        throw new Error(`op ${i}: unknown op "${String(o.op)}"`);
    }
  });
}

/**
 * Applies parsed ops to a chat's fact list. Two model failure modes observed in testing are
 * dropped per-op rather than failing the batch (they're harmless noise around good ops):
 * - an edit/delete naming an id that doesn't exist in this chat (invented or stale);
 * - a "confirmation" edit whose content matches the stored fact — the tested model emits
 *   these with reasons like "no change needed" despite instructions not to.
 * Every applied and skipped op is logged; the log is the audit trail for /facts curation.
 */
function applyOps(chatId: number, ops: FactOp[], dayLabel: string): { applied: number; skipped: number } {
  const existing = new Map(getFacts(chatId).map((f) => [f.id, f]));
  let applied = 0;
  let skipped = 0;

  for (const op of ops) {
    const why = op.reason ? ` — ${op.reason}` : '';
    switch (op.op) {
      case 'add': {
        const id = addFact(chatId, op.category, op.content);
        log.info(`[${dayLabel}] + fact ${id} (${op.category}): ${op.content}${why}`);
        applied++;
        break;
      }
      case 'edit': {
        const current = existing.get(op.id);
        if (!current) {
          log.warn(`[${dayLabel}] dropped edit of unknown fact ${op.id}: ${op.content}${why}`);
          skipped++;
        } else if (current.content.trim() === op.content) {
          log.info(`[${dayLabel}] dropped no-op edit of fact ${op.id} (content unchanged)${why}`);
          skipped++;
        } else {
          editFact(chatId, op.id, op.content);
          log.info(`[${dayLabel}] ~ fact ${op.id}: ${current.content} → ${op.content}${why}`);
          applied++;
        }
        break;
      }
      case 'delete': {
        if (deleteFact(chatId, op.id)) {
          log.info(`[${dayLabel}] - fact ${op.id}: ${existing.get(op.id)?.content ?? '?'}${why}`);
          applied++;
        } else {
          log.warn(`[${dayLabel}] dropped delete of unknown fact ${op.id}${why}`);
          skipped++;
        }
        break;
      }
    }
  }
  return { applied, skipped };
}

/**
 * Runs the diff pass for one completed logical day `[start, end)` and applies the result.
 * Throws (without touching the cursor) when the model call fails or the response doesn't
 * parse — the scheduler retries the day next tick.
 */
async function processDay(chatId: number, start: number, end: number): Promise<void> {
  const userName = getSummaryState(chatId)?.userName ?? 'they';
  const system = renderFactsPrompt(getCharName(), userName);
  const user = buildUserMessage(chatId, start, end, userName);
  const dayLabel = new Date(start).toISOString().slice(0, 10);

  const ops = parseOps(await factsPass(system, user));
  const { applied, skipped } = applyOps(chatId, ops, dayLabel);
  log.info(`Facts for chat ${chatId} — ${dayLabel}: ${ops.length} ops (${applied} applied, ${skipped} dropped)`);
}

// ---- The per-chat scheduler (summary.ts's walker, against its own cursor) -----------------

/**
 * Processes any completed-but-unscanned logical days for one chat. Same contract as
 * `summarizeChat`: first contact stamps the previous day (never back-fill pre-feature
 * history), short days advance the cursor without an LLM call, and a failed day keeps the
 * cursor so it's retried.
 */
async function scanChat(chatId: number): Promise<void> {
  const now = Date.now();
  const state = getFactsState(chatId);

  if (!state || state.lastDoneStart == null) {
    setFactsCursor(chatId, prevDayStart(dayStart(now)));
    return;
  }

  let cursor = state.lastDoneStart;
  for (;;) {
    const start = nextDayStart(cursor);
    const end = nextDayStart(start);
    if (end > now) break; // this day hasn't ended yet

    if (messageCountInRange(chatId, start, end) > config.facts.minMessages) {
      try {
        await processDay(chatId, start, end);
      } catch (err) {
        // Leave the cursor so this day is retried next tick (don't skip it).
        log.error(`Facts pass failed for chat ${chatId} day starting ${new Date(start).toISOString()}:`, err);
        return;
      }
    }
    cursor = start;
    setFactsCursor(chatId, start);
  }
}

/** One scheduler tick: walk every whitelisted chat. Guarded against overlapping runs. */
let ticking = false;
export async function runFactsTick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    for (const chatId of config.whitelist) {
      await scanChat(chatId).catch((err) => log.error(`Facts tick failed for chat ${chatId}:`, err));
    }
  } finally {
    ticking = false;
  }
}

/**
 * Starts the facts scheduler. No-op (with a warning) unless the feature is enabled *and*
 * OpenRouter is configured — the diff pass always runs through OpenRouter.
 */
export function startFactsLoop(): void {
  if (!config.facts.enabled) return;
  if (!config.llm.openrouter.apiKey) {
    log.warn('FACTS_ENABLED is set but OPENROUTER_API_KEY is missing — facts are off.');
    return;
  }
  const f = config.facts;
  log.info(
    `Long-term facts ON — model ${f.model}, min ${f.minMessages} msgs, tick ${Math.round(f.tickMs / 1000)}s.`,
  );
  // Staggered against the summary loop's 10s so the two nightly jobs never fire in lockstep.
  setTimeout(() => void runFactsTick(), 25_000);
  setInterval(() => void runFactsTick(), f.tickMs);
}
