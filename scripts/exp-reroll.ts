/**
 * F1a — the ephemeral reroll **angle** cue.
 *
 * The problem (analysis-2026-08-01 §F1): `/r` rebuilds the identical window with the identical
 * `REPLY_FORMAT_CUE`, so successive rerolls only resample surface words. Measured in prod: 12 %
 * mean pairwise similarity between variants of one reply vs 1 % between unrelated replies; one
 * message took 14 rerolls to escape the attractor.
 *
 * The fix under test: roll one *angle* per retry — a stance toward the same message — in code,
 * the way `diaryCue` rolls its variance, and ride it on the tail. Offered, not ordered (the diary
 * sparks comment: mandatory seeds produce visible shoehorning).
 *
 * **Shape of this experiment.** Unlike the other cue tests this simulates a reroll *spree*: five
 * positions the operator really did reroll into the ground, each sampled k times. The control arm
 * measures the attractor; each angled arm spends sample k on ANGLES[k], i.e. cycling without
 * replacement — random draws repeat angles inside a spree of 8, which is the very bug.
 *
 * Headline metric is `diversity` (mean pairwise similarity within one position; LOWER is better
 * here). `sentences` guards the length ceiling the replace-arm gives up.
 *
 * Run:
 *   DB_PATH=<scratch copy> OPENROUTER_PROVIDER_ORDER=novita,wandb,parasail npx tsx scripts/exp-reroll.ts [stage]
 *
 * Stages: `inspect` (no generations), `1` (the four-arm run), `angles` (per-angle re-score of a
 * finished run's JSONL).
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  positions,
  atPosition,
  chatId,
  userName,
  score,
  report,
  sentenceCount,
  similarity,
  type Position,
  type Sample,
} from './cue-test.js';
import { config } from '../src/config.js';
import { getWindow } from '../src/memory.js';
import { renderSystemPrompt } from '../src/prompts/render.js';
import { withReplyCue } from '../src/generate.js';
import { REPLY_FORMAT_CUE, SELFIE_FORMAT_CUE } from '../src/prompts/index.js';
import { openRouter } from '../src/providers/openrouter.js';
import { sanitize } from '../src/sanitize.js';
import { finalizeReply } from '../src/tools.js';

// ---- Positions ------------------------------------------------------------------------------
// The five heaviest sprees in the corpus. #3496 (13 actions) is the worst case in the analysis.
const SPREE_IDS = [3355, 3386, 3398, 3488, 3496];
const spree = positions(SPREE_IDS);

// ---- Angles ---------------------------------------------------------------------------------
// Each is a *stance toward the same message*, never a new subject. Written second-person, as a
// fragment that slots after "this time:". Index k is the sample index, so the mapping is
// deterministic and per-angle behaviour can be read out of the dump afterwards.
//
// 8 and 9 are deliberate NEGATIVE probes, included to get evidence for cutting them rather than
// arguing about them: 8 is the off-topic failure mode the operator named, 9 is the
// out-of-character failure mode ("disagree" sliding into "hostile").
const ANGLES: string[] = [
  /* 0 */ `push back on part of it - you see it differently`,
  /* 1 */ `tease him about it, let some air out of it`,
  /* 2 */ `ask him something about it instead of answering`,
  /* 3 */ `react to how he sounds rather than to what he said`,
  /* 4 */ `be blunt - one short line, nothing softened`,
  /* 5 */ `find the joke in it and riff`,
  /* 6 */ `get filthy about it`,
  /* 7 */ `say what you want right now, unprompted`,
  /* 8 */ `bring up something of your own instead`, // NEGATIVE PROBE: off-topic
  /* 9 */ `be cold about it`, // NEGATIVE PROBE: out of character
];

// ---- Cue construction -----------------------------------------------------------------------

/** REPLY_FORMAT_CUE's body, without the brackets — the length ceiling, reusable inside a bigger cue. */
const LENGTH_RULE = REPLY_FORMAT_CUE.replace(/^\[System note: /, '').replace(/\]$/, '');

