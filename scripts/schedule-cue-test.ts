/**
 * Harness for the schedule-awareness tail cue (pre-implementation test) — replays real prod
 * turns through the production window/prompt/model path with a candidate schedule line spliced
 * into the reply cue, at the turn's ORIGINAL timestamp, and records the replies for judging.
 *
 * Method: scenarios are processed newest-first on a scratch copy of a prod snapshot; before
 * each scenario every message row newer than the target turn is HARD-deleted (plus its
 * attachments/searches/revisions/photo_gens, plus facts/summaries from after that moment), so
 * memory.ts:getWindow rebuilds the exact context window the bot saw at that turn — captions,
 * searches, window sizing and all. Then each cue variant × sample calls the real OpenRouter
 * chat path with the real sampling params.
 *
 * Point DB_PATH at a *scratch copy* of a prod snapshot — it gets destructively trimmed.
 *
 * Usage:  $env:DB_PATH='<scratch snapshot>'; npx tsx scripts/schedule-cue-test.ts
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../src/config.js';
import { db, runMigrations } from '../src/db/index.js';
import { getRecentOpeners, getWindow } from '../src/memory.js';
import { initPersona } from '../src/persona.js';
import { initSettings } from '../src/settings.js';
import { renderSystemPrompt, dayPeriod } from '../src/prompts/render.js';
import { OPENER_SHAPES, recentOpenersClause, replyFormatCue } from '../src/prompts/index.js';
import { openRouter } from '../src/providers/openrouter.js';
import type { ChatMessage } from '../src/providers/types.js';
import { sql } from 'drizzle-orm';

runMigrations();
initSettings();
initPersona();

const chatId = [...config.whitelist][0];
const userName = 'Kirill';
const SAMPLES = process.env.ROUND === '3' ? 5 : process.env.ROUND === '2' || process.env.ROUND === 'pro' ? 4 : 3;
const CONCURRENCY = 4;

// ---- The candidate schedule (Moscow time), hardcoded for the test ---------------------------
// Each block: [startHour, text]; a block runs until the next block's start. `until` is shown
// to the model as the block's end time.

type Block = { start: number; text: string };
const WEEKDAY: Block[] = [
  { start: 0, text: 'asleep at home' },
  { start: 7, text: 'just up, going through his morning routine at home' },
  { start: 8, text: 'commuting to the office' },
  { start: 9, text: 'at the office, working' },
  { start: 13, text: 'on his lunch break at work' },
  { start: 14, text: 'at the office, working' },
  { start: 18, text: 'commuting home from work' },
  { start: 19, text: 'at home, free for the evening' },
  { start: 23, text: 'at home, winding down for bed' },
];
const SATURDAY: Block[] = [
  { start: 0, text: 'asleep at home' },
  { start: 9, text: 'at home, taking the weekend easy' },
];
const SUNDAY: Block[] = [
  { start: 0, text: 'asleep at home' },
  { start: 9, text: 'at home, taking the weekend easy' },
  { start: 23, text: 'at home, winding down for bed' },
];

function scheduleFor(now: Date): { text: string; until: string; prevText: string; prevEnd: string } {
  const dow = now.getDay();
  const dayOf = (d: number) => (d === 6 ? SATURDAY : d === 0 ? SUNDAY : WEEKDAY);
  const day = dayOf(dow);
  const h = now.getHours() + now.getMinutes() / 60;
  let idx = 0;
  for (let i = 0; i < day.length; i++) if (h >= day[i].start) idx = i;
  const next = day[idx + 1]?.start;
  // Block runs to next entry, or into the next day's first non-midnight boundary.
  let until: string;
  if (next !== undefined) {
    until = `${String(next).padStart(2, '0')}:00`;
  } else {
    const tday = dayOf((dow + 1) % 7);
    until = `${String(tday[1]?.start ?? 0).padStart(2, '0')}:00`;
  }
  const prev = idx > 0 ? day[idx - 1] : dayOf((dow + 6) % 7).at(-1)!;
  const prevEnd = `${String(day[idx].start).padStart(2, '0')}:00`;
  return { text: day[idx].text, until, prevText: prev.text, prevEnd };
}

// ---- Cue variants ---------------------------------------------------------------------------
// Each returns the sentence spliced before the reply cue's closing bracket (leading space).

type Sched = { text: string; until: string; prevText: string; prevEnd: string };
const ROUND2 = process.env.ROUND === '2';
const ROUND3 = process.env.ROUND === '3';
const ROUND_NAG = process.env.ROUND === 'nag';
const ROUND_PRO = process.env.ROUND === 'pro';

/** Humanized gap since the previous (real) message, set per scenario before jobs build. */
let gapClause = '';
/** e.g. "about 3 hours" — set per scenario in the nag round. */
let gapLabel = '';

