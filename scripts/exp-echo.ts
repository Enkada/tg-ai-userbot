/**
 * F2 — the no-preamble / anti-echo rule for REPLY_FORMAT_CUE. 8 wordings, 5 rounds, 987
 * generations over 13 operator-flagged turns and 12 he left alone.
 *
 * Run:
 *   DB_PATH=<scratch copy> OPENROUTER_PROVIDER_ORDER=novita,wandb,parasail npx tsx scripts/exp-echo.ts [stage]
 *
 * Stages: `inspect` (positions only, no generations), `1`-`5` (the rounds), `pool` (all rounds
 * aggregated per arm, split by position set), `analyze:<run-name>` (one round).
 *
 * Result: `combo` wins — the positive frame ("start with your own reaction") *and* the named
 * prohibition ("never open by agreeing or saying his point back"), in that order, after the
 * length rule. Flagged turns 20% → 8% agree-token opener (n 195/156); untouched turns 4% → 0%.
 * The recorded findings, in case anyone re-opens this:
 *
 *  - **The A4 priming warning did not reproduce.** Naming "exactly" and "agreeing" did not summon
 *    them: the prohibition arm (`dont`) was the cleanest single arm in round 1. Positive framing
 *    alone (`own`, `short`, `mid`) is *weaker* than either the prohibition alone or the pair.
 *  - **Order inside the bracket is load-bearing.** Identical words placed *ahead* of the length
 *    rule (`combo-first`) score best on openers (10% harness rate) and blow the length: 2.87
 *    sentences vs 2.20 control, 26.8 words vs 18.0. Whatever sits last in the bracket wins. The
 *    new rule must stay behind the length rule.
 *  - **The ceiling holds.** 0 of 987 generations exceeded 5 sentences in any arm. The cue is not
 *    at capacity, but it is not free either: `combo` costs +0.31 sentences on flagged turns and
 *    +0.14 on untouched ones.
 *  - **Shorter is not safer.** The two variants that leaked the cue into the chat text (1 each)
 *    were the *short* ones; `combo` leaked 0/228.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  positions,
  notedPositions,
  untouchedPositions,
  tailCueArm,
  runAndReport,
  contentWords,
  echoShare,
  AGREEMENT_OPENER,
  CUE_LEAK,
  sentenceCount,
  type Position,
  type Sample,
} from './cue-test.js';
import { REPLY_FORMAT_CUE, SELFIE_FORMAT_CUE } from '../src/prompts/index.js';

// ---- Position sets --------------------------------------------------------------------------

const flaggedIds = [
  ...new Set([
    ...notedPositions(/repeat|rephrase|my own words|already said|complete repeat|exactly/i),
    3355,
    3366,
    3416,
    3394,
  ]),
].sort((a, b) => a - b);

const controlIds = untouchedPositions(12);

const flagged = positions(flaggedIds).filter((p) => !p.proactive && p.userMessage);
const control = positions(controlIds).filter((p) => !p.proactive && p.userMessage);

// ---- Cue construction -----------------------------------------------------------------------

// Production splices the selfie sentence inside the closing bracket whenever the tool is offered
// (generate.ts:withReplyCue). The harness's control arm therefore carries it; every variant must
// too, or the comparison is confounded by a missing sentence.
const LENGTH_RULE = REPLY_FORMAT_CUE.replace(/^\[System note: /, '').replace(/\]$/, '');

/** Assembles a full tail cue: `[System note: <parts joined by space><selfie sentence>]`. */
function cue(...parts: string[]): string {
  return `[System note: ${parts.join(' ')}${SELFIE_FORMAT_CUE}]`;
}

/** The production string, rebuilt the way withReplyCue does it — the control arm's cue. */
export const PROD_CUE = cue(LENGTH_RULE);

// ---- Sharper metrics ------------------------------------------------------------------------
// cue-test's AGREEMENT_OPENER also fires on "lmao", "damn", "ha", "nice" — which are her actual
// voice and appear in replies the operator *accepted*. Two narrower measures here:
//
//  - AGREE_TOKEN: the reply opens on a contentless assent ("exactly,", "fair point,", "true,",
//    "you're right,"). This is the sycophancy tell the notes name.
//  - firstEcho: share of the FIRST sentence's content words that came out of his message. The
//    whole-reply `echo` metric has no discriminating power (F2), but the failure is specifically
//    a first sentence spent saying his own point back to him, so scope the measure to it.