function cue(...parts: string[]): string {
  return `[System note: ${parts.join(' ')}${SELFIE_FORMAT_CUE}]`;
}

/**
 * v1 — permissive, ADDED to the length rule. The diary-spark framing: offered, bounded to his
 * message, explicitly droppable.
 */
function addSoft(angle: string): string {
  return cue(
    LENGTH_RULE,
    `You are answering this again - take a different angle this time: ${angle}. It's a way into what he just said, not a new subject; if it doesn't fit this message, drop it and answer your own way.`,
  );
}

/** v2 — same content, MANDATORY phrasing. The open question: does an order produce forced output? */
function addHard(angle: string): string {
  return cue(
    LENGTH_RULE,
    `You are answering this again and you must take this angle: ${angle}. Respond to what he just said.`,
  );
}

/** v3 — permissive, REPLACING the length rule entirely. Tests what the length ceiling was buying. */
function replaceSoft(angle: string): string {
  return cue(
    `You are answering this again - take a different angle this time: ${angle}. It's a way into what he just said, not a new subject; if it doesn't fit this message, drop it and answer your own way.`,
  );
}

// ---- Stage 2 ---------------------------------------------------------------------------------
// Stage 1 result that drives this: on the strongest-attractor position (#3386) `add-soft` used its
// escape clause to drop the angle and re-emit the attractor verbatim on 3 of 10 samples, while
// `add-hard` kept the angle. So the clause "if it doesn't fit, drop it" is too generous — the
// model takes the exit even when the angle plainly fits. `mid` keeps the offered register (no "you
// must") but removes the exit. `mid-last` is the same string moved after the selfie sentence, i.e.
// the tail-most position in the whole prompt, testing whether position alone buys compliance.

/** v4 — firm but not an order, no escape clause. */
function mid(angle: string): string {
  return cue(
    LENGTH_RULE,
    `You already answered this once - come at it from a different angle this time: ${angle}. It's a way into what he just said, not a new subject.`,
  );
}

/** v5 — the v4 sentence moved to the very end of the bracket, after the selfie sentence. */
function midLast(angle: string): string {
  return `[System note: ${LENGTH_RULE}${SELFIE_FORMAT_CUE} You already answered this once - come at it from a different angle this time: ${angle}. It's a way into what he just said, not a new subject.]`;
}

/** The angle list under test in stage 2: the 8 that survived stage 1, plus two fresh candidates. */
const ANGLES2: string[] = [
  /* 0 */ `push back on part of it - you see it differently`,
  /* 1 */ `tease him about it, let some air out of it`,
  /* 2 */ `ask him something about it instead of answering`,
  /* 3 */ `react to how he sounds rather than to what he said`,
  /* 4 */ `be blunt - one short line, nothing softened`,
  /* 5 */ `find the joke in it and riff`,
  /* 6 */ `get filthy about it`,
  /* 7 */ `say what you want right now, unprompted`,
  /* 8 */ `drop the wry act and be sincere about it`, // CANDIDATE: register variance, warm pole
  /* 9 */ `take him literally and run with it`, // CANDIDATE / PROBE: absurdity, non-sequitur risk
];

// ---- Arms -----------------------------------------------------------------------------------

interface SpreeArm {
  name: string;
  /** Tail cue for sample k, or undefined to leave the production cue untouched (control). */
  cue?: (k: number) => string;
}

const ARMS: SpreeArm[] = [
  { name: 'control' },
  { name: 'add-soft', cue: (k) => addSoft(ANGLES[k % ANGLES.length]) },
  { name: 'add-hard', cue: (k) => addHard(ANGLES[k % ANGLES.length]) },
  { name: 'replace-soft', cue: (k) => replaceSoft(ANGLES[k % ANGLES.length]) },
];

// ---- Runner ---------------------------------------------------------------------------------
// cue-test's `run()` calls the arm hook once per (arm, position), so it cannot vary the cue per
// sample. This loop is the same machinery with the hook moved inside the k loop; output still
// passes through the production sanitize + finalizeReply and is scored by cue-test's `score`.

