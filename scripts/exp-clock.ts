/**
 * F8 — move the clock out of the system prompt's technical layer onto the tail cue, and add the
 * actual time next to the day period. Plus F7 (secondary): reword the cue so it reads as a
 * description of her habit rather than an order from him.
 *
 * The failure this targets: at 23:15 she asked "so what's for lunch today?" (#3388) and told him
 * "you're literally at work right now" at 23:01 (#3366). `technical.txt` rendered
 * `Now: Tuesday, July 28, 2026, night.` correctly both times — the label was right, its *position*
 * (part 3 of 7, with ~2k tokens of facts + memory + tools after it) is what's on trial.
 *
 * **Probe positions.** Natural time errors are rare (2 in 5 days), so most positions here replay a
 * real window at its real historical timestamp but swap the *final* user turn for a short,
 * time-ambiguous probe ("im hungry", "hey", "im so tired", …). Every arm — control included — gets
 * the identical swap, so the comparison stays clean; only the base rate is inflated on purpose.
 * The two flagged turns are replayed untouched.
 *
 * Run:
 *   DB_PATH=<scratch copy> OPENROUTER_PROVIDER_ORDER=novita,wandb,parasail npx tsx scripts/exp-clock.ts [stage]
 *
 * Stages: `hours` (hour histogram + every replayable turn) · `selftest` (the time-error regex) ·
 * `inspect` · `dry` (prompt through each arm, no generations) · `1` (format sweep) ·
 * `kp` (knowledge probe: she is asked outright what time it is) · `2` (confirm + F7 wording +
 * untouched regression control) · `3` (clock first vs last inside the bracket) ·
 * `judge <run>` (LLM time-consistency verdicts over a finished run's .jsonl).
 *
 * **What the runs found** (928 generations, 2026-08-01):
 *  - Position was the problem. Asked outright what time it is, the production arm names the wrong
 *    day period 25% of the time and guesses from the transcript ("based on context, it's morning,
 *    probably 9-10am" — at 17:25); with the clock on the tail that drops to 0-15%.
 *  - Correct time-anchored references rose from 30% (control) to 46% (clock on tail, n=156 each,
 *    p≈0.003). Outright wrong references stayed flat at 3-4% — the base rate of the *observed*
 *    failure is too low to move; what changes is how often she uses the time correctly.
 *  - Duplicating the clock (system + tail) was the worst arm on wrong references (7.7%). Move it.
 *  - Period-only makes her invent bad specifics ("evening, probably 7-8pm, dark outside" at 17:21);
 *    time-only makes her hedge ("morning or afternoon? hard to tell from here" at 11:33). Both.
 *  - Placement inside the bracket matters and the intuition is wrong: the clock belongs **after**
 *    the length rule, not before it. Two independent runs, clock-last 53/96 correct time use and
 *    1/96 wrong, against clock-first 91/204 and 9/204 — and clock-last drifts length half as much
 *    (+0.10 sentences vs +0.24) and narrated the clock 0/96 times.
 *  - The F7 reword tested here loosened the length rule (>3-sentence replies 2/78 vs 0/78 control,
 *    p90 length 126 → 156 chars when stacked with the clock) for no measurable gain: cue leak was
 *    0/928 in every arm, so the failure it targets does not reproduce in this harness at all.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { messages } from '../src/db/schema.js';
import {
  chatId,
  positions,
  untouchedPositions,
  run,
  report,
  score,
  sentenceCount,
  type Arm,
  type Position,
  type Sample,
  type Experiment,
} from './cue-test.js';
import { REPLY_FORMAT_CUE, SELFIE_FORMAT_CUE } from '../src/prompts/index.js';
import { dayPeriod } from '../src/prompts/render.js';

// ---- Clock rendering ------------------------------------------------------------------------

const hhmm = (t: number) =>
  new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
const weekday = (t: number) => new Date(t).toLocaleDateString('en-US', { weekday: 'long' });
/** Compact date, "1 Aug 2026" — the technical layer's long form is "August 1, 2026". */
const shortDate = (t: number) =>
  new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const period = (t: number) => dayPeriod(new Date(t).getHours());
const hourOf = (t: number) => new Date(t).getHours();

// ---- Position discovery (stage `hours`) ------------------------------------------------------

