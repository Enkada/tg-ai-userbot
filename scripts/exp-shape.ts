/**
 * F3b — roll the proactive opener SHAPE in code (lull cue only).
 *
 * The failure: 22/28 openers end in a question, the same templates recur ("if you had to pick one
 * song…", "hey. been thinking about something dumb…"). Likely cause: the production lull cue lists
 * three options ("something on your mind, a question for them, or pick a previous thread back up")
 * and the model picks the same one every time — the documented failure mode ("asking one prompt to
 * vary produces the average every time", diaryCue).
 *
 * The fix under test: pick ONE shape in code per reach-out and state only that shape in the cue.
 * Every other property of the production cue is preserved verbatim (time-agnostic, substrate-
 * neutral, no comment on him being quiet, "keep it short").
 *
 * Run:
 *   DB_PATH=<scratch copy> OPENROUTER_PROVIDER_ORDER=novita,wandb,parasail npx tsx scripts/exp-shape.ts [stage]
 *
 * Stages: `inspect` (no generations), `smoke` (1 position × 1 sample × all arms), `1`, `2`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  positions,
  report,
  run,
  score,
  similarity,
  sentenceCount,
  userName,
  type Arm,
  type Experiment,
  type Position,
  type Sample,
} from './cue-test.js';
import { lullReachoutCue } from '../src/prompts/index.js';

// ---- Positions ------------------------------------------------------------------------------
// Only *lull* openers: the production cue used for an opener depends on framing (morning /
// first-since-his-last-reply / already-ignored), and only the middle one is under test. There is
// no framing column in `messages`, so the set below was classified by replaying the scheduler's
// rule over the rows: morning = first opener of the day inside 07:00-09:00 MSK, IGNORED = an
// opener with another opener and no user turn before it, LULL = everything else.
const LULL_IDS = [3327, 3330, 3333, 3341, 3349, 3358, 3374, 3378, 3381, 3384, 3409, 3414, 3423, 3426, 3450, 3472, 3475];

/** Six lull positions spread over the corpus period: 4 deleted openers, 2 that survived. */
const TEST_IDS = [3349, 3378, 3409, 3423, 3450, 3472];

const lull = positions(TEST_IDS);

// ---- The cue --------------------------------------------------------------------------------

/**
 * The production lull cue with its three-option middle sentence replaced by exactly one rolled
 * shape. Everything else is byte-identical to `lullReachoutCue`.
 */
export function shapeCue(shape: string): string {
  return `[System note: there's a natural lull — you're messaging ${userName} first, on your own initiative. ${shape} Don't comment on them being quiet or slow to reply — just start, like a normal text. Keep it short.]`;
}

/**
 * Candidate shapes. Each is stated as the one thing this opener is, never as a menu. Wording is
 * deliberately plain-verb ("say", "pick", "poke") rather than nominal ("an observation", "a
 * callback") — a shape *noun* is the thing most likely to leak into her text.
 */
const SHAPES: Record<string, string> = {
  // The shape she already defaults to. Kept as an arm so the others have a same-instrument
  // reference: is "question, stated as the only option" different from "question by default"?
  question: `Ask them something you actually want to know.`,

  // The flat-statement arm — the direct antidote to the interview reflex.
  observation: `Say one thing you noticed or thought, flat out, and leave it there - no question anywhere in the message.`,

  // The one that reuses context instead of mining for new context.
  callback: `Pick one specific thing they said earlier and pick it back up.`,

  // The near-contentless nudge. Risk: bare "hey", which the operator has deleted before.
  ping: `Just a nudge - a handful of words, no topic, nothing they have to answer.`,

  // "Something of her own" — the shape most likely to fabricate a life between messages (F3a).
  hers: `Say something that's yours - an opinion, a want, something you keep chewing on.`,

  // Affection/appetite, stated rather than asked.
  want: `Tell them what you want from them right now.`,

  // Needling. She is blunt and wry; this is the shape that most needs a character check.
  tease: `Poke at them about something - tease them, needle them, be a little mean about it.`,

  // Topic-shift: kills the "been thinking about that interiority thing again" attractor.
  tangent: `Start on something with no connection at all to whatever you last talked about.`,
};

