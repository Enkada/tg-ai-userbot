import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { FACT_CATEGORIES } from './db/schema.js';
import { createLogger } from './logger.js';
import { getFacts, getRecentSummaries } from './memory.js';
import { getPersona } from './persona.js';
import { getCharName } from './settings.js';
import { renderToolsBlock } from './tools.js';

const log = createLogger('prompt');

/**
 * The app-owned technical layer, loaded once at startup; `{{tag}}` placeholders are
 * substituted per message. The persona layer (user-owned, editable via `/persona`) lives in
 * the DB and is read through {@link getPersona} per render, so edits apply instantly. The
 * two are kept separate so `/prompt` can show either one alone — `renderSystemPrompt`
 * rejoins them in the original order.
 */
const technical = readFileSync(resolve(process.cwd(), config.llm.technicalPromptPath), 'utf8').trim();
log.info(`Loaded technical prompt layer (${technical.length} chars)`);

export interface PromptContext {
  /** Display name of the Telegram user the bot is talking to (for {{user}}). */
  userName: string;
  /** Chat (peer) id — the key for this conversation's long-term memory summaries. */
  chatId: number;
}

/**
 * Builds the `# Memory` block: the newest daily summaries for a chat, oldest first, under a
 * short framing line that tells the model these are its own recollections (not instructions,
 * and never to be quoted). Returns '' when the chat has no summaries yet, so nothing is added.
 */
export function renderMemoryBlock(chatId: number, userName: string): string {
  const entries = getRecentSummaries(chatId, config.summary.maxKept);
  if (entries.length === 0) return '';
  const body = entries
    .map((e) => {
      const label = new Date(e.periodStart).toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      });
      return `[${label}]\n${e.content}`;
    })
    .join('\n\n');
  return (
    `# Memory\n` +
    `These are your own diary notes from earlier days with ${userName}, oldest first. ` +
    `Recall them naturally as your own memories — never quote them, list them, or mention having notes.\n\n` +
    body
  );
}

/**
 * Builds the `# About {user}` block: every non-deleted fact for the chat, grouped under
 * capitalized category headers in the fixed {@link FACT_CATEGORIES} order (no ids, no dates —
 * `/facts` shows those; the model sees knowledge, not records). The framing line plays the
 * same role as the memory block's: this is background the character *carries*, to surface
 * only when relevant — without it she works her way through the list unprompted.
 * Returns '' when the chat has no facts yet.
 */
export function renderFactsBlock(chatId: number, userName: string): string {
  const rows = getFacts(chatId);
  if (rows.length === 0) return '';
  const groups = FACT_CATEGORIES.map((cat) => {
    const items = rows.filter((f) => f.category === cat);
    if (items.length === 0) return null;
    const header = cat === 'us' ? 'Us' : cat[0].toUpperCase() + cat.slice(1);
    return `${header}:\n${items.map((f) => `- ${f.content}`).join('\n')}`;
  }).filter(Boolean);
  return (
    `# About ${userName}\n` +
    `Things you know about ${userName} from your time together — background knowledge you simply carry. ` +
    `Let it inform you naturally when it's relevant; never recite it, list it, or bring these up unprompted.\n\n` +
    groups.join('\n\n')
  );
}

/** Maps an hour (0-23) to a coarse day period. */
export function dayPeriod(hour: number): string {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}

/**
 * Renders the system prompt by substituting `{{tag}}` placeholders. Supported tags:
 * - `{{char}}`   — character name (from config)
 * - `{{user}}`   — Telegram user's display name
 * - `{{date}}`   — e.g. "June 10, 2026"
 * - `{{day}}`    — weekday, e.g. "Monday"
 * - `{{period}}` — day period: morning / afternoon / evening / night
 *
 * Unknown tags are left untouched (so typos stay visible).
 *
 * `opts.includeMemory` (default true) controls the `# Memory` block. Reactive replies want it;
 * **proactive openers turn it off** — an opener has no user message to anchor on, so the model
 * latches onto the single most salient summary and rehashes it almost verbatim every reach-out
 * (observed: 6/6 openers fixated on the same memory). Openers still carry the live recent-message
 * window, so short-term continuity is preserved; only multi-day recall is withheld from them.
 */
/** Substitutes `{{tag}}` placeholders in one layer of text; unknown tags are left untouched. */
function substitute(text: string, ctx: PromptContext, now: Date): string {
  const vars: Record<string, string> = {
    char: getCharName(),
    user: ctx.userName,
    date: now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    day: now.toLocaleDateString('en-US', { weekday: 'long' }),
    period: dayPeriod(now.getHours()),
  };
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) => {
    const key = name.toLowerCase();
    return key in vars ? vars[key] : match;
  });
}

/** The persona layer with tags substituted — the user-owned slice of the system prompt. */
export function renderPersona(ctx: PromptContext, opts: { now?: Date } = {}): string {
  return substitute(getPersona(), ctx, opts.now ?? new Date());
}

/** The technical layer with tags substituted — the app-owned slice of the system prompt. */
export function renderTechnical(ctx: PromptContext, opts: { now?: Date } = {}): string {
  return substitute(technical, ctx, opts.now ?? new Date());
}

export function renderSystemPrompt(
  ctx: PromptContext,
  opts: { now?: Date; includeMemory?: boolean } = {},
): string {
  const { now = new Date(), includeMemory = true } = opts;

  // Persona + technical → facts (who the user is) → memory (recollections) → tools
  // (capabilities/protocol). The facts and memory blocks are rendered per message, so /prompt
  // and /context reflect the exact prompt the LLM sees. Unlike the memory block, facts are NOT
  // dropped for proactive openers: they're timeless background rather than salient events, so
  // the opener-fixation problem that exiled summaries doesn't apply (kept under watch). The
  // order here is the single source of truth for the live payload, /prompt, and /dump alike —
  // keep it in sync with renderToolsBlock's placement.
  const factsBlock = renderFactsBlock(ctx.chatId, ctx.userName);
  const memory = includeMemory ? renderMemoryBlock(ctx.chatId, ctx.userName) : '';
  const tools = renderToolsBlock();
  return [renderPersona(ctx, { now }), renderTechnical(ctx, { now }), factsBlock, memory, tools]
    .filter(Boolean)
    .join('\n\n');
}