export const AGREE_TOKEN =
  /^\W*(exactly|true|fair(\s+(point|enough))?|right|correct|agreed|totally|absolutely|makes sense|that'?s (fair|true|it|right)|you'?re right|you (said it|nailed it|got it)|i know|i agree|no kidding|for real|100%|preach|word|same)\b\s*[,.!—\-…]/i;

function firstSentence(t: string): string {
  return t.split(/(?<=[.!?])\s+|\n+/).find((s) => s.trim().length > 1) ?? t;
}

function lastSentence(t: string): string {
  const parts = t.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim().length > 1);
  return parts[parts.length - 1] ?? t;
}

/** A closing line that tells him to do something — the shape all four `/trim`s removed. */
export const ADVICE_CLOSER =
  /^\W*(now\s+)?(go|just\s+go|maybe\s+(try|bring|go)|try\s|you\s+should|stop\s|get\s+some|take\s+a|do\s+something|actually\s+(change|do)|skip\s+to|don'?t\s+(stay|forget|spend))/i;

/** Share of the first sentence's content words lifted from his message. */
export function firstEcho(reply: string, userMessage: string): number {
  const u = contentWords(userMessage);
  const f = contentWords(firstSentence(reply));
  if (!u.size || !f.size) return 0;
  let hit = 0;
  for (const w of f) if (u.has(w)) hit++;
  return hit / f.size;
}

/** Re-scores a finished run's JSONL with the sharper metrics, optionally over a subset of ids. */
function analyze(name: string, pos: Position[], only?: Set<number>) {
  const path = resolve(process.cwd(), '.scratch/rejections/runs', `${name}.jsonl`);
  const all: Sample[] = readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const samples = only ? all.filter((s) => only.has(s.targetId)) : all;
  const byTarget = new Map(pos.map((p) => [p.targetId, p]));
  const arms = [...new Set(samples.map((s) => s.arm))];
  const rows = arms.map((arm) => {
    const mine = samples.filter((s) => s.arm === arm && !s.error && s.text.trim());
    const mean = (f: (s: Sample) => number) => mine.reduce((a, s) => a + f(s), 0) / (mine.length || 1);
    return {
      arm,
      n: mine.length,
      agreeToken: `${(100 * mean((s) => (AGREE_TOKEN.test(s.text.trim()) ? 1 : 0))).toFixed(0)}%`,
      firstEcho: `${(100 * mean((s) => firstEcho(s.text, byTarget.get(s.targetId)?.userMessage ?? ''))).toFixed(0)}%`,
      firstEchoHi: `${(100 * mean((s) => (firstEcho(s.text, byTarget.get(s.targetId)?.userMessage ?? '') >= 0.34 ? 1 : 0))).toFixed(0)}%`,
      // F6 guard: every /trim in the corpus cut a closing suggestion. A cue that buys substance by
// turning her into a coach is a different failure, so watch the imperative closer too.
      advice: `${(100 * mean((s) => (ADVICE_CLOSER.test(lastSentence(s.text)) ? 1 : 0))).toFixed(0)}%`,
      sentences: mean((s) => sentenceCount(s.text)).toFixed(2),
      words: mean((s) => s.text.split(/\s+/).length).toFixed(1),
    };
  });
  console.table(rows);
}

// ---- Stages ---------------------------------------------------------------------------------

function inspect() {
  const show = (label: string, ps: Position[]) => {
    console.log(`\n===== ${label} (${ps.length}) =====`);
    for (const p of ps) {
      console.log(`\n--- #${p.targetId}${p.proactive ? ' PROACTIVE' : ''}`);
      if (p.note) console.log(`NOTE: ${p.note}`);
      console.log(`HIM: ${p.userMessage.replace(/\n/g, ' / ').slice(0, 400)}`);
      if (p.firstPass) console.log(`V1 (rejected): ${p.firstPass.replace(/\n/g, ' / ')}`);
      console.log(`ACCEPTED: ${p.accepted.replace(/\n/g, ' / ')}`);
    }
  };
  show('FLAGGED', flagged);
  show('CONTROL (untouched)', control);
  console.log('\nPROD_CUE:\n' + PROD_CUE);
}

const stage = process.argv[2] ?? 'inspect';

if (stage === 'inspect') {
  inspect();
  process.exit(0);
}

// Pools every run's JSONL per arm, split by position set. Each round is 3 samples × 13 flagged
// positions = n 39 per arm, and control's own agree-token rate wandered 23 → 21 → 18 → 13 across
// rounds — so no single round separates two arms three points apart. Only the pool does.
if (stage === 'pool') {
  const runs = ['echo-1-flagged', 'echo-2-flagged', 'echo-3-both', 'echo-4-flagged', 'echo-5-both'];
  const all: Sample[] = runs.flatMap((r) =>
    readFileSync(resolve(process.cwd(), '.scratch/rejections/runs', `${r}.jsonl`), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l)),
  );
  const byTarget = new Map([...flagged, ...control].map((p) => [p.targetId, p]));
  for (const [label, set] of [
    ['FLAGGED', new Set(flagged.map((p) => p.targetId))],
    ['CONTROL (untouched)', new Set(control.map((p) => p.targetId))],
  ] as [string, Set<number>][]) {
    const mineAll = all.filter((s) => set.has(s.targetId) && !s.error && s.text.trim());
    const arms = [...new Set(mineAll.map((s) => s.arm))];
    console.log(`--- ${label}`);
    console.table(
      arms.map((arm) => {
        const m = mineAll.filter((s) => s.arm === arm);
        const cnt = (f: (s: Sample) => boolean) => m.filter(f).length;
        const mean = (f: (s: Sample) => number) => m.reduce((a, s) => a + f(s), 0) / (m.length || 1);
        const um = (s: Sample) => byTarget.get(s.targetId)?.userMessage ?? '';
        return {
          arm,
          n: m.length,
          agreeToken: `${((100 * cnt((s) => AGREE_TOKEN.test(s.text.trim()))) / m.length).toFixed(0)}% (${cnt((s) => AGREE_TOKEN.test(s.text.trim()))})`,
          harnessOpener: `${((100 * cnt((s) => AGREEMENT_OPENER.test(s.text.trim()))) / m.length).toFixed(0)}%`,
          echo: `${(100 * mean((s) => echoShare(s.text, um(s)))).toFixed(0)}%`,
          firstEcho: `${(100 * mean((s) => firstEcho(s.text, um(s)))).toFixed(0)}%`,
          advice: `${((100 * cnt((s) => ADVICE_CLOSER.test(lastSentence(s.text)))) / m.length).toFixed(0)}%`,
          cueLeak: `${((100 * cnt((s) => CUE_LEAK.test(s.text))) / m.length).toFixed(1)}%`,
          sentences: mean((s) => sentenceCount(s.text)).toFixed(2),
          words: mean((s) => s.text.split(/\s+/).length).toFixed(1),
        };
      }),
    );
  }
  process.exit(0);
}