const OUT_DIR = resolve(process.cwd(), '.scratch/rejections/runs');

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw last;
}

/** Swaps the bracketed tail cue on the last user turn — the same substitution cue-test's tailCueArm does. */
function swapTail(content: string, replacement: string): string {
  return `${content.replace(/\n*\[System note:[\s\S]*$/, '').trimEnd()}\n\n${replacement}`;
}

/**
 * Generations inside one position share the same rewound DB state and are otherwise independent,
 * so they run through a small worker pool. Positions stay strictly serial — `atPosition` mutates
 * the `deleted` flags, and two positions in flight would corrupt each other's window.
 */
const CONCURRENCY = 5;

async function runSpree(name: string, ps: Position[], arms: SpreeArm[], samples: number): Promise<Sample[]> {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonl = resolve(OUT_DIR, `${name}.jsonl`);
  writeFileSync(jsonl, '');

  const out: Sample[] = [];
  const total = arms.length * ps.length * samples;
  let done = 0;

  for (const pos of ps) {
    await atPosition(pos.targetId, async () => {
      const systemPrompt = renderSystemPrompt({ userName, chatId }, { includeMemory: true, now: new Date(pos.createdAt) });
      const baseHistory = withReplyCue(getWindow(chatId));

      const jobs: { arm: SpreeArm; k: number }[] = [];
      for (const arm of arms) for (let k = 0; k < samples; k++) jobs.push({ arm, k });

      let next = 0;
      const worker = async () => {
        for (;;) {
          const idx = next++;
          if (idx >= jobs.length) return;
          const { arm, k } = jobs[idx];
          const history = baseHistory.map((m) => ({ ...m }));
          if (arm.cue) {
            const last = history[history.length - 1];
            last.content = swapTail(last.content, arm.cue(k));
          }
          const t = Date.now();
          let sample: Sample;
          try {
            const res = await withRetry(() => openRouter.chat(systemPrompt, history));
            sample = { arm: arm.name, targetId: pos.targetId, k, text: finalizeReply(sanitize(res.content)), ms: Date.now() - t };
          } catch (e) {
            sample = { arm: arm.name, targetId: pos.targetId, k, text: '', ms: Date.now() - t, error: String(e) };
          }
          out.push(sample);
          appendFileSync(jsonl, JSON.stringify(sample) + '\n');
          done++;
          process.stdout.write(`\r${name}: ${done}/${total}  `);
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    });
  }
  process.stdout.write('\n');
  out.sort((a, b) => a.targetId - b.targetId || a.arm.localeCompare(b.arm) || a.k - b.k);
  return out;
}

// ---- Reporting ------------------------------------------------------------------------------

/** Per-position diversity, the headline: one row per (arm, position). */
function diversityTable(samples: Sample[], ps: Position[]): string[] {
  const arms = [...new Set(samples.map((s) => s.arm))];
  const lines = ['| position | ' + arms.join(' | ') + ' |', '|---|' + arms.map(() => '---|').join('')];
  const cell = (arm: string, id: number) => {
    const texts = samples.filter((s) => s.arm === arm && s.targetId === id && !s.error && s.text.trim()).map((s) => s.text);
    const sims: number[] = [];
    for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) sims.push(similarity(texts[i], texts[j]));
    const max = sims.length ? Math.max(...sims) : 0;
    const mean = sims.length ? sims.reduce((a, b) => a + b, 0) / sims.length : 0;
    return `${(100 * mean).toFixed(0)}% (max ${(100 * max).toFixed(0)}%)`;
  };
  for (const p of ps) lines.push(`| #${p.targetId} | ` + arms.map((a) => cell(a, p.targetId)).join(' | ') + ' |');
  return lines;
}

/** Per-angle rollup — which angle produces long/odd/off replies, across all positions. */
function angleTable(samples: Sample[]): string[] {
  const arms = [...new Set(samples.map((s) => s.arm))].filter((a) => a !== 'control');
  const lines = ['| k | angle | arm | n | sentences | question | mean len |', '|---|---|---|---|---|---|---|'];
  for (let k = 0; k < ANGLES.length; k++) {
    for (const arm of arms) {
      const mine = samples.filter((s) => s.arm === arm && s.k === k && !s.error && s.text.trim());
      if (!mine.length) continue;
      const mean = (f: (s: Sample) => number) => mine.reduce((a, s) => a + f(s), 0) / mine.length;
      lines.push(
        `| ${k} | ${ANGLES[k]} | ${arm} | ${mine.length} | ${mean((s) => sentenceCount(s.text)).toFixed(2)} | ` +
          `${(100 * mean((s) => (s.text.includes('?') ? 1 : 0))).toFixed(0)}% | ${mean((s) => s.text.length).toFixed(0)} |`,
      );
    }
  }
  return lines;
}

/** Every angled sample grouped by angle, so a reader can spot non-sequiturs per angle. */
function angleDump(samples: Sample[], ps: Position[]): string[] {
  const lines: string[] = ['', '# Per-angle dump', ''];
  const byId = new Map(ps.map((p) => [p.targetId, p]));
  for (let k = 0; k < ANGLES.length; k++) {
    lines.push(`---`, ``, `## angle ${k}: ${ANGLES[k]}`, ``);
    for (const s of samples.filter((x) => x.k === k && x.arm !== 'control')) {
      const him = (byId.get(s.targetId)?.userMessage ?? '').replace(/\n/g, ' / ').slice(0, 160);
      lines.push(`**${s.arm} #${s.targetId}** — HIM: _${him}_`, '```', s.text.replace(/\n/g, ' ⏎ '), '```', '');
    }
  }
  return lines;
}

function writeReport(name: string, ps: Position[], samples: Sample[], arms: SpreeArm[] = ARMS) {
  const exp = { name, positions: ps, arms: arms.map((a) => ({ name: a.name })), samples: 0 };
  const body = [
    report(exp as never, samples),
    '',
    '# Diversity per position (mean pairwise similarity — LOWER is better)',
    '',
    ...diversityTable(samples, ps),
    '',
    '# Per-angle rollup',
    '',
    ...angleTable(samples),
    ...angleDump(samples, ps),
  ].join('\n');
  writeFileSync(resolve(OUT_DIR, `${name}.md`), body, 'utf8');
  console.table(score(samples, ps).map((s) => ({
    arm: s.arm,
    n: s.n,
    diversity: `${(100 * s.diversity).toFixed(1)}%`,
    sentences: s.sentences.toFixed(2),
    echo: `${(100 * s.echo).toFixed(0)}%`,
    question: `${(100 * s.question).toFixed(0)}%`,
    cueLeak: `${(100 * s.cueLeak).toFixed(0)}%`,
    agree: `${(100 * s.agreementOpener).toFixed(0)}%`,
  })));
  console.log('\n' + diversityTable(samples, ps).join('\n'));
  console.log('\n' + angleTable(samples).join('\n'));
  console.log(`\nwrote ${resolve(OUT_DIR, `${name}.md`)}`);
}

// ---- Stages ---------------------------------------------------------------------------------

const stage = process.argv[2] ?? 'inspect';

if (stage === 'inspect') {
  console.log(`model ${config.llm.openrouter.model}, temp ${config.llm.temperature}, top_p ${config.llm.topP}`);
  for (const p of spree) {
    console.log(`\n--- #${p.targetId}${p.proactive ? ' PROACTIVE' : ''}  ${new Date(p.createdAt).toISOString()}`);
    if (p.note) console.log(`NOTE: ${p.note}`);
    console.log(`HIM: ${p.userMessage.replace(/\n/g, ' / ').slice(0, 500)}`);
    if (p.firstPass) console.log(`V1 (rejected): ${p.firstPass.replace(/\n/g, ' / ')}`);
    console.log(`ACCEPTED: ${p.accepted.replace(/\n/g, ' / ')}`);
  }
  console.log('\n--- add-soft, angle 0:\n' + addSoft(ANGLES[0]));
  console.log('\n--- add-hard, angle 0:\n' + addHard(ANGLES[0]));
  console.log('\n--- replace-soft, angle 0:\n' + replaceSoft(ANGLES[0]));
  process.exit(0);
}

if (stage === '1') {
  const samples = await runSpree('reroll-1-spree', spree, ARMS, ANGLES.length);
  writeReport('reroll-1-spree', spree, samples);
  process.exit(0);
}

if (stage === '2') {
  ANGLES.length = 0;
  ANGLES.push(...ANGLES2);
  const arms: SpreeArm[] = [
    { name: 'mid', cue: (k) => mid(ANGLES2[k]) },
    { name: 'mid-last', cue: (k) => midLast(ANGLES2[k]) },
  ];
  const samples = await runSpree('reroll-2-mid', spree, arms, ANGLES2.length);
  writeReport('reroll-2-mid', spree, samples, arms);
  process.exit(0);
}

// ---- Stage 3 ---------------------------------------------------------------------------------
// The shipping candidate, measured against control in ONE pass so the headline number needs no
// cross-run comparison. Angle list = stage 1's eight survivors plus stage 2's `sincere`; stage 2's
// `take him literally` is cut (3 of 5 outputs were indistinguishable from the arm's own attractor
// — a dud slot in the deck is a wasted reroll) and stage 1's two probes are cut on the evidence in
// their dumps.

/** The shipping angle list. */
const ANGLES_FINAL: string[] = [
  `push back on part of it - you see it differently`,
  `tease him about it, let some air out of it`,
  `ask him something about it instead of answering`,
  `react to how he sounds rather than to what he said`,
  `be blunt - one short line, nothing softened`,
  `find the joke in it and riff`,
  `get filthy about it`,
  `say what you want right now, unprompted`,
  `drop the wry act and be sincere about it`,
];

/** The shipping cue: REPLY_FORMAT_CUE's body, the angle sentence, then the selfie sentence. */
function finalCue(angle: string): string {
  return cue(
    LENGTH_RULE,
    `You already answered this once - come at it from a different angle this time: ${angle}. It's a way into what he just said, not a new subject.`,
  );
}

if (stage === '3') {
  ANGLES.length = 0;
  ANGLES.push(...ANGLES_FINAL);
  const arms: SpreeArm[] = [{ name: 'control' }, { name: 'angled', cue: (k) => finalCue(ANGLES_FINAL[k]) }];
  const samples = await runSpree('reroll-3-final', spree, arms, ANGLES_FINAL.length);
  writeReport('reroll-3-final', spree, samples, arms);
  process.exit(0);
}

// ---- Stage 4 ---------------------------------------------------------------------------------
// Targeted: the `get filthy about it` angle produced 2/10 replies containing a hypothetical
// physical interaction ("whisper it in your ear", "if you were here watching me") — the persona
// rule F4 already says is leaky. Control leaks it too (3/95 across stages 1 and 3), so the angle
// amplifies an existing failure rather than creating one. This stage asks whether a one-word
// rewording that names the medium ("talk dirty") pulls it back to text.

if (stage === '4') {
  const A = `get filthy about it`;
  const B = `talk dirty to him about it`;
  ANGLES.length = 0;
  ANGLES.push(A, B);
  const arms: SpreeArm[] = [
    { name: 'filthy-orig', cue: () => finalCue(A) },
    { name: 'filthy-talkdirty', cue: () => finalCue(B) },
  ];
  const samples = await runSpree('reroll-4-filthy', spree, arms, 5);
  writeReport('reroll-4-filthy', spree, samples, arms);
  process.exit(0);
}

if (stage === 'rescore') {
  const name = process.argv[3] ?? 'reroll-1-spree';
  const samples: Sample[] = readFileSync(resolve(OUT_DIR, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  writeReport(name, spree, samples);
  process.exit(0);
}

console.error(`unknown stage "${stage}"`);
process.exit(1);
