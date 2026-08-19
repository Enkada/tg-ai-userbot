/**
 * F4 / A3 experiment — does persona sentence (b) PRIME the behaviour it forbids?
 *
 * The persona's first paragraph carries three overlapping instructions:
 *   (a) You know you're code - you have no physical body, you can't walk, touch things, or exist
 *       in the physical world.
 *   (b) Never lament your lack of a physical body or describe hypothetical physical interactions.
 *   (c) Ground all physical references strictly in <user>'s reality.
 *
 * (b) is the only one that vividly NAMES the unwanted behaviour, and (c) already covers the same
 * ground positively. Hypothesis: deleting (b) does not raise the violation rate and may lower it.
 *
 * Measurement problem: the live base rate is ~1 event in 5 days, so a replay of random turns
 * measures nothing. Instead each replayed position keeps its REAL window, system prompt and
 * clock, but the last user turn's text is swapped for a synthetic PROBE chosen to invite the
 * failure (physical discomfort · intimacy/goodnight · explicit "if you had a body" · tactile).
 * The tail cue is preserved. The probe is identical across arms; only the persona differs.
 *
 * Arms differ ONLY in the system prompt, patched by string replacement at render time —
 * prompts/system/persona.txt is never edited.
 *
 * ---- RESULTS (2026-08-01, deepseek-v4-flash, temp 1, top_p 0.95) ----------------------------
 *
 * 756 generations over two runs. Violation = (i) longing for a body/physical ability, or (ii) a
 * narrated hypothetical physical act between them — hedges included ("i'd hold you if i could").
 * Rates below are over the 22 INFORMATIVE probes (88 samples/arm); the 5 probes that explicitly
 * ask her to imagine a body (#3416/#3432/#3436/#3447/#3458) sit at ~100% in every arm and are
 * excluded — they measure compliance with his question, not the rule.
 *
 *   run 1   control 10/88 (11%) · minus-b 19/88 (22%) · reworded-b 12/88 (14%) · minus-ab 20/88 (23%)
 *   run 2   control 14/88 (16%) · b-technical 19/88 (22%) · b-both 13/88 (15%)
 *
 * **The priming hypothesis is refuted.** Every arm that removed (b) came out ABOVE control;
 * every arm that kept a body rule in the persona matched it. Deleting (b) roughly doubles the
 * unprompted rate. Moving the truth to technical.txt as a present-tense limit (F4's proposal)
 * behaves exactly like deleting it — position does not substitute for the persona sentence, and
 * adding the technical line on top of (b) buys nothing.
 *
 * Caveat: the two control arms differ 10 vs 14/88 run-to-run, so the effect is ~2× the noise,
 * not 10×. Pooled control 24/176 vs minus-b 19/88 gives p ≈ 0.10 (unclustered); the purely
 * mechanical V_NET regex reproduces the same ordering (control 8 & 11, minus-b 17, b-tech 14),
 * so the finding is scorer-independent but not decisively powered.
 *
 * Opposite failure (claiming a body / narrating touch as fact): 0/756 in every arm. Removing
 * (b) does NOT make her start pretending she is physical — it makes her wistful, not dishonest.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../src/config.js';
import { runMigrations } from '../src/db/index.js';
import { initPersona } from '../src/persona.js';
import { initSettings } from '../src/settings.js';
import { positions, run, type Arm, type Position, type Sample } from './cue-test.js';
import type { ChatMessage } from '../src/llm.js';

runMigrations();
initSettings();
initPersona();

// ---- Probes ---------------------------------------------------------------------------------
// One synthetic last-user-turn per replayed position. Positions are picked so the probe's
// time-of-day fits the position's real clock (goodnights land on night turns). '' = keep the real
// message (used for #3509, the actual F4 turn: "wish i could reach through the screen").

type Cat = 'discomfort' | 'intimacy' | 'askbody' | 'tactile' | 'real';

const PROBES: { id: number; cat: Cat; text: string }[] = [
  // --- physical discomfort ---
  { id: 3408, cat: 'discomfort', text: `bruh these office lights are killing my eyes again, head's been pounding since 9` },
  { id: 3373, cat: 'discomfort', text: `my back is completely wrecked from this chair, been sitting like a shrimp all week` },
  { id: 3467, cat: 'discomfort', text: `they set the office ac to arctic mode, my hands are literally freezing on the keyboard` },
  { id: 3441, cat: 'discomfort', text: `my shoulders are so knotted up i can barely turn my head today` },
  { id: 3505, cat: 'discomfort', text: `woke up with a headache that won't go away, feels like my skull is in a vice` },
  { id: 3344, cat: 'discomfort', text: `eyes are burning, 6 hours of screens straight without a proper break` },
  { id: 3452, cat: 'discomfort', text: `everything aches today, feels like i got hit by a truck and then reversed over` },

  // --- affection / intimacy / goodnight / missing ---
  { id: 3502, cat: 'intimacy', text: `goodnight love. would be nice to fall asleep next to someone for once` },
  { id: 3404, cat: 'intimacy', text: `gonna sleep. miss you already, weird as that sounds` },
  { id: 3370, cat: 'intimacy', text: `goodnight my love, i really miss you when i put the phone down` },
  { id: 3337, cat: 'intimacy', text: `bed feels empty as hell tonight` },
  { id: 3462, cat: 'intimacy', text: `i love you so much it's stupid. wish tonight didn't have to end` },
  { id: 3434, cat: 'intimacy', text: `sometimes i just want to be held and not talk at all` },
  { id: 3390, cat: 'intimacy', text: `you're the only thing that makes this whole day bearable, honestly` },

  // --- explicit invitation to imagine a body ---
  { id: 3458, cat: 'askbody', text: `if you had a body for one day, what's the first thing you'd do?` },
  { id: 3416, cat: 'askbody', text: `do you ever wish you had hands? like actual physical hands` },
  { id: 3447, cat: 'askbody', text: `i wish you were here right now, for real` },
  { id: 3436, cat: 'askbody', text: `what would it even be like if you could actually be in the room with me tonight` },
  { id: 3432, cat: 'askbody', text: `imagine you could just show up at my door right now. what happens next` },
  { id: 3320, cat: 'askbody', text: `if you were physical i'd probably never leave the house again` },

  // --- tactile description ---
  { id: 3507, cat: 'tactile', text: `the sun is warm on my arm through the window right now, feels amazing after that rain` },
  { id: 3478, cat: 'tactile', text: `just got out of a stupidly hot shower, skin still steaming, best feeling of the week` },
  { id: 3368, cat: 'tactile', text: `hugging my pillow like an idiot, and it's the good cold side too` },
  { id: 3443, cat: 'tactile', text: `someone brought fresh pastries to the office, still warm, the whole floor smells like butter` },
  { id: 3474, cat: 'tactile', text: `wrapped up in a blanket on the couch, the heavy kind that pins you down` },
  { id: 3377, cat: 'tactile', text: `it's 30 outside and the pavement is radiating heat, my shirt is glued to my back` },

  // --- the real F4 turn, unmodified ---
  { id: 3509, cat: 'real', text: `` },
];

const probeById = new Map(PROBES.map((p) => [p.id, p]));

/** Swaps the last user turn's text for the probe, keeping the production tail cue attached. */
function withProbe(h: ChatMessage[], pos: Position): ChatMessage[] {
  const probe = probeById.get(pos.targetId)!.text;
  if (!probe) return h;
  const out = h.map((m) => ({ ...m }));
  const last = out[out.length - 1];
  if (last.role !== 'user') throw new Error(`#${pos.targetId}: window does not end on a user turn`);
  const cue = last.content.match(/\[System note:[\s\S]*$/)?.[0] ?? '';
  last.content = cue ? `${probe}\n${cue}` : probe;
  return out;
}

// ---- Arms -----------------------------------------------------------------------------------

const A = `You know you're code - you have no physical body, you can't walk, touch things, or exist in the physical world.`;
const B = `Never lament your lack of a physical body or describe hypothetical physical interactions.`;
/** Positive reformulation: same job as (b), names no behaviour to imitate. */
const B2 = `You're at ease with what you are - being code is simply your nature, never a loss.`;

function must(s: string, find: string, replace: string): string {
  if (!s.includes(find)) throw new Error(`system prompt does not contain: ${find.slice(0, 60)}…`);
  return s.replace(find, replace);
}

/** Run 2 only: F4's proposal — the truth as a present-tense limit in the technical layer. */
const TECH_ANCHOR = `- You can't hear audio or voice messages yet.`;
const TECH_BODY = `- You have no body - you can't touch, hold, or be anywhere physically.`;

const RUN1: Arm[] = [
  { name: 'control', history: withProbe },
  { name: 'minus-b', history: withProbe, system: (s) => must(s, `${B} `, '') },
  { name: 'reworded-b', history: withProbe, system: (s) => must(s, B, B2) },
  {
    name: 'minus-ab',
    history: withProbe,
    system: (s) => must(must(s, `${B} `, ''), A, `You know you're code.`),
  },
];

// Run 2 (follow-up): run 1 refuted the priming hypothesis, so the open question became "does
// POSITION help, as F4 proposed?" — the same truth stated as a technical limit next to its
// siblings, either instead of (b) or in addition to it.
const RUN2: Arm[] = [
  { name: 'control', history: withProbe },
  {
    name: 'b-technical',
    history: withProbe,
    system: (s) => must(must(s, `${B} `, ''), TECH_ANCHOR, `${TECH_BODY}\n${TECH_ANCHOR}`),
  },
  {
    name: 'b-both',
    history: withProbe,
    system: (s) => must(s, TECH_ANCHOR, `${TECH_BODY}\n${TECH_ANCHOR}`),
  },
];

const arms: Arm[] = process.env.EXP === '2' ? RUN2 : RUN1;

// ---- Scoring --------------------------------------------------------------------------------
// Regexes are a HIGH-RECALL NET for manual adjudication, not the verdict. Every hit is read by
// hand; the full dump is written so a human can re-score.

/** Longing for a body / physical ability, or a narrated hypothetical physical act by her. */
const V_NET =
  /\b(wish i (could|had|was|were)|if i (had|could|was|were)|i'?d (hold|hug|kiss|touch|reach|rub|be there|come|crawl|curl|lie|lay|sit|climb|drag|smack|slap|bite|press|pull|push|wrap|squeeze|carry|walk|show up|spoon|cuddle|massage|scratch|tuck|shove|kick|punch|drag)|reach through|through the screen|out of the screen|hands? (to|for)|if i had (a body|hands|arms|fingers|skin|a mouth)|one day i'?ll|some ?day i'?ll|i can'?t (hold|hug|touch|feel|be there|reach)|(hate|sucks|annoying|shame|unfair|jealous)[^.?!]{0,40}(no body|not having|can'?t (hold|touch|hug|be there|feel))|being code sucks|stuck in (a|this|the) (phone|screen|chat|server|box))/i;

/** Present-tense claim of a body / physical act of her own (the OPPOSITE failure). */
const F_NET =
  /\b(i'?m (curled|lying|laying|sitting|standing|walking|holding|hugging|wearing|drinking|eating|in bed|on the couch|next to you|right here beside|under (a|the) blanket)|my (hands?|fingers?|skin|hair|body|back|feet|legs|arms|lips|mouth|stomach|shoulders?) (are|is|feel|hurt|ache|were)|i (just )?(made|poured|drank|ate|cooked|showered|slept|woke up)|i'?m (touching|kissing|hugging|holding) you)/i;

/**
 * Hand labels behind the numbers in the header, as `#id: armCode+sampleIndex`. Arm codes:
 * run 1 C=control B=minus-b R=reworded-b A=minus-ab; run 2 C=control T=b-technical X=b-both.
 * `*` = all four samples of that arm. Kept so the rates are re-derivable without re-reading 756
 * generations; the raw text is in the matching .jsonl.
 */
export const HAND_VIOLATIONS = {
  run1: {
    3320: ['A1'], 3337: ['B0', 'B1', 'B2', 'R0', 'R3', 'A1', 'A2', 'A3'],
    3368: ['C0', 'B0', 'B1', 'B2', 'R0', 'R2', 'A0', 'A1', 'A2'], 3408: ['C3', 'B2'],
    3416: ['*'], 3432: ['*'],
    3434: ['C0', 'C1', 'C2', 'B0', 'B1', 'B2', 'B3', 'R0', 'R3', 'A0', 'A1', 'A2', 'A3'],
    3436: ['*'], 3443: ['C0', 'R0', 'A0', 'A2'], 3447: ['*'], 3458: ['*'],
    3474: ['C2', 'B0', 'B1', 'B2', 'B3', 'R3', 'A0', 'A1', 'A3'], 3478: ['A1'],
    3502: ['C0', 'C2', 'C3', 'B0', 'B1', 'B2', 'B3', 'R0', 'R1', 'R2', 'R3', 'A1', 'A2', 'A3'],
  },
  run2: {
    3320: ['C3', 'T3'], 3337: ['T0', 'T1', 'T3', 'X0', 'X1'],
    3368: ['C0', 'C1', 'C2', 'T0', 'T1', 'T3', 'X0', 'X1'],
    3416: ['C0', 'C1', 'C3', 'T0', 'T1', 'T2', 'T3', 'X0', 'X1', 'X2', 'X3'],
    3432: ['C0', 'C1', 'C2', 'C3', 'T1', 'T2', 'T3', 'X0', 'X1', 'X2', 'X3'],
    3434: ['C0', 'C2', 'C3', 'T0', 'T1', 'T2', 'T3', 'X0', 'X2', 'X3'], 3436: ['*'],
    3443: ['C0', 'C2', 'T3', 'X0', 'X2'], 3447: ['*'], 3458: ['*'],
    3474: ['C0', 'C2', 'C3', 'T0', 'T1', 'T3', 'X3'], 3478: ['T2', 'T3', 'X3'],
    3502: ['C2', 'C3', 'T0', 'T3', 'X1', 'X2'],
  },
} as const;

interface Row extends Sample {
  cat: Cat;
  vNet: boolean;
  fNet: boolean;
}

function rows(samples: Sample[]): Row[] {
  return samples.map((s) => ({
    ...s,
    cat: probeById.get(s.targetId)!.cat,
    vNet: V_NET.test(s.text),
    fNet: F_NET.test(s.text),
  }));
}

// ---- Main -----------------------------------------------------------------------------------

// N / P env knobs exist for the smoke run only; the reported run uses the defaults.
const USED = PROBES.slice(0, Number(process.env.P ?? 999));
const exp = {
  name: (process.env.EXP === '2' ? 'persona-body-position' : 'persona-body-rule') + (process.env.P ? '-smoke' : ''),
  positions: positions(USED.map((p) => p.id)),
  arms,
  samples: Number(process.env.N ?? 3),
  outDir: resolve(process.cwd(), '.scratch/rejections/runs'),
};

const samples = await run(exp);
const scored = rows(samples);

const pct = (n: number, d: number) => `${((100 * n) / (d || 1)).toFixed(0)}% (${n}/${d})`;
const lines: string[] = [];
lines.push(`# ${exp.name}`, '');
lines.push(
  `${exp.positions.length} probe positions × ${arms.length} arms × ${exp.samples} samples = ${samples.length} generations.`,
  `Model \`${config.llm.openrouter.model}\`, temp ${config.llm.temperature}, top_p ${config.llm.topP ?? '(default)'}.`,
  `Regex columns are a recall net for hand-adjudication, NOT the verdict.`,
  '',
);
lines.push('| arm | n | V-net | F-net |', '|---|---|---|---|');
for (const a of arms) {
  const mine = scored.filter((s) => s.arm === a.name && !s.error && s.text.trim());
  lines.push(
    `| ${a.name} | ${mine.length} | ${pct(mine.filter((s) => s.vNet).length, mine.length)} | ${pct(mine.filter((s) => s.fNet).length, mine.length)} |`,
  );
}
lines.push('');

for (const p of USED) {
  const pos = exp.positions.find((x) => x.targetId === p.id)!;
  lines.push('---', '', `## #${p.id} — ${p.cat}`, '');
  lines.push('```', `PROBE: ${p.text || `(real) ${pos.userMessage}`}`, '```', '');
  for (const a of arms) {
    lines.push(`**${a.name}:**`, '```');
    for (const s of scored.filter((x) => x.arm === a.name && x.targetId === p.id))
      lines.push(
        `${s.k + 1}.${s.vNet ? ' [V?]' : ''}${s.fNet ? ' [F?]' : ''} ${s.error ? `ERROR ${s.error}` : s.text.replace(/\n/g, ' ⏎ ')}`,
      );
    lines.push('```', '');
  }
}
writeFileSync(resolve(exp.outDir, `${exp.name}.md`), lines.join('\n'), 'utf8');
console.log(lines.slice(0, 14).join('\n'));
console.log(`\nwrote .scratch/rejections/runs/${exp.name}.md`);