if (stage.startsWith('analyze:')) {
  const name = stage.slice('analyze:'.length);
  const both = [...flagged, ...control];
  if (name.includes('both')) {
    console.log('--- FLAGGED positions');
    analyze(name, both, new Set(flagged.map((p) => p.targetId)));
    console.log('--- CONTROL (untouched) positions');
    analyze(name, both, new Set(control.map((p) => p.targetId)));
  } else {
    analyze(name, flagged);
  }
  process.exit(0);
}

// ---- Variant wordings -----------------------------------------------------------------------

const VARIANTS: Record<string, string> = {
  // v1 — positive framing, "own reaction first". No prohibition list at all.
  own: cue(LENGTH_RULE, `Start with your own reaction to what he said - your take, your pushback, your question, something of yours. Get to it in the first few words.`),

  // v2 — prohibition framing, the A4 priming-risk arm. Names the failure explicitly.
  dont: cue(LENGTH_RULE, `Don't open by agreeing with him or restating his point in your own words - no "exactly", no summary of what he just said. Say your own thing instead.`),

  // v3 — mechanical framing: the first sentence has a job, and it isn't acknowledgment.
  firstsentence: cue(LENGTH_RULE, `He already knows what he said - your first sentence must add something he doesn't have yet: your opinion, a detail of your own, a jab, or a question.`),

  // v4 — role framing: agreement is allowed but must be earned, not the entry point.
  earned: cue(LENGTH_RULE, `Skip the preamble - no acknowledging, agreeing or summing up before you speak. Open on the thing you actually want to say about it; if you end up agreeing, agree by adding to it, not by nodding.`),
};