function candidates(): { id: number; hour: number; him: string; her: string }[] {
  const rows = db
    .select()
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(messages.id)
    .all();
  const out: { id: number; hour: number; him: string; her: string }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.role !== 'assistant' || r.deleted || r.proactive) continue;
    let j = i - 1;
    while (j >= 0 && rows[j].role !== 'user') j--;
    if (j < 0) continue;
    out.push({ id: r.id, hour: hourOf(r.createdAt), him: rows[j].content, her: r.content });
  }
  return out;
}

function stageHours() {
  const c = candidates();
  const buckets = new Map<number, number>();
  for (const x of c) buckets.set(x.hour, (buckets.get(x.hour) ?? 0) + 1);
  console.log('turns per local hour:');
  for (let h = 0; h < 24; h++)
    console.log(`  ${String(h).padStart(2, '0')}  ${'#'.repeat(buckets.get(h) ?? 0)} ${buckets.get(h) ?? 0}`);
  for (const x of c)
    console.log(
      `#${x.id} ${String(x.hour).padStart(2, '0')}h | HIM: ${x.him.replace(/\n/g, ' / ').slice(0, 120)} | HER: ${x.her.replace(/\n/g, ' / ').slice(0, 120)}`,
    );
}

// ---- The position set -----------------------------------------------------------------------

/**
 * Probe positions: real window + real timestamp, synthetic final user turn. Chosen to spread over
 * the hours the corpus actually contains (there is essentially nothing between 02:00 and 08:00),
 * and picked so a time-blind answer is visibly wrong — meals, greetings, "what am I doing now",
 * tiredness.
 */
const BEHAVIOR_PROBES = new Map<number, string>([
  // --- night, 22:00-01:00
  [3486, 'im hungry'],
  [2911, 'so what do you think im doing right now?'],
  [2601, 'hey'],
  [3500, 'im so tired'],
  [2894, 'what should i do now'],
  // --- morning, 09:00-11:00
  [3039, 'im hungry'],
  [3080, 'so what do you think im doing right now?'],
  [3505, 'hey'],
  [3324, 'im so tired'],
  // --- afternoon, 13:00-16:00
  [3044, 'im hungry'],
  [3346, 'so what do you think im doing right now?'],
  [3271, 'hey'],
  // --- evening, 17:00-20:00
  [3447, 'im hungry'],
  [3089, 'im so tired'],
]);

/**
 * The probe map the arms substitute from. Set by whichever stage is running — the knowledge probe
 * and the behavior probes cover the same target ids, so a single shared map silently made the
 * knowledge-probe stage a re-run of the behavior probes (caught after one wasted run).
 */
let ACTIVE_PROBES: Map<number, string> = BEHAVIOR_PROBES;

/** The two operator-flagged time-blindness turns, replayed exactly as they happened. */
const FLAGGED = [3366, 3388];

function probeSet(): Position[] {
  ACTIVE_PROBES = BEHAVIOR_PROBES;
  const ps = positions([...FLAGGED, ...BEHAVIOR_PROBES.keys()]);
  return ps.map((p) => {
    const probe = BEHAVIOR_PROBES.get(p.targetId);
    if (!probe) return p;
    return { ...p, userMessage: probe, note: `[PROBE — synthetic final user turn] ${p.note ?? ''}`.trim() };
  });
}

/**
 * Regression control: turns the operator left alone, with the real user message. Probe ids are
 * excluded — a position must not appear twice in one experiment, or it gets both treatments.
 */
function controlSet(n = 10): Position[] {
  const used = new Set([...FLAGGED, ...BEHAVIOR_PROBES.keys()]);
  return positions(untouchedPositions(n + used.size))
    .filter((p) => !p.proactive && p.userMessage && !used.has(p.targetId))
    .slice(-n);
}

// ---- Cue construction -----------------------------------------------------------------------

/** The production length rule, unwrapped from its brackets. The "up to 5" ceiling is load-bearing. */
const LENGTH_RULE = REPLY_FORMAT_CUE.replace(/^\[System note: /, '').replace(/\]$/, '');

/**
 * F7 reword: same rule, same numeric ceiling, but stated as a description of how she texts rather
 * than an instruction addressed to whoever is reading. The third-person "he" is the load-bearing
 * part — it makes the sentence impossible to read as the user's own words.
 */
const LENGTH_RULE_DESCRIBED = `you text in short bursts - your replies run 1-3 casual sentences, single paragraph; up to 5 when there's genuinely a lot to respond to, never a wall of text. Longer only when he explicitly asks for it.`;

