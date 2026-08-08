/**
 * The user's usual weekly schedule — parses `prompts/system/schedule.txt` and answers "where
 * is he right now, and until when". The answer feeds one hedged sentence in the reply cue and
 * the proactive reach-out cues (see prompts/index.ts:scheduleClause); it never enters the
 * system prompt, so the per-minute resolution costs nothing extra (the tail already re-renders
 * every turn for the clock).
 *
 * File format (documented in the file itself, which is the operator-edited artifact):
 *  - `[Mon-Fri]` / `[Sat]` / `[Mon,Wed,Fri]` — weekday sections; later sections win on overlap.
 *  - `[2026-08-20..2026-08-27]` / `[2026-12-31]` — date-override sections (vacations etc.);
 *    a matching date section beats every weekday section for that calendar day.
 *  - `HH:MM text` — a block starting then, running until the next block's start; a day's last
 *    block runs into the next day's first (so `23:00 winding down` covers past midnight when
 *    the next day starts at `07:00`).
 *
 * Parsed eagerly at import, like every prompts/*.txt load: a malformed file takes the bot down
 * at boot, where pm2 and the panel show it, instead of failing silently at 9am. An *empty*
 * schedule (comments only, or no block covering a given day) is the documented off-switch:
 * {@link scheduleNow} returns null and no cue line is rendered.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('schedule');

interface Block {
  /** Minutes since local midnight the block starts at. */
  startMin: number;
  text: string;
}

interface Section {
  /** Weekdays covered (JS getDay() numbering, 0 = Sunday) — weekday sections only. */
  days?: Set<number>;
  /** Inclusive local-date bounds as `YYYY-MM-DD` strings — date-override sections only. */
  dateFrom?: string;
  dateTo?: string;
  blocks: Block[];
}

/** What the schedule says for one moment. `until` is `HH:MM`, or null when open-ended. */
export interface ScheduleSlot {
  text: string;
  until: string | null;
}

const DAY_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

/** Resolves a day token ("Mon", "monday") to getDay() numbering; throws on garbage. */
function parseDay(token: string, line: number): number {
  const day = DAY_NAMES[token.trim().toLowerCase().slice(0, 3)];
  if (day === undefined) throw new Error(`schedule.txt line ${line}: unknown day "${token.trim()}"`);
  return day;
}

/** Expands a `[...]` header into a section shell; throws on anything unrecognizable. */
function parseHeader(header: string, line: number): Section {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  // Date override: a single date or an inclusive `from..to` range.
  if (/^\d/.test(header)) {
    const [from, to = from] = header.split('..').map((s) => s.trim());
    if (!iso.test(from) || !iso.test(to)) {
      throw new Error(`schedule.txt line ${line}: bad date section "[${header}]" (use YYYY-MM-DD or YYYY-MM-DD..YYYY-MM-DD)`);
    }
    return { dateFrom: from, dateTo: to, blocks: [] };
  }
  // Weekdays: comma-separated tokens, each a name or a wrapping range.
  const days = new Set<number>();
  for (const token of header.split(',')) {
    const range = token.split('-');
    if (range.length === 2) {
      let d = parseDay(range[0], line);
      const end = parseDay(range[1], line);
      days.add(d);
      while (d !== end) {
        d = (d + 1) % 7;
        days.add(d);
      }
    } else {
      days.add(parseDay(token, line));
    }
  }
  return { days, blocks: [] };
}

/** Parses the whole file. Exported for the scratch checks; production uses the eager singleton. */
export function parseSchedule(raw: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  raw.split('\n').forEach((rawLine, i) => {
    const text = rawLine.trim();
    if (!text || text.startsWith('#')) return;
    const line = i + 1;
    const header = /^\[(.+)\]$/.exec(text);
    if (header) {
      current = parseHeader(header[1].trim(), line);
      sections.push(current);
      return;
    }
    const entry = /^(\d{1,2}):(\d{2})\s+(.+)$/.exec(text);
    if (!entry) throw new Error(`schedule.txt line ${line}: expected "[days]" or "HH:MM text", got "${text}"`);
    if (!current) throw new Error(`schedule.txt line ${line}: block before any [section] header`);
    const [h, m] = [Number(entry[1]), Number(entry[2])];
    if (h > 23 || m > 59) throw new Error(`schedule.txt line ${line}: invalid time "${entry[1]}:${entry[2]}"`);
    current.blocks.push({ startMin: h * 60 + m, text: entry[3].trim() });
  });
  for (const s of sections) {
    if (s.blocks.length === 0) throw new Error('schedule.txt: a [section] with no blocks — delete it or add entries');
    s.blocks.sort((a, b) => a.startMin - b.startMin);
  }
  return sections;
}

const SECTIONS: Section[] = (() => {
  const raw = readFileSync(resolve(process.cwd(), config.llm.schedulePromptPath), 'utf8');
  const sections = parseSchedule(raw);
  const blocks = sections.reduce((n, s) => n + s.blocks.length, 0);
  if (blocks === 0) log.info('Schedule file has no blocks — schedule awareness is off.');
  else log.info(`Schedule loaded: ${sections.length} section(s), ${blocks} block(s).`);
  return sections;
})();

/** Local date as `YYYY-MM-DD` (string compare works for range checks). */
function localIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The blocks in effect on one calendar day: the last matching date-override section if any
 * (specific beats general), else the last matching weekday section, else none.
 */
function dayBlocks(date: Date, sections: Section[]): Block[] {
  const iso = localIso(date);
  const dated = sections.filter((s) => s.dateFrom && s.dateFrom <= iso && iso <= s.dateTo!);
  if (dated.length > 0) return dated[dated.length - 1].blocks;
  const day = date.getDay();
  const weekly = sections.filter((s) => s.days?.has(day));
  return weekly.length > 0 ? weekly[weekly.length - 1].blocks : [];
}

const fmtMin = (min: number): string =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** Pure resolver over explicit sections — the testable core of {@link scheduleNow}. */
export function resolveSlot(now: Date, sections: Section[]): ScheduleSlot | null {
  const today = dayBlocks(now, sections);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  let idx = -1;
  for (let i = 0; i < today.length; i++) if (today[i].startMin <= nowMin) idx = i;

  if (idx >= 0) {
    const next = today[idx + 1];
    if (next) return { text: today[idx].text, until: fmtMin(next.startMin) };
    // Last block of the day runs into tomorrow's first block. When that boundary is the same
    // clock time the block itself starts at (a single-block day, e.g. a vacation override),
    // the state is continuous and an "until" would read as an end time earlier than now —
    // suppress it instead.
    const tomorrow = dayBlocks(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1), sections);
    const boundary = tomorrow.length ? tomorrow[0].startMin : null;
    return { text: today[idx].text, until: boundary !== null && boundary !== today[idx].startMin ? fmtMin(boundary) : null };
  }

  // Before today's first block (or today has none): still inside yesterday's last block.
  const yesterday = dayBlocks(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1), sections);
  if (yesterday.length === 0) return null;
  const until = today.length ? fmtMin(today[0].startMin) : null;
  return { text: yesterday[yesterday.length - 1].text, until };
}

/** What the user is usually doing right now, per the schedule file. Null ⇒ render no cue line. */
export function scheduleNow(now: Date = new Date()): ScheduleSlot | null {
  return resolveSlot(now, SECTIONS);
}