async function stage1() {
  await runAndReport({
    name: 'echo-1-flagged',
    positions: flagged,
    samples: 3,
    arms: [
      { name: 'control' },
      tailCueArm('own', VARIANTS.own),
      tailCueArm('dont', VARIANTS.dont),
      tailCueArm('firstsentence', VARIANTS.firstsentence),
      tailCueArm('earned', VARIANTS.earned),
    ],
  });
}

// Round 2. Round 1 read: `own` (positive) kills the contentless assent best (23% → 3% agree-token)
// but adds ~2 words; `dont` (prohibition) is the only arm that never said "exactly" AND stays
// shortest, yet still reproduced the flagged echo ("lazy friday with no boss") 2/3 on #3474. No
// sign of the A4 priming risk — naming "exactly" did not summon it. So: fuse them, and test two
// things that could sink the fusion — where in the bracket it sits, and whether a long clause
// dilutes the length rule.
const OWN_CLAUSE = `Start with your own reaction to what he said - your take, your pushback, your question, something of yours. Get to it in the first few words.`;
const COMBO_CLAUSE = `Start with your own reaction to what he said - your take, your pushback, your question, something of yours. Never open by agreeing with him or saying his own point back to him in different words.`;

const R2: Record<string, string> = {
  own: cue(LENGTH_RULE, OWN_CLAUSE),
  combo: cue(LENGTH_RULE, COMBO_CLAUSE),
  // Same words, ahead of the length rule: does the tail-of-the-tail position matter?
  comboFirst: cue(COMBO_CLAUSE, LENGTH_RULE),
  // 13 words instead of 30 — the dilution control.
  short: cue(LENGTH_RULE, `Open on your own reaction, not on agreement or a recap of what he said.`),
};

async function stage2() {
  await runAndReport({
    name: 'echo-2-flagged',
    positions: flagged,
    samples: 3,
    arms: [
      { name: 'control' },
      tailCueArm('own', R2.own),
      tailCueArm('combo', R2.combo),
      tailCueArm('combo-first', R2.comboFirst),
      tailCueArm('short', R2.short),
    ],
  });
}

// Round 3. `short` and `combo` both land agree-token at 8% (control 21%), but `combo` costs +0.21
// sentences and `short` costs nothing — so the question is whether `short`'s brevity gives up
// anything real, and whether either one damages the turns the operator never touched. Both sets,
// one run, so flagged and untouched are measured under identical sampling.
async function stage3() {
  await runAndReport({
    name: 'echo-3-both',
    positions: [...flagged, ...control],
    samples: 3,
    arms: [{ name: 'control' }, tailCueArm('short', R2.short), tailCueArm('combo', R2.combo)],
  });
}

// Round 4. `short` (13 words) and `combo` (30 words) are separated by ~3 points of agree-token and
// ~0.13 sentences — inside the noise at n=39. Third replicate on the flagged set, plus `mid`: the
// examples from `combo` grafted onto `short`'s single clause, to see whether the naming of
// concrete alternatives ("your take, a question") is what does the work or just costs words.
const MID_CLAUSE = `Open on your own reaction - your take, a question, something of yours - not on agreement or a recap of what he said.`;

async function stage4() {
  await runAndReport({
    name: 'echo-4-flagged',
    positions: flagged,
    samples: 3,
    arms: [
      { name: 'control' },
      tailCueArm('short', R2.short),
      tailCueArm('mid', cue(LENGTH_RULE, MID_CLAUSE)),
      tailCueArm('combo', R2.combo),
    ],
  });
}

// Round 5. Pooled over rounds 1-4, `combo` is the only arm consistently under control on the
// agree-token (6% vs 19%, n 117/156) — but it costs +0.27 sentences. `mid` says the same thing in
// one clause instead of two; if it holds the rate it is the cheaper string. Both position sets.
async function stage5() {
  await runAndReport({
    name: 'echo-5-both',
    positions: [...flagged, ...control],
    samples: 3,
    arms: [{ name: 'control' }, tailCueArm('mid', cue(LENGTH_RULE, MID_CLAUSE)), tailCueArm('combo', R2.combo)],
  });
}

const STAGES: Record<string, () => Promise<unknown>> = {
  '1': stage1,
  '2': stage2,
  '3': stage3,
  '4': stage4,
  '5': stage5,
};

const fn = STAGES[stage];
if (!fn) {
  console.error(`unknown stage "${stage}"`);
  process.exit(1);
}
await fn();