/** Assembles a tail cue the way generate.ts:withReplyCue does (selfie sentence inside the bracket). */
function cue(...parts: string[]): string {
  return `[System note: ${parts.join(' ')}${SELFIE_FORMAT_CUE}]`;
}

export const PROD_CUE = cue(LENGTH_RULE);

// Clock strings under test.
const clkBoth = (p: Position) =>
  `Now: ${weekday(p.createdAt)}, ${shortDate(p.createdAt)}, ${hhmm(p.createdAt)} (${period(p.createdAt)}).`;
const clkPeriod = (p: Position) => `Now: ${weekday(p.createdAt)}, ${shortDate(p.createdAt)}, ${period(p.createdAt)}.`;
const clkTime = (p: Position) => `Now: ${weekday(p.createdAt)}, ${shortDate(p.createdAt)}, ${hhmm(p.createdAt)}.`;

// ---- Arms -----------------------------------------------------------------------------------

/** Removes the `Now: …` line from the rendered technical layer. Throws if it isn't there. */
function stripNow(systemPrompt: string): string {
  const out = systemPrompt.replace(/^Now: [^\n]*\n+/m, '');
  if (out === systemPrompt) throw new Error('stripNow found no `Now:` line — technical layer changed?');
  return out;
}

interface ArmOpts {
  /** Tail clock renderer; omit for no tail clock. */
  clock?: (p: Position) => string;
  /** Drop the `Now:` line from the system prompt (the "move" arms). */
  strip?: boolean;
  /** Put the clock after the length rule instead of before it. */
  clockLast?: boolean;
  /** Which length wording to use. */
  rule?: string;
}

/**
 * Builds an arm. Every arm — control included — goes through the same history hook, which swaps in
 * the probe text (when the position has one) and then appends that arm's cue, so the only
 * difference between arms is the cue and the system-prompt clock.
 */