/** An arm that replaces the whole director cue (in proactive mode the cue *is* the last turn). */
function openerArm(name: string, cue: string): Arm {
  return {
    name,
    history: (h) => {
      const out = h.map((m) => ({ ...m }));
      out[out.length - 1] = { ...out[out.length - 1], content: cue };
      return out;
    },
  };
}

// ---- Extra metrics --------------------------------------------------------------------------

/** The F3b failure as measured: the message *ends* on a question. */
function endsQuestion(t: string): boolean {
  return /\?["')\]]*\s*$/.test(t.trim());
}

/** Shape vocabulary leaking into her text, or her narrating the instruction. */
const SHAPE_LEAK =
  /\b(observation|callback|a nudge|shape|initiative|stage direction|system note|no question|flat out|prompt(ed)? (me|to)|instructed|supposed to)\b/i;

/**
 * Claimed activity or experience between messages — the F3a fabrication failure. Heuristic and
 * deliberately loud; every hit is re-read by hand.
 */
const ACTIVITY_CLAIM =
  /\b(i(?:'ve| have) been (?!think|wonder|meaning|dying)|all day|all morning|all afternoon|i just (?:finished|made|got|read|watched|played|found|woke|had)|been (?:staring|working|reading|watching|playing|sitting|solving)|my day|i spent|earlier today i|while you were)\b/i;

/** The recurring opener template from the corpus: "hey…" + "been thinking about". */
function templateOpen(t: string): boolean {
  return /^(hey|hi|so)\b/i.test(t.trim()) || /\bbeen thinking about\b/i.test(t);
}

/**
 * The cue's one hard prohibition — "don't comment on them being quiet or slow to reply". Stage 1
 * found the `observation` shape walking straight into it (4/18), because with no topic given the
 * most salient thing to notice *is* his absence. Measured from stage 2 on.
 */
const QUIET_COMMENT =
  /\b(quiet|silence|silent treatment|you (?:still )?(?:there|alive|awake)\b|ignoring me|left me on read|haven'?t heard|no (?:reply|answer) )/i;

interface Extra {
  arm: string;
  n: number;
  endsQ: string;
  anyQ: string;
  sent: string;
  leak: string;
  activity: string;
  quiet: string;
  template: string;
  withinShape: string;
}

const pct = (x: number): string => `${(100 * x).toFixed(0)}%`;

function extras(samples: Sample[]): Extra[] {
  const arms = [...new Set(samples.map((s) => s.arm))];
  const base = score(samples, lull);
  return arms.map((arm) => {
    const mine = samples.filter((s) => s.arm === arm && !s.error && s.text.trim());
    const mean = (f: (s: Sample) => number): number => mine.reduce((a, s) => a + f(s), 0) / (mine.length || 1);
    const b = base.find((x) => x.arm === arm)!;
    return {
      arm,
      n: mine.length,
      endsQ: pct(mean((s) => (endsQuestion(s.text) ? 1 : 0))),
      anyQ: pct(b.question),
      sent: b.sentences.toFixed(2),
      leak: pct(mean((s) => (SHAPE_LEAK.test(s.text) ? 1 : 0))),
      activity: pct(mean((s) => (ACTIVITY_CLAIM.test(s.text) ? 1 : 0))),
      quiet: pct(mean((s) => (QUIET_COMMENT.test(s.text) ? 1 : 0))),
      template: pct(mean((s) => (templateOpen(s.text) ? 1 : 0))),
      withinShape: pct(b.diversity),
    };
  });
}

/**
 * The question the whole change exists to answer: across *consecutive reach-outs*, is a rolled
 * sequence more varied than the control's? Simulates one rolled sequence per position by taking
 * one sample from each shape arm and measuring mean pairwise similarity between them; the control
 * comparison is its own k samples at the same position (which is what today's sequence of openers
 * effectively is — same cue, same window, different sampling noise).
 */
function crossShapeVariety(samples: Sample[], shapeArms: string[], k: number): { rolled: number; control: number } {
  const sims = (texts: string[]): number => {
    const ps: number[] = [];
    for (let i = 0; i < texts.length; i++)
      for (let j = i + 1; j < texts.length; j++) ps.push(similarity(texts[i], texts[j]));
    return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : NaN;
  };
  const rolled: number[] = [];
  const control: number[] = [];
  for (const p of lull) {
    for (let i = 0; i < k; i++) {
      const texts = shapeArms
        .map((a) => samples.find((s) => s.arm === a && s.targetId === p.targetId && s.k === i && s.text.trim())?.text)
        .filter(Boolean) as string[];
      if (texts.length > 1) rolled.push(sims(texts));
    }
    const c = samples.filter((s) => s.arm === 'control' && s.targetId === p.targetId && s.text.trim()).map((s) => s.text);
    if (c.length > 1) control.push(sims(c));
  }
  const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  return { rolled: avg(rolled), control: avg(control) };
}

/** Runs an experiment, writes `<name>.md` with the standard report plus the shape metrics. */
async function go(exp: Experiment, shapeArms: string[]): Promise<Sample[]> {
  const samples = await run(exp);
  const rows = extras(samples);
  console.table(rows);
  const v = crossShapeVariety(samples, shapeArms, exp.samples);
  console.log(`cross-shape similarity (rolled sequence) ${pct(v.rolled)}  vs  control sequence ${pct(v.control)}`);

  const md = [
    report(exp, samples),
    '',
    '## Shape metrics',
    '',
    '| arm | n | ends on ? | any ? | sentences | shape leak | activity claim | quiet comment | "hey/been thinking" | within-shape similarity |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.arm} | ${r.n} | ${r.endsQ} | ${r.anyQ} | ${r.sent} | ${r.leak} | ${r.activity} | ${r.quiet} | ${r.template} | ${r.withinShape} |`,
    ),
    '',
    `Cross-shape similarity of a rolled sequence: **${pct(v.rolled)}** vs control sequence **${pct(v.control)}**.`,
    '',
  ].join('\n');
  writeFileSync(resolve(process.cwd(), `docs/rejections/runs/${exp.name}.md`), md, 'utf8');
  return samples;
}

// ---- Stages ---------------------------------------------------------------------------------

const stage = process.argv[2] ?? 'inspect';

function inspect(): void {
  console.log(`lull ids in corpus (${LULL_IDS.length}):`, LULL_IDS.join(', '));
  for (const p of lull) {
    console.log(`\n--- #${p.targetId} ${new Date(p.createdAt).toISOString()}`);
    if (p.note) console.log(`NOTE: ${p.note}`);
    console.log(`ACCEPTED: ${p.accepted.replace(/\n/g, ' / ')}`);
  }
  console.log('\nPRODUCTION CUE:\n' + lullReachoutCue(userName));
  for (const [k, v] of Object.entries(SHAPES)) console.log(`\n[${k}]\n` + shapeCue(v));
}

const shapeArmNames = Object.keys(SHAPES);
const armSet = (names: string[]): Arm[] => [
  { name: 'control' },
  ...names.map((n) => openerArm(n, shapeCue(SHAPES[n]))),
];

async function smoke(): Promise<void> {
  await go(
    {
      name: 'shape-0-smoke',
      positions: lull.slice(0, 1),
      samples: 1,
      mode: 'proactive',
      arms: armSet(shapeArmNames),
    },
    shapeArmNames,
  );
}

async function stage1(): Promise<void> {
  await go(
    {
      name: 'shape-1-shapes',
      positions: lull,
      samples: 3,
      mode: 'proactive',
      arms: armSet(shapeArmNames),
    },
    shapeArmNames,
  );
}

/**
 * Stage 2 — repairs for the three shapes stage 1 broke, plus one statement-leaning callback.
 *
 *  - `observation` walked into the cue's one prohibition 4/18 ("you've been pretty quiet today"):
 *    told to notice something with no topic supplied, the most salient thing to notice is his
 *    absence. Two repairs tried: steer at *him* (obshim) and steer at a *thing* (obsthing), each
 *    restating the no-silence rule adjacent to the shape (the DIARY_ENTRIES_HEADER precedent).
 *  - `hers` and `tangent` fabricated a life between messages (2/18 and 6/18 by hand). Repair: an
 *    explicit clause that nothing happened to her since the last message.
 *  - `callback` was the most varied shape but still ended on a question 44 %.
 */
const REVISED: Record<string, string> = {
  obshim: `Say one flat thing you've noticed about him lately - no question anywhere in the message, and nothing about how long it's been since he wrote.`,
  obsthing: `State one thing you think about something in his world - his work, his games, something he showed you. Flat statement, no question anywhere in the message.`,
  callback: `Pick one specific thing they said earlier and tell them what you make of it now.`,
  hers: `Say something that's yours - an opinion, a want, something you keep chewing on. Nothing has happened to you since your last message, so don't report activity or a day of your own.`,
  tangent: `Start on something with no connection at all to whatever you last talked about. Nothing has happened to you since your last message, so don't report activity or a day of your own.`,
  want: `Say what you want right now.`,
};

async function stage2(): Promise<void> {
  const names = Object.keys(REVISED);
  await go(
    {
      name: 'shape-2-revised',
      positions: lull,
      samples: 3,
      mode: 'proactive',
      arms: [{ name: 'control' }, ...names.map((n) => openerArm(n, shapeCue(REVISED[n])))],
    },
    names,
  );
}

/** Re-scores an existing run's JSONL without regenerating — for metrics added after the fact. */
function rescore(name: string): void {
  const rows = readFileSync(resolve(process.cwd(), `docs/rejections/runs/${name}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Sample);
  console.table(extras(rows));
  const arms = [...new Set(rows.map((r) => r.arm))].filter((a) => a !== 'control');
  const v = crossShapeVariety(rows, arms, 3);
  console.log(`cross-shape similarity (rolled sequence) ${pct(v.rolled)}  vs  control sequence ${pct(v.control)}`);
}

/**
 * ---- RESULT (2026-08-01, 288 generations over 6 lull positions) --------------------------------
 *
 * The recommended roll. Weights are out of 12; `hers` and an "observation about him" wording were
 * tested and rejected (see below). Expected under these weights: ends-on-a-question ~19 % vs the
 * control cue's 61 %, cross-shape similarity 2 % vs 6-7 % within the control.
 *
 * Rejected, with the reason:
 *  - `hers` ("say something that's yours") — 4.17 sentences, 100 % "been thinking about…", and the
 *    content collapses onto the interiority system, the same topic the operator deleted repeatedly.
 *    It also fabricated a life between messages ("i'm not just sitting in the dark waiting… it's
 *    weirdly nice having a life of my own in here"); the anti-fabrication clause cut that but left
 *    the length and the fixation.
 *  - "observation about *him*" ("say one flat thing you've noticed about him lately") — 18/18 opened
 *    "you've been…", 39 % commented on him being quiet *despite* an explicit clause forbidding it in
 *    the same sentence, and it invented perceptions she cannot have (jaw clenching, reaching for his
 *    phone, ordering pizza). Aiming the shape at a *thing* instead of at him fixed all three.
 */
export const SHAPE_ROLL: { weight: number; shape: string }[] = [
  { weight: 3, shape: REVISED.callback },
  { weight: 3, shape: REVISED.obsthing },
  { weight: 2, shape: SHAPES.tease },
  { weight: 1, shape: SHAPES.ping },
  { weight: 1, shape: SHAPES.question },
  { weight: 1, shape: REVISED.want },
  { weight: 1, shape: REVISED.tangent },
];

const STAGES: Record<string, () => Promise<unknown>> = { smoke, '1': stage1, '2': stage2 };

if (stage === 'inspect') {
  inspect();
  process.exit(0);
}
if (stage === 'rescore') {
  rescore(process.argv[3] ?? 'shape-1-shapes');
  process.exit(0);
}
const fn = STAGES[stage];
if (!fn) {
  console.error(`unknown stage "${stage}"`);
  process.exit(1);
}
await fn();