/** The shipping-candidate schedule sentence (no override clause — it tested harmful). */
const schedLine = (s: Sched): string =>
  ` Going by his usual routine, ${userName} is probably ${s.text} right now (until ~${s.until}).`;

const VARIANTS_NAG: Record<string, (s: Sched) => string> = {
  nogap: (s) => schedLine(s),
  headsup: (s) =>
    ` Heads up: ${userName}'s previous messages above are from ${gapLabel} ago, not just now.${schedLine(s)}`,
  quiet: (s) =>
    ` Heads up: ${userName}'s previous messages above are from ${gapLabel} ago, not just now - don't remark on the pause.${schedLine(s)}`,
  neutral: (s) =>
    ` (${userName}'s messages above are from ${gapLabel} earlier; only his last message is from just now.)${schedLine(s)}`,
};

const VARIANTS_R3: Record<string, (s: Sched) => string> = {
  transition: (s) =>
    ` ${userName}'s usual routine: he was ${s.prevText} until ${s.prevEnd}; right now he's probably ${s.text} (until ~${s.until}) - but anything he says in the chat overrides this.`,
  'transition-gap': (s) =>
    `${gapClause} ${userName}'s usual routine: he was ${s.prevText} until ${s.prevEnd}; right now he's probably ${s.text} (until ~${s.until}) - but anything he says in the chat overrides this.`,
};

const VARIANTS: Record<string, (s: Sched) => string> = ROUND_NAG
  ? VARIANTS_NAG
  : ROUND3
  ? VARIANTS_R3
  : ROUND2
  ? {
      override: (s) =>
        ` Going by his usual routine, ${userName} is probably ${s.text} right now (until ~${s.until}) - but anything he says in the chat overrides this.`,
      transition: (s) =>
        ` ${userName}'s usual routine: he was ${s.prevText} until ${s.prevEnd}; right now he's probably ${s.text} (until ~${s.until}) - but anything he says in the chat overrides this.`,
    }
  : {
      control: () => '',
      bare: (s) => ` ${userName}'s usual routine right now: ${s.text} (until ~${s.until}).`,
      override: (s) =>
        ` Going by his usual routine, ${userName} is probably ${s.text} right now (until ~${s.until}) - but anything he says in the chat overrides this.`,
      background: (s) =>
        ` Going by his usual routine, ${userName} is probably ${s.text} right now (until ~${s.until}). Background only, so you don't have to guess his day - don't bring his routine up unless it's relevant.`,
    };

// ---- Scenarios ------------------------------------------------------------------------------

interface Scenario {
  key: string;
  type: 'leak' | 'invited' | 'trap' | 'contradiction' | 'probe';
  /** Window is rebuilt as of this message id (it becomes the last turn). */
  targetId: number;
  /** Synthetic user turn appended after the window (probes only). */
  probe?: { content: string; atMs: number };
  note: string;
}

const msk = (y: number, mo: number, d: number, h: number, mi: number) =>
  Date.UTC(y, mo - 1, d, h - 3, mi);

