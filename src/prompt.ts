import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { FACT_CATEGORIES } from './db/schema.js';
import { createLogger } from './logger.js';
import { getFacts, getRecentSummaries } from './memory.js';
import { getPersona } from './persona.js';
import { isSelfieAvailable } from './selfie.js';
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
 * Valued tags take a `YYYY-MM-DD` argument after a colon:
 * - `{{days-since:2026-07-04}}` — calendar days elapsed since the date (never negative)
 * - `{{days-until:2026-12-31}}` — calendar days until the date; once passed it counts down
 *                                 to the next anniversary of its month/day (never negative)
 * - `{{age:2005-03-14}}`        — completed years since the date (a birthdate)
 * - `{{since:2026-07-04}}`      — humanized elapsed time, e.g. "2 months and 5 days"
 *
 * Unknown tags are left untouched (so typos stay visible).
 *
 * `opts.includeMemory` (default true) controls the `# Memory` block. Reactive replies want it;
 * **proactive openers turn it off** — an opener has no user message to anchor on, so the model
 * latches onto the single most salient summary and rehashes it almost verbatim every reach-out
 * (observed: 6/6 openers fixated on the same memory). Openers still carry the live recent-message
 * window, so short-term continuity is preserved; only multi-day recall is withheld from them.
 */
/** Parses a strict `YYYY-MM-DD` string into a local-midnight Date; null when malformed or not a real date. */
function parseIsoDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  // Round-trip check rejects rolled-over impossibilities like 2026-02-31.
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

/** Calendar-day difference `b - a` in the process timezone (rounding absorbs DST hour shifts). */
function dayDiff(a: Date, b: Date): number {
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((midnight(b) - midnight(a)) / 86_400_000);
}

/** Joins duration parts English-style: `[a]`, `[a and b]`, `[a, b and c]`. */
function joinParts(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '0 days';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * Handlers for `{{tag:YYYY-MM-DD}}` tags. Each receives the parsed date and the render
 * time and returns the substitution text. Exported for tests/scratch checks.
 */
export const valuedTags: Record<string, (date: Date, now: Date) => string> = {
  /** Calendar days elapsed since the date; a future date clamps to 0 instead of going negative. */
  'days-since': (date, now) => String(Math.max(0, dayDiff(date, now))),

  /**
   * Calendar days until the date. A passed date recurs annually: it counts down to the next
   * occurrence of its month/day (0 on the day itself, ~364 the day after — never negative).
   * Feb 29 rolls over to Mar 1 in non-leap years via Date's own overflow.
   */
  'days-until': (date, now) => {
    const direct = dayDiff(now, date);
    if (direct >= 0) return String(direct);
    let next = new Date(now.getFullYear(), date.getMonth(), date.getDate());
    if (dayDiff(now, next) < 0) next = new Date(now.getFullYear() + 1, date.getMonth(), date.getDate());
    return String(dayDiff(now, next));
  },

  /** Completed years since the date (i.e. current age for a birthdate); future dates clamp to 0. */
  age: (date, now) => {
    let years = now.getFullYear() - date.getFullYear();
    if (dayDiff(new Date(now.getFullYear(), date.getMonth(), date.getDate()), now) < 0) years--;
    return String(Math.max(0, years));
  },

  /** Humanized elapsed time since the date: "13 days", "2 months and 5 days", "1 year, 2 months and 3 days". */
  since: (date, now) => {
    let years = now.getFullYear() - date.getFullYear();
    let months = now.getMonth() - date.getMonth();
    let days = now.getDate() - date.getDate();
    if (days < 0) {
      months--;
      days += new Date(now.getFullYear(), now.getMonth(), 0).getDate();
    }
    if (months < 0) {
      years--;
      months += 12;
    }
    if (years < 0) return '0 days';
    const parts: string[] = [];
    if (years > 0) parts.push(`${years} year${years === 1 ? '' : 's'}`);
    if (months > 0) parts.push(`${months} month${months === 1 ? '' : 's'}`);
    if (days > 0) parts.push(`${days} day${days === 1 ? '' : 's'}`);
    return joinParts(parts);
  },
};

/**
 * Substitutes `{{tag}}` and `{{tag:value}}` placeholders in one layer of text. Unknown tags
 * are left untouched, as is a known valued tag with an unparseable date (logged, so the
 * mistake is visible in both the rendered prompt and the log).
 */
export function substitute(text: string, ctx: PromptContext, now: Date): string {
  const vars: Record<string, string> = {
    char: getCharName(),
    user: ctx.userName,
    date: now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    day: now.toLocaleDateString('en-US', { weekday: 'long' }),
    period: dayPeriod(now.getHours()),
  };
  return text.replace(/\{\{\s*([\w-]+)\s*(?::\s*([^}]*?)\s*)?\}\}/g, (match, name: string, value: string | undefined) => {
    const key = name.toLowerCase();
    if (value === undefined) return key in vars ? vars[key] : match;
    const handler = valuedTags[key];
    if (!handler) return match;
    const date = parseIsoDate(value);
    if (!date) {
      log.warn(`Bad date "${value}" in {{${key}:...}} — leaving tag untouched`);
      return match;
    }
    return handler(date, now);
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

/** The selfie tool's usage section (prompts/selfie.txt), loaded lazily like the tools scaffold. */
let selfieTemplate: string | undefined;

/**
 * Renders the selfie-tool section appended after the tools block — the "pictures of
 * yourself" rules, call example, and the promise guard (see prompts/selfie.txt). Returns ''
 * when the tool isn't currently offered (unconfigured or daily cap hit), so the model never
 * reads rules for a tool it can't call.
 */
export function renderSelfieBlock(ctx: PromptContext, now: Date): string {
  if (!isSelfieAvailable()) return '';
  if (selfieTemplate === undefined) {
    selfieTemplate = readFileSync(resolve(process.cwd(), config.selfie.toolPromptPath), 'utf8').trim();
  }
  return substitute(selfieTemplate, ctx, now);
}

export function renderSystemPrompt(
  ctx: PromptContext,
  opts: { now?: Date; includeMemory?: boolean } = {},
): string {
  const { now = new Date(), includeMemory = true } = opts;

  // Persona + technical → facts (who the user is) → memory (recollections) → tools
  // (capabilities/protocol) → selfie rules. The facts and memory blocks are rendered per
  // message, so /prompt and /context reflect the exact prompt the LLM sees. Unlike the memory
  // block, facts are NOT dropped for proactive openers: they're timeless background rather
  // than salient events, so the opener-fixation problem that exiled summaries doesn't apply
  // (kept under watch). The order here is the single source of truth for the live payload,
  // /prompt, and /dump alike — keep it in sync with renderToolsBlock's placement.
  const factsBlock = renderFactsBlock(ctx.chatId, ctx.userName);
  const memory = includeMemory ? renderMemoryBlock(ctx.chatId, ctx.userName) : '';
  // The tools scaffold contains {{user}} too — substitute it like the other layers.
  const tools = substitute(renderToolsBlock(), ctx, now);
  const selfie = renderSelfieBlock(ctx, now);
  return [renderPersona(ctx, { now }), renderTechnical(ctx, { now }), factsBlock, memory, tools, selfie]
    .filter(Boolean)
    .join('\n\n');
}
