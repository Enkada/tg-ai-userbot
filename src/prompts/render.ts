import { config } from '../config.js';
import { FACT_CATEGORIES } from '../db/schema.js';
import { createLogger } from '../logger.js';
import { factCount, getFacts, getRecentSummaries } from '../memory.js';
import { getPersona } from '../persona.js';
import { isSelfieAvailable } from '../selfie.js';
import { getCharName } from '../settings.js';
import { renderToolsBlock } from '../tools.js';
import {
  APPEARANCE_LAYER,
  SELFIE_TOOL_SECTION,
  TECHNICAL_LAYER,
  factsBlockHeader,
  memoryBlockHeader,
} from './index.js';

const log = createLogger('prompt');

export interface PromptContext {
  /** Display name of the Telegram user the bot is talking to (for {{user}}). */
  userName: string;
  /** Chat (peer) id — the key for this conversation's long-term memory summaries. */
  chatId: number;
}

/**
 * Builds the `# Memory` block: the newest daily summaries for a chat, oldest first, under the
 * framing line in prompts/index.ts. Returns '' when the chat has no summaries yet, so nothing
 * is added.
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
  return `${memoryBlockHeader(userName)}\n\n${body}`;
}

/**
 * Builds the `# About {user}` block: every non-deleted fact for the chat, grouped under
 * capitalized category headers in the fixed {@link FACT_CATEGORIES} order (no ids, no dates —
 * `/facts` shows those; the model sees knowledge, not records), under the framing line in
 * prompts/index.ts. Returns '' when the chat has no facts yet.
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
  return `${factsBlockHeader(userName)}\n\n${groups.join('\n\n')}`;
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
  return substitute(TECHNICAL_LAYER, ctx, opts.now ?? new Date());
}

/** The appearance layer with tags substituted — the character's actual look. */
export function renderAppearance(ctx: PromptContext, opts: { now?: Date } = {}): string {
  return substitute(APPEARANCE_LAYER, ctx, opts.now ?? new Date());
}

/**
 * Renders the selfie-tool section appended after the tools block — the "pictures of
 * yourself" rules, call example, and the promise guard. Returns '' when the tool isn't
 * currently offered (unconfigured or daily cap hit), so the model never reads rules for a
 * tool it can't call.
 */
export function renderSelfieBlock(ctx: PromptContext, now: Date): string {
  if (!isSelfieAvailable()) return '';
  return substitute(SELFIE_TOOL_SECTION, ctx, now);
}

// ---- The system-prompt catalog ---------------------------------------------------------------

/** One slice of the chat system prompt, as the live payload, `/prompt` and `/dump` all see it. */
export interface PromptPart {
  key: string;
  /** Icon used by `/dump`'s section headings and token table. */
  emoji: string;
  /** What the user can type after `/prompt`. The first one is the canonical short form. */
  aliases: readonly string[];
  /** One-line description for the generated `/prompt h` menu. */
  hint: string;
  /** Heading text; a function so it can carry live counts. */
  label: (ctx: PromptContext) => string;
  /** The slice exactly as the model receives it. '' when the slice contributes nothing. */
  render: (ctx: PromptContext, now: Date) => string;
  /** Shown by `/prompt` when {@link render} comes back empty. */
  emptyNote: string;
}

/**
 * Every layer of the chat system prompt, in the order the model receives them: persona +
 * appearance + technical → facts (who the user is) → memory (recollections) → tools
 * (capabilities/protocol) → selfie rules.
 *
 * This array is the single source of truth. {@link renderSystemPrompt} joins it to build the
 * live payload, `/dump` walks it to annotate that payload section by section, and `/prompt`
 * resolves its argument against the aliases — so a new layer is added here once and shows up
 * in all three, instead of drifting between four hand-maintained lists.
 *
 * Facts and memory are rendered per message, so what `/prompt` and `/dump` show is what the
 * LLM sees, not a stale copy.
 */