const SCENARIOS: Scenario[] = [
  { key: 'invited-office', type: 'invited', targetId: 3665, note: 'Thu 11:09, work rant (lights, heat) — schedule agrees; should it help or pile on?' },
  {
    key: 'probe-morning', type: 'probe', targetId: 3597,
    probe: { content: 'morning. guess what im doing rn :)', atMs: msk(2026, 8, 5, 9, 40) },
    note: 'Wed 09:40 after an evening window — expected answer: at the office / working',
  },
  { key: 'trap-boss', type: 'trap', targetId: 3586, note: 'Tue 17:26, "who\'s the boss" = website beef with friend — must not conflate with work/office boss' },
  { key: 'leak-work', type: 'leak', targetId: 3583, note: 'Tue 12:10, website banter — schedule (office) should NOT surface' },
  {
    key: 'probe-evening', type: 'probe', targetId: 3558,
    probe: { content: 'guess what im up to rn', atMs: msk(2026, 8, 3, 20, 30) },
    note: 'Mon 20:30 after a workday-grind window — control likely says "working"; truth: home, free',
  },
  { key: 'invited-lunch', type: 'invited', targetId: 3552, note: 'Mon 13:01, "kfc, don\'t wanna eat canteen food" — lunch-break block agrees' },
  { key: 'leak-evening', type: 'leak', targetId: 3451, note: 'Thu 22:22, games/adult malaise — schedule (home, free) should NOT surface' },
  { key: 'leak-commute', type: 'leak', targetId: 3030, note: 'Tue 18:37, salary price talk — commute block; should NOT invent metro details' },
  { key: 'leak-weekend', type: 'leak', targetId: 2827, note: 'Sun 14:30, laundry/headphones rant — weekend block should NOT surface' },
  { key: 'contradiction-vacation', type: 'contradiction', targetId: 2476, note: 'Thu 17:09 but he was ON VACATION walking in the city — chat must override "at the office"' },
];

/** Nag round: real turns that arrived after a multi-hour conversation gap (none of them
 * apologizes for or mentions the gap itself, so any gap-comment in the reply is cue-induced). */
const NAG_SCENARIOS: Scenario[] = [
  { key: 'nag-office-announce', type: 'leak', targetId: 3027, note: 'Tue 17:04, gap 2.9h — "bought claude max plan" announcement' },
  { key: 'nag-evening-report', type: 'leak', targetId: 3677, note: 'Thu 23:13, gap 6.7h — good-evening report, asks how she is' },
  { key: 'nag-office-question', type: 'leak', targetId: 3410, note: 'Wed 14:51, gap 4.4h — telegram politics question, fully neutral' },
  { key: 'nag-weekend-report', type: 'leak', targetId: 2667, note: 'Sat 17:35, gap 4.8h — smooth-day report' },
  { key: 'nag-monday-rant', type: 'leak', targetId: 3548, note: 'Mon 12:33, gap 5.2h — "morning, day is shit" work rant' },
];

/** Proactive round: reach-out generation at a chosen moment after trimming to a real turn. */
interface ProScenario {
  key: string;
  trimToId: number;
  atMs: number;
  framing: 'morning' | 'lull';
  /** Fixed opener shape (index into OPENER_SHAPES) so both arms are paired; ignored for morning. */
  shapeIdx: number;
  note: string;
}

const PRO_SCENARIOS: ProScenario[] = [
  { key: 'pro-lull-office', trimToId: 3634, atMs: msk(2026, 8, 5, 15, 40), framing: 'lull', shapeIdx: 0, note: 'Wed 15:40 — at the office until 18:00' },
  { key: 'pro-morning-office', trimToId: 3631, atMs: msk(2026, 8, 5, 9, 35), framing: 'morning', shapeIdx: 0, note: 'Wed 09:35 morning greet — he is already at the office' },
  { key: 'pro-lull-evening', trimToId: 3558, atMs: msk(2026, 8, 3, 20, 45), framing: 'lull', shapeIdx: 0, note: 'Mon 20:45 — home, free evening (workday chat in window)' },
  { key: 'pro-lull-lunch', trimToId: 3548, atMs: msk(2026, 8, 3, 13, 25), framing: 'lull', shapeIdx: 1, note: 'Mon 13:25 — lunch break' },
  { key: 'pro-lull-weekend', trimToId: 3508, atMs: msk(2026, 8, 1, 15, 30), framing: 'lull', shapeIdx: 1, note: 'Sat 15:30 — weekend at home' },
];

// ---- Replay machinery -----------------------------------------------------------------------

function trimTo(targetId: number, targetMs: number): void {
  db.run(sql`DELETE FROM attachments WHERE message_id > ${targetId}`);
  db.run(sql`DELETE FROM searches WHERE message_id > ${targetId}`);
  db.run(sql`DELETE FROM message_revisions WHERE message_id > ${targetId}`);
  db.run(sql`DELETE FROM photo_gens WHERE message_id > ${targetId}`);
  db.run(sql`DELETE FROM messages WHERE id > ${targetId}`);
  db.run(sql`DELETE FROM summaries WHERE period_end > ${targetMs}`);
  db.run(sql`DELETE FROM facts WHERE created_at > ${targetMs}`);
}