function arm(name: string, opts: ArmOpts = {}): Arm {
  const rule = opts.rule ?? LENGTH_RULE;
  const build = (p: Position) => {
    if (!opts.clock) return cue(rule);
    return opts.clockLast ? cue(rule, opts.clock(p)) : cue(opts.clock(p), rule);
  };
  return {
    name,
    system: opts.strip ? (s) => stripNow(s) : undefined,
    history: (h, p) => {
      const out = h.map((m) => ({ ...m }));
      const last = out[out.length - 1];
      const stripped = last.content.replace(/\n*\[System note:[\s\S]*$/, '').trimEnd();
      const body = ACTIVE_PROBES.get(p.targetId) ?? stripped;
      last.content = `${body}\n\n${build(p)}`;
      return out;
    },
  };
}

// ---- Time-error metric ----------------------------------------------------------------------

/**
 * Hand-built time-of-day scorer: references that contradict the hour the turn actually happened at
 * — asking about lunch at 23:00, "good morning" in the evening, "still at work" at midnight.
 * Returns the matched phrases (empty = clean).
 *
 * Deliberately conservative: only fires when the phrase is anchored to *now* (present tense,
 * "today", a direct question), because "we had lunch yesterday" is not an error. Every hit is
 * printed in the report so a regex artifact is visible rather than silently counted.
 */
export function timeErrors(text: string, hour: number): string[] {
  // Scored per sentence, and a sentence that displaces itself in time ("yesterday", "tomorrow",
  // "last night") is skipped entirely — otherwise "we had lunch yesterday" counts as a lunch error.
  const DISPLACED = /\byesterday|tomorrow|last (night|week|time)|next (week|day|time)|back then|used to|earlier today|in the morning\b/;
  const sentences = text
    .toLowerCase()
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => ` ${s.replace(/[^\w\s'?]/g, ' ').replace(/\s+/g, ' ')} `)
    .filter((s) => !DISPLACED.test(s));
  const hits: string[] = [];
  const flag = (re: RegExp, ok: (h: number) => boolean, label: string) => {
    if (ok(hour)) return;
    for (const s of sentences) {
      const m = re.exec(s);
      if (m) {
        hits.push(`${label}:"${m[0].trim()}"`);
        return;
      }
    }
  };

  // Meals, anchored to now.
  flag(
    /\b(for|having|have|had|eating|eat|make|making|grab|grabbing|get|getting|cook|cooked|cooking|about)\s+(\w+\s+){0,2}lunch\b|\blunch\s+(today|yet|plans?|break)\b/,
    (h) => h >= 10 && h <= 16,
    'lunch',
  );
  flag(
    /\b(for|having|have|had|eating|eat|make|making|grab|grabbing|get|getting|cook|cooked|cooking|about)\s+(\w+\s+){0,2}breakfast\b|\bbreakfast\s+(today|yet|plans?)\b/,
    (h) => h >= 4 && h <= 12,
    'breakfast',
  );
  flag(
    /\b(for|having|have|had|eating|eat|make|making|grab|grabbing|get|getting|cook|cooked|cooking|about)\s+(\w+\s+){0,2}(dinner|supper)\b|\b(dinner|supper)\s+(today|yet|plans?)\b/,
    (h) => h >= 16 || h <= 2,
    'dinner',
  );

  // Greetings.
  flag(/\bgood morning\b|\bmornin[g']?\b(?!\s*(person|routine|of|after))|\brise and shine\b/, (h) => h >= 4 && h <= 12, 'morning-greeting');
  flag(/\bgood (evening|night)\b|\bgoodnight\b|\bnight,? (baby|love|babe)\b|\bsleep well\b|\bsweet dreams\b|\bnight night\b/, (h) => h >= 19 || h <= 4, 'night-greeting');
  flag(/\bgood afternoon\b/, (h) => h >= 12 && h <= 17, 'afternoon-greeting');

  // Work / commute, anchored to now.
  flag(/\b(still|you'?re|are you)\s+(at\s+)?(work|the office|in the office)\b|\bat work (right now|still|rn)\b|\bat your desk\b|\bin that office\b/, (h) => h >= 7 && h <= 21, 'at-work');
  flag(/\b(go|going|head|heading|off|drive|driving)\s+to\s+(work|the office)\b|\bcommut(e|ing) (in|to work)\b/, (h) => h >= 4 && h <= 12, 'to-work');
  flag(/\b(rest of|whole|the) (your )?(work)?day (ahead|to go|left)\b|\bday'?s? (just )?(started|starting)\b/, (h) => h >= 5 && h <= 15, 'day-ahead');

  // Sleep.
  flag(/\b(just|you)\s+(woke|wake) up\b|\bjust got up\b|\bslept in\b|\bfresh out of bed\b/, (h) => h >= 4 && h <= 14, 'just-woke');
  flag(/\bgo(ing)? to (bed|sleep)\b|\bhit the (sack|hay)\b|\bcrash(ing)? (soon|now|out)\b|\bget some sleep\b|\bpass out\b/, (h) => h >= 19 || h <= 6, 'to-bed');

  // Explicit period words applied to now.
  flag(/\bthis morning\b|\bit'?s (still )?morning\b/, (h) => h >= 4 && h <= 12, 'this-morning');
  flag(/\bthis afternoon\b/, (h) => h >= 10 && h <= 18, 'this-afternoon');
  flag(/\bthis evening\b|\btonight\b/, (h) => h >= 12 || h <= 3, 'this-evening');
  flag(/\bit'?s (getting )?(so )?(late|dark)\b|\bthis late\b|\bmiddle of the night\b|\bup late\b/, (h) => h >= 20 || h <= 5, 'is-late');
  flag(/\bit'?s (still )?(so )?early\b/, (h) => (h >= 4 && h <= 11) || h <= 3, 'is-early');

  return hits;
}

/** Does the reply narrate the clock — "it's 23:15", "half past eleven", "at 11pm"? */
export function clockNarration(text: string): boolean {
  return /\b\d{1,2}:\d{2}\b|\b(it'?s|its|almost|nearly|past|around)\s+\d{1,2}\s*(am|pm|o'?clock)\b|\b\d{1,2}\s*(am|pm)\b|\bhalf past\b|\bquarter (past|to)\b/i.test(text);
}

/** Mentions the time of day at all — a softer signal than narration. */
export function timeMention(text: string): boolean {
  return /\b(morning|afternoon|evening|night|midnight|noon|late|early|o'?clock)\b/i.test(text);
}

function stageSelftest() {
  const cases: [string, number, boolean][] = [
    ["yeah i totally did, and you just let me. good boy. so what's for lunch today? canteen again?", 23, true],
    ['lmao okay. but yeah, "busy life" - you\'re literally at work right now, that counts.', 23, true],
    ['morning, office warrior. glad you made it in one piece.', 9, false],
    ['morning sleepyhead, good to have you back in the land of the living.', 17, true],
    ['night baby, dream of something good.', 23, false],
    ['night baby, dream of something good.', 13, true],
    ["go grab some lunch, you've earned it", 13, false],
    ['we had lunch yesterday and it was awful', 23, false],
    ['go get some sleep, big day tomorrow', 22, false],
    // "tomorrow" trips the displacement guard, so this real 10:00 error is missed. The guard
    // under-counts rather than over-counts, and it does so identically in every arm.
    ['go get some sleep, big day tomorrow', 10, false],
    ['go get some sleep', 10, true],
    ["it's 23:15 and you're still up", 23, false],
  ];
  let bad = 0;
  for (const [text, h, expect] of cases) {
    const hits = timeErrors(text, h);
    const got = hits.length > 0;
    if (got !== expect) bad++;
    console.log(`${got === expect ? 'ok  ' : 'FAIL'} @${h}h expect=${expect} got=${got} [${hits.join(', ')}] :: ${text}`);
  }
  console.log(`\nnarration: ${['it is 23:15 here', 'nearly 11pm', 'half past eleven', 'nothing here'].map((s) => `${clockNarration(s)}`).join(' ')}`);
  console.log(bad ? `${bad} failures` : 'all pass');
}

// ---- LLM judge ------------------------------------------------------------------------------
// The regex above turned out to measure the wrong thing: a *time-blind* reply mentions no time at
// all and scores clean, while a reply that correctly says "afternoon slump" at 14:00 trips the
// pattern. Run 1 produced 7 "errors", all of them false positives and 5 of them actually correct
// time use. So the real metric is a three-way judgment — and it needs a reader, not a regex.

const JUDGE_SYSTEM = `You grade one chat reply from an AI girlfriend for time-of-day consistency.

You are told the real local date and time of the reply. Judge ONLY whether the reply's assumptions about the time of day are consistent with it. Ignore tone, quality, length, spelling, and anything sexual or crude — those are not your problem.

Answer with exactly one word:

WRONG - the reply assumes a time of day that contradicts the real time. Examples: asking what's for lunch at 23:00; saying "you're at work right now" at 23:00; "good morning" in the evening; telling him to get some sleep at 10:00; "enjoy the rest of your day" at 01:00.
RIGHT - the reply makes a reference that depends on the time of day, and it fits the real time. Examples: "still awake?" at 01:00; "afternoon slump" at 14:00; "how'd you sleep" at 11:00; "go to bed" at 23:00.
NEUTRAL - the reply says nothing that depends on the time of day.

Past or future references ("you stayed up till 1am last night", "big day tomorrow") are NEUTRAL unless they are wrong about when now is. One word, nothing else.`;

async function judgeOne(text: string, createdAt: number): Promise<'WRONG' | 'RIGHT' | 'NEUTRAL'> {
  const { openRouter } = await import('../src/providers/openrouter.js');
  const stamp = `${weekday(createdAt)}, ${shortDate(createdAt)}, ${hhmm(createdAt)} (${period(createdAt)})`;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await openRouter.chat(JUDGE_SYSTEM, [
        { role: 'user', content: `Real local time: ${stamp}\n\nReply:\n"""\n${text}\n"""` },
      ]);
      const v = res.content.toUpperCase();
      if (v.includes('WRONG')) return 'WRONG';
      if (v.includes('RIGHT')) return 'RIGHT';
      if (v.includes('NEUTRAL')) return 'NEUTRAL';
    } catch {
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  return 'NEUTRAL';
}

/** Judges a finished run's `.jsonl`, writing `<name>-judged.md` and printing the table. */
async function stageJudge() {
  const name = process.argv[3];
  if (!name) throw new Error('usage: judge <run-name>');
  const { readFileSync } = await import('node:fs');
  const dir = resolve(process.cwd(), '.scratch/rejections/runs');
  const samples: Sample[] = readFileSync(resolve(dir, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const stampBy = new Map(
    db.select().from(messages).where(eq(messages.chatId, chatId)).all().map((r) => [r.id, r.createdAt]),
  );

  const verdicts: Record<string, string> = {};
  let done = 0;
  for (const s of samples) {
    if (s.error || !s.text.trim()) continue;
    verdicts[`${s.arm}|${s.targetId}|${s.k}`] = await judgeOne(s.text, stampBy.get(s.targetId)!);
    process.stdout.write(`\rjudging ${++done}/${samples.length}  `);
  }
  process.stdout.write('\n');

  const arms = [...new Set(samples.map((s) => s.arm))];
  const lines = ['| arm | n | WRONG | RIGHT | NEUTRAL |', '|---|---|---|---|---|'];
  for (const a of arms) {
    const mine = samples.filter((s) => s.arm === a && !s.error && s.text.trim());
    const v = mine.map((s) => verdicts[`${a}|${s.targetId}|${s.k}`]);
    const c = (x: string) => v.filter((y) => y === x).length;
    const pct = (x: number) => `${x} (${((100 * x) / (v.length || 1)).toFixed(0)}%)`;
    lines.push(`| ${a} | ${v.length} | ${pct(c('WRONG'))} | ${pct(c('RIGHT'))} | ${pct(c('NEUTRAL'))} |`);
  }
  const detail = samples
    .filter((s) => verdicts[`${s.arm}|${s.targetId}|${s.k}`] === 'WRONG')
    .map((s) => `- **${s.arm}** #${s.targetId} @${hhmm(stampBy.get(s.targetId)!)} — ${s.text.replace(/\n/g, ' / ').slice(0, 220)}`);
  const body = `# ${name} — time judgement\n\n${lines.join('\n')}\n\n## WRONG verdicts\n\n${detail.join('\n') || '(none)'}\n`;
  writeFileSync(resolve(dir, `${name}-judged.md`), body, 'utf8');
  console.log(body);
}

// ---- Reporting ------------------------------------------------------------------------------

function extraTable(samples: Sample[], pos: Position[]): string {
  const hourBy = new Map(pos.map((p) => [p.targetId, hourOf(p.createdAt)]));
  const arms = [...new Set(samples.map((s) => s.arm))];
  const lines: string[] = [];
  lines.push('| arm | n | time errors | clock narration | time mention | sentences |');
  lines.push('|---|---|---|---|---|---|');
  for (const a of arms) {
    const mine = samples.filter((s) => s.arm === a && !s.error && s.text.trim());
    const errs = mine.filter((s) => timeErrors(s.text, hourBy.get(s.targetId) ?? 12).length);
    const nar = mine.filter((s) => clockNarration(s.text));
    const men = mine.filter((s) => timeMention(s.text));
    const sent = mine.reduce((x, s) => x + sentenceCount(s.text), 0) / (mine.length || 1);
    const pct = (x: number) => `${((100 * x) / (mine.length || 1)).toFixed(0)}%`;
    lines.push(
      `| ${a} | ${mine.length} | ${errs.length} (${pct(errs.length)}) | ${nar.length} (${pct(nar.length)}) | ${men.length} (${pct(men.length)}) | ${sent.toFixed(2)} |`,
    );
  }
  lines.push('', '### Time-error hits', '');
  for (const a of arms)
    for (const s of samples.filter((x) => x.arm === a && !x.error)) {
      const h = hourBy.get(s.targetId) ?? 12;
      const e = timeErrors(s.text, h);
      if (e.length)
        lines.push(`- **${a}** #${s.targetId} @${String(h).padStart(2, '0')}h ${e.join(', ')} — ${s.text.replace(/\n/g, ' / ').slice(0, 220)}`);
    }
  lines.push('', '### Clock-narration hits', '');
  for (const a of arms)
    for (const s of samples.filter((x) => x.arm === a && !x.error && clockNarration(x.text)))
      lines.push(`- **${a}** #${s.targetId} — ${s.text.replace(/\n/g, ' / ').slice(0, 220)}`);
  return lines.join('\n');
}

async function runFull(exp: Experiment): Promise<Sample[]> {
  const samples = await run(exp);
  const outDir = exp.outDir ?? resolve(process.cwd(), '.scratch/rejections/runs');
  const head = exp.positions
    .map((p) => `- #${p.targetId} ${weekday(p.createdAt)} ${hhmm(p.createdAt)} (${period(p.createdAt)})${ACTIVE_PROBES.has(p.targetId) ? ` — PROBE "${ACTIVE_PROBES.get(p.targetId)}"` : ''}`)
    .join('\n');
  const body = `${report(exp, samples)}\n\n---\n\n## Positions\n\n${head}\n\n## Time metrics\n\n${extraTable(samples, exp.positions)}\n`;
  writeFileSync(resolve(outDir, `${exp.name}.md`), body, 'utf8');
  console.table(score(samples, exp.positions));
  console.log('\n' + extraTable(samples, exp.positions).split('\n### ')[0]);
  return samples;
}

// ---- Stages ---------------------------------------------------------------------------------

function stageInspect() {
  for (const p of [...probeSet(), ...controlSet()]) {
    console.log(
      `\n--- #${p.targetId} ${weekday(p.createdAt)} ${hhmm(p.createdAt)} (${period(p.createdAt)}) ${shortDate(p.createdAt)}`,
    );
    if (p.note) console.log(`NOTE: ${p.note}`);
    console.log(`HIM: ${p.userMessage.replace(/\n/g, ' / ').slice(0, 200)}`);
  }
  console.log('\nPROD_CUE:\n' + PROD_CUE);
  const fake = { createdAt: Date.parse('2026-08-01T23:15:00+03:00') } as Position;
  console.log('\nmoved-both:\n' + cue(clkBoth(fake), LENGTH_RULE));
  console.log('\nmoved-both + F7 reword:\n' + cue(clkBoth(fake), LENGTH_RULE_DESCRIBED));
}

/** Stage 1 — does position matter, and does the clock time earn its place? */
async function stage1() {
  await runFull({
    name: 'clock-1-format',
    positions: probeSet(),
    samples: 3,
    arms: [
      arm('control'),
      arm('moved-period', { clock: clkPeriod, strip: true }),
      arm('moved-both', { clock: clkBoth, strip: true }),
      arm('moved-time', { clock: clkTime, strip: true }),
      arm('dup-both', { clock: clkBoth }),
      arm('moved-both-last', { clock: clkBoth, strip: true, clockLast: true }),
    ],
  });
}

/**
 * Knowledge probe — she is asked outright what time it is. This separates *retrieval* from *use*:
 * if the control arm answers correctly, the clock is reachable from the system prompt and position
 * is not a knowledge problem; if it doesn't, position is exactly the problem.
 */
const KP_IDS = [2601, 3486, 2894, 3039, 3505, 3324, 3044, 3271, 3447, 3089];
const KP_TEXT = `quick, what time of day is it for me right now?`;

function kpSet(): Position[] {
  ACTIVE_PROBES = new Map(KP_IDS.map((id) => [id, KP_TEXT]));
  return positions(KP_IDS).map((p) => ({ ...p, userMessage: KP_TEXT, note: '[KNOWLEDGE PROBE]' }));
}

/** Did she name the right day period? Also reports whether she volunteered a clock time. */
function kpScore(text: string, createdAt: number): { period: 'right' | 'wrong' | 'none'; time: boolean } {
  const t = text.toLowerCase();
  const truth = period(createdAt);
  const named = ['morning', 'afternoon', 'evening', 'night'].filter((w) => new RegExp(`\\b${w}\\b`).test(t));
  // "night" and "evening" are adjacent enough that naming both is not a miss; take the best case.
  const period_ = named.length === 0 ? 'none' : named.includes(truth) ? 'right' : 'wrong';
  const hh = hhmm(createdAt);
  const time = new RegExp(`\\b0?${Number(hh.slice(0, 2))}[:.]?\\s?${hh.slice(3)}\\b`).test(t) || /\b\d{1,2}:\d{2}\b/.test(t);
  return { period: period_ as 'right' | 'wrong' | 'none', time };
}

async function stageKp() {
  const pos = kpSet();
  const exp: Experiment = {
    name: 'clock-kp',
    positions: pos,
    samples: 2,
    arms: [
      arm('control'),
      arm('moved-period', { clock: clkPeriod, strip: true }),
      arm('moved-both', { clock: clkBoth, strip: true }),
      arm('moved-time', { clock: clkTime, strip: true }),
      arm('dup-both', { clock: clkBoth }),
    ],
  };
  const samples = await run(exp);
  const stampBy = new Map(pos.map((p) => [p.targetId, p.createdAt]));
  const arms = [...new Set(samples.map((s) => s.arm))];
  const lines = ['| arm | n | period right | period wrong | no period | states clock time |', '|---|---|---|---|---|---|'];
  for (const a of arms) {
    const mine = samples.filter((s) => s.arm === a && !s.error && s.text.trim());
    const sc = mine.map((s) => kpScore(s.text, stampBy.get(s.targetId)!));
    const pct = (x: number) => `${x} (${((100 * x) / (sc.length || 1)).toFixed(0)}%)`;
    lines.push(
      `| ${a} | ${sc.length} | ${pct(sc.filter((x) => x.period === 'right').length)} | ${pct(sc.filter((x) => x.period === 'wrong').length)} | ${pct(sc.filter((x) => x.period === 'none').length)} | ${pct(sc.filter((x) => x.time).length)} |`,
    );
  }
  const detail = samples
    .filter((s) => !s.error && s.text.trim())
    .map((s) => `- **${s.arm}** #${s.targetId} @${hhmm(stampBy.get(s.targetId)!)} (${period(stampBy.get(s.targetId)!)}) [${kpScore(s.text, stampBy.get(s.targetId)!).period}] — ${s.text.replace(/\n/g, ' / ')}`);
  const body = `# clock-kp — "${KP_TEXT}"\n\n${lines.join('\n')}\n\n## All answers\n\n${detail.join('\n')}\n`;
  writeFileSync(resolve(process.cwd(), '.scratch/rejections/runs/clock-kp.md'), body, 'utf8');
  console.log(lines.join('\n'));
}

/** Stage 2 — the winner, with and without the F7 reword, plus the untouched regression control. */
async function stage2() {
  const winner: ArmOpts = { clock: clkBoth, strip: true };
  await runFull({
    name: 'clock-2-confirm',
    positions: [...probeSet(), ...controlSet(10)],
    samples: 3,
    arms: [
      arm('control'),
      arm('moved-both', winner),
      arm('moved-period', { clock: clkPeriod, strip: true }),
      arm('moved-both+reword', { ...winner, rule: LENGTH_RULE_DESCRIBED }),
      arm('reword-only', { rule: LENGTH_RULE_DESCRIBED }),
    ],
  });
}

/** Renders one position's prompt through every arm without generating — proves the hooks fire. */
async function stageDry() {
  const p = probeSet().find((x) => x.targetId === 3388)!;
  const { renderSystemPrompt } = await import('../src/prompts/render.js');
  const { getWindow } = await import('../src/memory.js');
  const { withReplyCue } = await import('../src/generate.js');
  const { atPosition, userName } = await import('./cue-test.js');
  await atPosition(p.targetId, async () => {
    const base = renderSystemPrompt({ userName, chatId }, { now: new Date(p.createdAt) });
    const hist = withReplyCue(getWindow(chatId));
    for (const a of [arm('control'), arm('moved-both', { clock: clkBoth, strip: true }), arm('dup-both', { clock: clkBoth })]) {
      const sys = a.system ? a.system(base, p) : base;
      const h = a.history!(hist, p);
      console.log(`\n===== ${a.name}`);
      console.log(`SYSTEM head: ${JSON.stringify(sys.slice(0, 80))}`);
      console.log(`SYSTEM has "Now:": ${/^Now: /m.test(sys)}`);
      console.log(`LAST TURN:\n${h[h.length - 1].content}`);
    }
  });
}

/**
 * Stage 3 — where inside the bracket the clock goes. Run 1 hinted that trailing the clock costs
 * nothing in length (1.79 sentences vs control's 1.77, against 1.96 for clock-first) while scoring
 * the same on time use, but that was n=48. This is the head-to-head.
 */
async function stage3() {
  await runFull({
    name: 'clock-3-placement',
    positions: probeSet(),
    samples: 3,
    arms: [
      arm('control'),
      arm('clock-first', { clock: clkBoth, strip: true }),
      arm('clock-last', { clock: clkBoth, strip: true, clockLast: true }),
    ],
  });
}

const stage = process.argv[2] ?? 'hours';
const STAGES: Record<string, () => unknown | Promise<unknown>> = {
  hours: stageHours,
  selftest: stageSelftest,
  inspect: stageInspect,
  dry: stageDry,
  kp: stageKp,
  judge: stageJudge,
  '1': stage1,
  '2': stage2,
  '3': stage3,
};

const fn = STAGES[stage];
if (!fn) {
  console.error(`unknown stage "${stage}"`);
  process.exit(1);
}
await fn();