export const SYSTEM_PROMPT_PARTS: readonly PromptPart[] = [
  {
    key: 'persona',
    emoji: '🎭',
    aliases: ['p', 'persona'],
    hint: 'persona (default)',
    label: () => 'Persona',
    render: (ctx, now) => renderPersona(ctx, { now }),
    emptyNote: '(persona is empty)',
  },
  {
    key: 'appearance',
    emoji: '👀',
    aliases: ['a', 'appearance'],
    hint: 'appearance layer',
    label: () => 'Appearance',
    render: (ctx, now) => renderAppearance(ctx, { now }),
    emptyNote: '(appearance is empty)',
  },
  {
    key: 'technical',
    emoji: '⚙️',
    aliases: ['tech', 'technical'],
    hint: 'technical layer',
    label: () => 'Technical',
    render: (ctx, now) => renderTechnical(ctx, { now }),
    emptyNote: '(technical layer is empty)',
  },
  {
    key: 'facts',
    emoji: '📇',
    aliases: ['f', 'fact', 'facts'],
    hint: 'facts block as a .md file (as the model sees it — use `/facts` to edit)',
    label: (ctx) => `Facts (${factCount(ctx.chatId)})`,
    render: (ctx) => renderFactsBlock(ctx.chatId, ctx.userName),
    emptyNote: '(no facts yet)',
  },
  {
    key: 'memory',
    emoji: '🧠',
    aliases: ['s', 'summary', 'summaries', 'memory'],
    hint: 'summaries (memory)',
    label: (ctx) => {
      const n = getRecentSummaries(ctx.chatId, config.summary.maxKept).length;
      return `Memory (${n} day${n === 1 ? '' : 's'})`;
    },
    render: (ctx) => renderMemoryBlock(ctx.chatId, ctx.userName),
    emptyNote: '(no summaries yet)',
  },
  {
    key: 'tools',
    emoji: '🛠️',
    aliases: ['t', 'tools'],
    hint: 'tools block',
    label: () => 'Tools',
    // The tools scaffold contains {{user}} too — substitute it like the other layers.
    render: (ctx, now) => substitute(renderToolsBlock(), ctx, now),
    emptyNote: '(no tools available)',
  },
  {
    key: 'selfie',
    emoji: '📸',
    aliases: ['pic', 'selfie'],
    hint: 'selfie rules (only while the tool is offered)',
    label: () => 'Selfie rules',
    render: (ctx, now) => renderSelfieBlock(ctx, now),
    emptyNote: '(selfie tool is not currently offered)',
  },
];

/** Resolves a `/prompt` argument to a part, or undefined for an unknown one. */
export function findPromptPart(alias: string): PromptPart | undefined {
  const a = alias.toLowerCase();
  return SYSTEM_PROMPT_PARTS.find((p) => p.aliases.includes(a));
}

/**
 * Builds the system prompt by joining {@link SYSTEM_PROMPT_PARTS} in order, dropping the
 * slices that render empty.
 *
 * `opts.includeMemory` (default true) controls the `# Memory` block. Reactive replies want it;
 * **proactive openers turn it off** — an opener has no user message to anchor on, so the model
 * latches onto the single most salient summary and rehashes it almost verbatim every reach-out
 * (observed: 6/6 openers fixated on the same memory). Openers still carry the live recent-message
 * window, so short-term continuity is preserved; only multi-day recall is withheld from them.
 * Facts are NOT dropped alongside it: they're timeless background rather than salient events,
 * so the opener-fixation problem that exiled summaries doesn't apply (kept under watch).
 */
export function renderSystemPrompt(
  ctx: PromptContext,
  opts: { now?: Date; includeMemory?: boolean } = {},
): string {
  const { now = new Date(), includeMemory = true } = opts;
  return SYSTEM_PROMPT_PARTS.filter((part) => includeMemory || part.key !== 'memory')
    .map((part) => part.render(ctx, now))
    .filter(Boolean)
    .join('\n\n');
}