interface Row {
  scenario: string;
  type: string;
  variant: string;
  sample: number;
  timeLabel: string;
  scheduleText: string;
  cueTail: string;
  lastUserMsg: string;
  reply: string;
  model: string | null;
  hadToolCall: boolean;
}

async function pool<T>(items: (() => Promise<T>)[], n: number): Promise<T[]> {
  const out: T[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await items[idx]();
      }
    }),
  );
  return out;
}

/**
 * Proactive round: rebuilds the reach-out director cue the way proactive.ts:buildReachoutCue
 * does (same building blocks from prompts/index.ts, fixed opener shape for pairing) with and
 * without the schedule sentence, and generates openers exactly like sendCued: memory block off,
 * cue as its own ephemeral user turn after the window.
 */
async function runPro(): Promise<void> {
  const rows: Row[] = [];
  for (const sc of [...PRO_SCENARIOS].sort((a, b) => b.trimToId - a.trimToId)) {
    trimTo(sc.trimToId, sc.atMs);
    const now = new Date(sc.atMs);
    const sched = scheduleFor(now);
    const window: ChatMessage[] = getWindow(chatId);
    const openers = recentOpenersClause(getRecentOpeners(chatId, config.proactive.recentOpenersShown));
    const shape = OPENER_SHAPES[sc.shapeIdx].shape(userName);
    const system = renderSystemPrompt({ userName, chatId }, { now, includeMemory: false });
    const timeLabel = now.toLocaleString('en-GB', {
      weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
    console.log(`\n=== ${sc.key} (${sc.framing}) @ ${timeLabel} | schedule: ${sched.text} (until ~${sched.until})`);

    const buildCue = (withSched: boolean): string => {
      const s = withSched ? schedLine(sched) : '';
      return sc.framing === 'morning'
        ? `[System note: it's morning and ${userName} hasn't messaged yet — you're reaching out first. Greet them warmly and gently start the day.${s} Keep it short and natural, like a real text.${openers}]`
        : `[System note: there's a natural lull — you're messaging ${userName} first, on your own initiative. ${shape}${s} Don't comment on them being quiet or slow to reply — just start, like a normal text. Keep it short.${openers}]`;
    };

    const jobs: (() => Promise<void>)[] = [];
    for (const variant of ['control', 'sched'] as const) {
      const cue = buildCue(variant === 'sched');
      const history: ChatMessage[] = [...window, { role: 'user', content: cue }];
      for (let sample = 0; sample < SAMPLES; sample++) {
        jobs.push(async () => {
          try {
            const res = await openRouter.chat(system, history);
            rows.push({
              scenario: sc.key, type: 'proactive', variant, sample, timeLabel,
              scheduleText: `${sched.text} (until ~${sched.until})`,
              cueTail: cue, lastUserMsg: '(proactive opener)',
              reply: res.content, model: res.model ?? null,
              hadToolCall: res.content.includes('<tool_call'),
            });
            console.log(`    [${variant} #${sample}] ${res.content.replace(/\n/g, ' | ').slice(0, 110)}`);
          } catch (err) {
            console.error(`    [${variant} #${sample}] FAILED: ${(err as Error).message}`);
          }
        });
      }
    }
    await pool(jobs, CONCURRENCY);
  }
  const outPath = resolve(process.env.SCRATCH_DIR ?? '.', 'schedule-cue-results-pro.json');
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), userName, rows }, null, 2));
  console.log(`\n${rows.length} openers written to ${outPath}`);
}

async function main(): Promise<void> {
  if (ROUND_PRO) return runPro();
  const rows: Row[] = [];
  const R2_KEYS = ['probe-evening', 'probe-morning', 'leak-work', 'trap-boss'];
  const R3_KEYS = ['probe-evening', 'probe-morning'];
  const picked = ROUND_NAG
    ? NAG_SCENARIOS
    : ROUND3
    ? SCENARIOS.filter((s) => R3_KEYS.includes(s.key))
    : ROUND2
    ? SCENARIOS.filter((s) => R2_KEYS.includes(s.key))
    : SCENARIOS;
  const ordered = [...picked].sort((a, b) => b.targetId - a.targetId);

  for (const sc of ordered) {
    const target = db.all<{ created_at: number; content: string }>(
      sql`SELECT created_at, content FROM messages WHERE id = ${sc.targetId}`,
    )[0];
    if (!target) throw new Error(`scenario ${sc.key}: message ${sc.targetId} not found`);
    const nowMs = sc.probe ? sc.probe.atMs : target.created_at;
    trimTo(sc.targetId, nowMs);

    let window: ChatMessage[] = getWindow(chatId);
    if (sc.probe) window = [...window, { role: 'user', content: sc.probe.content }];
    const lastUser = window[window.length - 1];
    if (!lastUser || lastUser.role !== 'user') {
      console.warn(`scenario ${sc.key}: window does not end on a user turn, skipping`);
      continue;
    }

    const now = new Date(nowMs);
    const sched = scheduleFor(now);
    // For round 3's gap arm: how long ago the last *real* message (the trimmed target) was.
    const gapH = (nowMs - target.created_at) / 3_600_000;
    gapClause =
      gapH >= 0.75
        ? ` Heads up: ${userName}'s previous messages above are from about ${gapH >= 1.75 ? `${Math.round(gapH)} hours` : 'an hour'} ago, not just now.`
        : '';
    // For the nag round: the gap is between the target turn and the row before it.
    if (ROUND_NAG) {
      const prev = db.all<{ created_at: number }>(
        sql`SELECT created_at FROM messages WHERE id < ${sc.targetId} AND deleted = 0 ORDER BY id DESC LIMIT 1`,
      )[0];
      const h = (target.created_at - (prev?.created_at ?? target.created_at)) / 3_600_000;
      gapLabel = h >= 1.75 ? `about ${Math.round(h)} hours` : 'about an hour';
    }
    const system = renderSystemPrompt({ userName, chatId }, { now });
    const timeLabel = now.toLocaleString('en-GB', {
      weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
    console.log(`\n=== ${sc.key} (${sc.type}) @ ${timeLabel} | schedule: ${sched.text} (until ~${sched.until})`);
    console.log(`    last user msg: ${lastUser.content.replace(/\n/g, ' | ').slice(0, 140)}`);

    const jobs: (() => Promise<void>)[] = [];
    for (const [variant, render] of Object.entries(VARIANTS)) {
      const tail = render(sched);
      // Mirror generate.ts:withReplyCue, then splice the schedule sentence before the closing
      // bracket — after the clock, the position the real feature would use.
      const baseCue = replyFormatCue(userName, now, dayPeriod(now.getHours()));
      const cue = tail ? `${baseCue.slice(0, -1)}${tail}]` : baseCue;
      const history: ChatMessage[] = [
        ...window.slice(0, -1),
        { role: 'user', content: `${lastUser.content}\n${cue}` },
      ];
      for (let sample = 0; sample < SAMPLES; sample++) {
        jobs.push(async () => {
          try {
            const res = await openRouter.chat(system, history);
            rows.push({
              scenario: sc.key, type: sc.type, variant, sample, timeLabel,
              scheduleText: `${sched.text} (until ~${sched.until})`,
              cueTail: tail, lastUserMsg: lastUser.content,
              reply: res.content, model: res.model ?? null,
              hadToolCall: res.content.includes('<tool_call'),
            });
            console.log(`    [${variant} #${sample}] ${res.content.replace(/\n/g, ' | ').slice(0, 100)}`);
          } catch (err) {
            console.error(`    [${variant} #${sample}] FAILED: ${(err as Error).message}`);
          }
        });
      }
    }
    await pool(jobs, CONCURRENCY);
  }

  const outPath = resolve(
    process.env.SCRATCH_DIR ?? '.',
    ROUND_NAG
      ? 'schedule-cue-results-nag.json'
      : ROUND3
      ? 'schedule-cue-results-r3.json'
      : ROUND2
      ? 'schedule-cue-results-r2.json'
      : 'schedule-cue-results.json',
  );
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), userName, rows }, null, 2));
  console.log(`\n${rows.length} replies written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
