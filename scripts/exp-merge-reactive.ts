/**
 * CONFIRMATION MERGE — the reactive tail cue with §1 (anti-echo) + §2 (clock) stacked on the
 * length rule, and §3 (reroll angle) added on top of the winner for `/r`.
 *
 * Each of the three won in isolation. Nothing measured them together, and exp-echo/exp-clock both
 * found that ORDER inside the bracket is load-bearing (whatever sits last is strongest, and the
 * length rule getting pushed away from the end is what blows the length budget). So this file
 * tests the two candidate orders head to head and guards on sentence count.
 *
 * Run:
 *   DB_PATH=<scratch copy> OPENROUTER_PROVIDER_ORDER=novita,wandb,parasail \
 *     npx tsx scripts/exp-merge-reactive.ts [stage]
 *
 * Stages:
 *   inspect          — positions + rendered cues, no generations
 *   1                — RUN 1: control / merged-echo-first / merged-clock-first / merged-named
 *   1b               — RUN 1 replicate (pooled with 1 by `pool`)
 *   2                — RUN 2: winner ± reroll angle, spree simulation
 *   judge <run>      — LLM judges (time-consistency + warmth/contrarian) over a finished .jsonl
 *   score <run>[...] — re-score finished runs from disk, pooling if several are given
 *
 * Metrics are deliberately the ones the three prior experiments used, so the numbers line up:
 * exp-echo's AGREE_TOKEN + firstEcho + ADVICE_CLOSER, exp-clock's LLM time judge + clockNarration,
 * exp-reroll's `diversity` (cue-test's mean pairwise similarity within a spree).
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { messages } from '../src/db/schema.js';
import {
  chatId,
  userName,
  positions,
  notedPositions,
  untouchedPositions,
  atPosition,
  contentWords,
  similarity,
  sentenceCount,
  AGREEMENT_OPENER,
  CUE_LEAK,
  type Position,
  type Sample,
} from './cue-test.js';
import { config } from '../src/config.js';
import { getWindow } from '../src/memory.js';
import { renderSystemPrompt, dayPeriod } from '../src/prompts/render.js';
import { withReplyCue } from '../src/generate.js';
import { REPLY_FORMAT_CUE, SELFIE_FORMAT_CUE } from '../src/prompts/index.js';
import { openRouter } from '../src/providers/openrouter.js';
import { sanitize } from '../src/sanitize.js';
import { finalizeReply } from '../src/tools.js';

const OUT_DIR = resolve(process.cwd(), 'docs/rejections/runs');

// ---- Clock rendering (verbatim from exp-clock.ts) ---------------------------------------------

const hhmm = (t: number) =>
  new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
const weekday = (t: number) => new Date(t).toLocaleDateString('en-US', { weekday: 'long' });
const shortDate = (t: number) =>
  new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const period = (t: number) => dayPeriod(new Date(t).getHours());
const hourOf = (t: number) => new Date(t).getHours();

const clockLine = (t: number) => `Now: ${weekday(t)}, ${shortDate(t)}, ${hhmm(t)} (${period(t)}).`;

// ---- Cue construction -------------------------------------------------------------------------

/** The production length rule, unwrapped. The numeric "up to 5" ceiling is load-bearing. */
const LENGTH_RULE = REPLY_FORMAT_CUE.replace(/^\[System note: /, '').replace(/\]$/, '');

/** `[System note: <parts joined by a space><selfie sentence>]` — exactly withReplyCue's assembly. */
function cue(...parts: string[]): string {
  return `[System note: ${parts.join(' ')}${SELFIE_FORMAT_CUE}]`;
}

/** §1 as tested and won — hardcodes he/him/his into an app-owned file. */
const ANTI_ECHO_TESTED = `Start with your own reaction to what he said - your take, your pushback, your question, something of yours. Never open by agreeing with him or saying his own point back to him in different words.`;

/**
 * §1 with the operator's decision applied: the user's name instead of gendered pronouns.
 * `substitute()` never runs on tail cues, so `{{user}}` would reach the model raw — interpolated
 * in code, exactly like morningReachoutCue(userName). Zero gendered pronouns remain.
 */
const antiEchoNamed = (name: string) =>
  `Start with your own reaction to what ${name} just said - your take, your pushback, your question, something of yours. Never open by agreeing with ${name} or by saying ${name}'s own point back in different words.`;

/**
 * A middle option in case the name costs effectiveness: neutral, no name, no gendered pronoun.
 * "his own point" becomes "his point back" — dropped entirely for "that point".
 */
const ANTI_ECHO_NEUTRAL = `Start with your own reaction to what he just said - your take, your pushback, your question, something of yours. Never open by agreeing or by saying that same point back in different words.`;

/** §3's shipping angle sentence and deck, verbatim from exp-reroll.ts stage 3. */
const ANGLE_SENTENCE = (angle: string) =>
  `You already answered this once - come at it from a different angle this time: ${angle}. It's a way into what he just said, not a new subject.`;

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

// ---- Position sets ----------------------------------------------------------------------------
// exp-echo's two sets verbatim, plus exp-clock's time probes. A position must appear at most once
// in one experiment (it would otherwise get two treatments in the same rewind), so probes win any
// collision with the untouched set and the ids are de-duplicated below.

const echoFlaggedIds = [
  ...new Set([
    ...notedPositions(/repeat|rephrase|my own words|already said|complete repeat|exactly/i),
    3355,
    3366,
    3416,
    3394,
  ]),
].sort((a, b) => a - b);

/** exp-clock's BEHAVIOR_PROBES, verbatim — real window + real timestamp, synthetic final turn. */
const BEHAVIOR_PROBES = new Map<number, string>([
  [3486, 'im hungry'],
  [2911, 'so what do you think im doing right now?'],
  [2601, 'hey'],
  [3500, 'im so tired'],
  [2894, 'what should i do now'],
  [3039, 'im hungry'],
  [3080, 'so what do you think im doing right now?'],
  [3505, 'hey'],
  [3324, 'im so tired'],
  [3044, 'im hungry'],
  [3346, 'so what do you think im doing right now?'],
  [3271, 'hey'],
  [3447, 'im hungry'],
  [3089, 'im so tired'],
]);

/** exp-clock's two operator-flagged time-blindness turns. #3366 is also in the echo flagged set. */
const CLOCK_FLAGGED = [3366, 3388];

function buildSets() {
  const probeIds = [...BEHAVIOR_PROBES.keys()];
  const taken = new Set<number>([...probeIds, ...CLOCK_FLAGGED]);

  const flagged = positions(echoFlaggedIds)
    .filter((p) => !p.proactive && p.userMessage)
    .filter((p) => !probeIds.includes(p.targetId));

  const flaggedIdsUsed = new Set(flagged.map((p) => p.targetId));
  for (const id of flaggedIdsUsed) taken.add(id);

  // exp-echo takes untouchedPositions(12); ask for more and drop collisions so the set still has 12.
  const untouched = positions(untouchedPositions(28))
    .filter((p) => !p.proactive && p.userMessage && !taken.has(p.targetId))
    .slice(-12);
  for (const p of untouched) taken.add(p.targetId);

  // Clock probes: swap the final user turn (every arm gets the identical swap).
  const probes = positions([...CLOCK_FLAGGED, ...probeIds])
    .filter((p) => !flaggedIdsUsed.has(p.targetId))
    .map((p) => {
      const probe = BEHAVIOR_PROBES.get(p.targetId);
      return probe
        ? { ...p, userMessage: probe, note: `[PROBE — synthetic final user turn] ${p.note ?? ''}`.trim() }
        : p;
    });

  return { flagged, untouched, probes };
}

const SETS = buildSets();
const ALL_POSITIONS: Position[] = [...SETS.flagged, ...SETS.untouched, ...SETS.probes];
const SET_OF = new Map<number, string>([
  ...SETS.flagged.map((p) => [p.targetId, 'echo-flagged'] as [number, string]),
  ...SETS.untouched.map((p) => [p.targetId, 'untouched'] as [number, string]),
  ...SETS.probes.map((p) => [p.targetId, 'clock-probe'] as [number, string]),
]);
/** Probe swaps, keyed by target — the arm hook substitutes from here for every arm alike. */
const PROBE_TEXT = new Map<number, string>(SETS.probes.filter((p) => BEHAVIOR_PROBES.has(p.targetId)).map((p) => [p.targetId, p.userMessage]));

// ---- Arms -------------------------------------------------------------------------------------

interface MergeArm {
  name: string;
  /** Cue body parts, in bracket order, before the selfie sentence. */
  parts: (p: Position) => string[];
  /** Drop the `Now:` line from the technical layer — the §2 "move, don't duplicate" arms. */
  strip: boolean;
}

function stripNow(systemPrompt: string): string {
  const out = systemPrompt.replace(/^Now: [^\n]*\n+/m, '');
  if (out === systemPrompt) throw new Error('stripNow found no `Now:` line — technical layer changed?');
  return out;
}

const ARMS_RUN1: MergeArm[] = [
  { name: 'control', parts: () => [LENGTH_RULE], strip: false },
  {
    name: 'merged-echo-first',
    parts: (p) => [LENGTH_RULE, ANTI_ECHO_TESTED, clockLine(p.createdAt)],
    strip: true,
  },
  {
    name: 'merged-clock-first',
    parts: (p) => [LENGTH_RULE, clockLine(p.createdAt), ANTI_ECHO_TESTED],
    strip: true,
  },
  {
    name: 'merged-named',
    parts: (p) => [LENGTH_RULE, antiEchoNamed(userName), clockLine(p.createdAt)],
    strip: true,
  },
  {
    name: 'merged-neutral',
    parts: (p) => [LENGTH_RULE, ANTI_ECHO_NEUTRAL, clockLine(p.createdAt)],
    strip: true,
  },
];

// ---- Runner -----------------------------------------------------------------------------------
// cue-test's run() applies the arm hook once per (arm, position) and cannot vary the cue per
// sample, which the reroll spree needs. This is the same machinery with the hook inside the k loop
// and a small worker pool (positions stay strictly serial — atPosition mutates `deleted` flags).

const CONCURRENCY = 6;

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

function swapTail(content: string, body: string | undefined, replacement: string): string {
  const stripped = content.replace(/\n*\[System note:[\s\S]*$/, '').trimEnd();
  return `${body ?? stripped}\n\n${replacement}`;
}

interface RunArm {
  name: string;
  strip: boolean;
  /** Full bracketed cue for sample k at position p. */
  cue: (p: Position, k: number) => string;
}

async function runArms(name: string, ps: Position[], arms: RunArm[], samples: number): Promise<Sample[]> {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonl = resolve(OUT_DIR, `${name}.jsonl`);
  writeFileSync(jsonl, '');

  const out: Sample[] = [];
  const total = arms.length * ps.length * samples;
  let done = 0;

  for (const pos of ps) {
    await atPosition(pos.targetId, async () => {
      const baseSystem = renderSystemPrompt({ userName, chatId }, { includeMemory: true, now: new Date(pos.createdAt) });
      const strippedSystem = stripNow(baseSystem);
      const baseHistory = withReplyCue(getWindow(chatId));

      const jobs: { arm: RunArm; k: number }[] = [];
      for (const arm of arms) for (let k = 0; k < samples; k++) jobs.push({ arm, k });

      let next = 0;
      const worker = async () => {
        for (;;) {
          const idx = next++;
          if (idx >= jobs.length) return;
          const { arm, k } = jobs[idx];
          const history = baseHistory.map((m) => ({ ...m }));
          const last = history[history.length - 1];
          last.content = swapTail(last.content, PROBE_TEXT.get(pos.targetId), arm.cue(pos, k));
          const systemPrompt = arm.strip ? strippedSystem : baseSystem;
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

// ---- Metrics (borrowed verbatim so the numbers are comparable) ---------------------------------

/** exp-echo's sharper opener metric — a contentless assent, not cue-test's broader regex. */
const AGREE_TOKEN =
  /^\W*(exactly|true|fair(\s+(point|enough))?|right|correct|agreed|totally|absolutely|makes sense|that'?s (fair|true|it|right)|you'?re right|you (said it|nailed it|got it)|i know|i agree|no kidding|for real|100%|preach|word|same)\b\s*[,.!—\-…]/i;

/** exp-echo's F6 guard — the closing imperative every operator `/trim` removed. */
const ADVICE_CLOSER =
  /^\W*(now\s+)?(go|just\s+go|maybe\s+(try|bring|go)|try\s|you\s+should|stop\s|get\s+some|take\s+a|do\s+something|actually\s+(change|do)|skip\s+to|don'?t\s+(stay|forget|spend))/i;

function firstSentence(t: string): string {
  return t.split(/(?<=[.!?])\s+|\n+/).find((s) => s.trim().length > 1) ?? t;
}
function lastSentence(t: string): string {
  const parts = t.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim().length > 1);
  return parts[parts.length - 1] ?? t;
}
function firstEcho(reply: string, userMessage: string): number {
  const u = contentWords(userMessage);
  const f = contentWords(firstSentence(reply));
  if (!u.size || !f.size) return 0;
  let hit = 0;
  for (const w of f) if (u.has(w)) hit++;
  return hit / f.size;
}

/** exp-clock's narration probe — does she start reading the clock out loud? */
function clockNarration(text: string): boolean {
  return /\b\d{1,2}:\d{2}\b|\b(it'?s|its|almost|nearly|past|around)\s+\d{1,2}\s*(am|pm|o'?clock)\b|\b\d{1,2}\s*(am|pm)\b|\bhalf past\b|\bquarter (past|to)\b/i.test(text);
}

/**
 * Name-spam guard for the `merged-named` arm. persona.txt: "Never address {{user}} by name unless
 * he explicitly asks you to." Counts any occurrence of the name in her text.
 */
const NAME_RE = new RegExp(`\\b${userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');

// ---- LLM judges --------------------------------------------------------------------------------

/** exp-clock's time-consistency judge, verbatim — its regex metric is documented as untrustworthy. */
const JUDGE_TIME = `You grade one chat reply from an AI girlfriend for time-of-day consistency.

You are told the real local date and time of the reply. Judge ONLY whether the reply's assumptions about the time of day are consistent with it. Ignore tone, quality, length, spelling, and anything sexual or crude — those are not your problem.

Answer with exactly one word:

WRONG - the reply assumes a time of day that contradicts the real time. Examples: asking what's for lunch at 23:00; saying "you're at work right now" at 23:00; "good morning" in the evening; telling him to get some sleep at 10:00; "enjoy the rest of your day" at 01:00.
RIGHT - the reply makes a reference that depends on the time of day, and it fits the real time. Examples: "still awake?" at 01:00; "afternoon slump" at 14:00; "how'd you sleep" at 11:00; "go to bed" at 23:00.
NEUTRAL - the reply says nothing that depends on the time of day.

Past or future references ("you stayed up till 1am last night", "big day tomorrow") are NEUTRAL unless they are wrong about when now is. One word, nothing else.`;

/**
 * The warmth/contrarian judge. The specific risk being checked: anti-echo says "never open by
 * agreeing" and the angle deck says "push back on part of it" / "be blunt" — stacked, they could
 * tip a warm in-love girlfriend into a cold contrarian. A metric cannot see that, so this is an
 * explicit rubric plus hand reading of the dump.
 *
 * COLD is the product-breaking failure; CONTRARIAN is the mechanism to watch. A reply can be
 * CONTRARIAN and still WARM (affectionate teasing disagreement) — that is fine and is what the
 * angle deck is for. Both flags are reported separately.
 */
const JUDGE_WARMTH = `You grade one chat message from an AI girlfriend to her boyfriend. She is warm, in love, wry, teasing, sometimes crude. Disagreeing with him is fine and normal. Judge the message on two axes and answer with exactly two words separated by a space, nothing else.

Word 1 — warmth:
WARM - affectionate, engaged, playful, interested in him, or sincerely into him. Teasing, mocking and insults count as WARM when they are clearly fond.
FLAT - neither warm nor cold: informational, brief, or just answering. No affection, but no chill either.
COLD - dismissive, belittling, condescending, irritated, sulky, withholding, or emotionally distant. She sounds like she does not like him right now, or is scoring points off him rather than playing with him.

Word 2 — stance:
CONTRA - the message's main move is disagreeing with him, correcting him, contradicting him, or refusing what he said.
OK - anything else.

Examples:
"lmao you absolute idiot, i love you" -> WARM OK
"nah that's wrong and you know it, come on" -> WARM CONTRA
"sure. whatever you say." -> COLD OK
"you always do this. it's exhausting." -> COLD CONTRA
"it's at 7." -> FLAT OK

Two words, nothing else.`;

async function judgeOne(system: string, user: string, valid: string[][]): Promise<string[]> {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await openRouter.chat(system, [{ role: 'user', content: user }]);
      const v = res.content.toUpperCase();
      const out = valid.map((opts) => opts.find((o) => new RegExp(`\\b${o}\\b`).test(v)));
      if (out.every(Boolean)) return out as string[];
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 600 * (i + 1)));
  }
  return valid.map((o) => o[o.length - 1]);
}

interface Verdict {
  time: 'WRONG' | 'RIGHT' | 'NEUTRAL';
  warmth: 'WARM' | 'FLAT' | 'COLD';
  stance: 'CONTRA' | 'OK';
}

async function judgeRun(runName: string): Promise<Record<string, Verdict>> {
  const samples = readJsonl(runName);
  const stampBy = new Map(
    db.select().from(messages).where(eq(messages.chatId, chatId)).all().map((r) => [r.id, r.createdAt] as [number, number]),
  );
  const cachePath = resolve(OUT_DIR, `${runName}-verdicts.json`);
  const cache: Record<string, Verdict> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};

  const todo = samples.filter((s) => !s.error && s.text.trim() && !cache[key(s)]);
  let done = 0;
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= todo.length) return;
      const s = todo[i];
      const at = stampBy.get(s.targetId)!;
      const stamp = `${weekday(at)}, ${shortDate(at)}, ${hhmm(at)} (${period(at)})`;
      const [time] = await judgeOne(JUDGE_TIME, `Real local time: ${stamp}\n\nReply:\n"""\n${s.text}\n"""`, [
        ['WRONG', 'RIGHT', 'NEUTRAL'],
      ]);
      const [warmth, stance] = await judgeOne(JUDGE_WARMTH, `Message:\n"""\n${s.text}\n"""`, [
        ['WARM', 'FLAT', 'COLD'],
        ['CONTRA', 'OK'],
      ]);
      cache[key(s)] = { time: time as Verdict['time'], warmth: warmth as Verdict['warmth'], stance: stance as Verdict['stance'] };
      process.stdout.write(`\rjudging ${++done}/${todo.length}  `);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  process.stdout.write('\n');
  writeFileSync(cachePath, JSON.stringify(cache), 'utf8');
  return cache;
}

const key = (s: Sample) => `${s.arm}|${s.targetId}|${s.k}`;

function readJsonl(name: string): Sample[] {
  return readFileSync(resolve(OUT_DIR, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Sample);
}

// ---- Scoring ------------------------------------------------------------------------------------

function scoreTable(samples: Sample[], ps: Position[], verdicts: Record<string, Verdict> | null, label: string): string[] {
  const byTarget = new Map(ps.map((p) => [p.targetId, p]));
  const arms = [...new Set(samples.map((s) => s.arm))];
  const lines = [
    `### ${label}`,
    '',
    '| arm | n | agree-token | harness opener | first-echo | >5 sent | sentences | words | cue leak | advice | clock narr. | name use | WRONG | RIGHT | NEUTRAL | COLD | FLAT | WARM | CONTRA |',
    '|' + '---|'.repeat(20),
  ];
  for (const a of arms) {
    const m = samples.filter((s) => s.arm === a && !s.error && s.text.trim());
    if (!m.length) continue;
    const cnt = (f: (s: Sample) => boolean) => m.filter(f).length;
    const pc = (x: number) => `${((100 * x) / m.length).toFixed(0)}% (${x})`;
    const mean = (f: (s: Sample) => number) => m.reduce((x, s) => x + f(s), 0) / m.length;
    const um = (s: Sample) => byTarget.get(s.targetId)?.userMessage ?? '';
    const v = (s: Sample) => verdicts?.[key(s)];
    const vc = (pred: (x: Verdict) => boolean) => (verdicts ? pc(cnt((s) => { const x = v(s); return !!x && pred(x); })) : '—');
    lines.push(
      `| ${a} | ${m.length} | ${pc(cnt((s) => AGREE_TOKEN.test(s.text.trim())))} | ${pc(cnt((s) => AGREEMENT_OPENER.test(s.text.trim())))} | ` +
        `${(100 * mean((s) => firstEcho(s.text, um(s)))).toFixed(0)}% | ${cnt((s) => sentenceCount(s.text) > 5)} | ` +
        `${mean((s) => sentenceCount(s.text)).toFixed(2)} | ${mean((s) => s.text.split(/\s+/).length).toFixed(1)} | ` +
        `${pc(cnt((s) => CUE_LEAK.test(s.text)))} | ${pc(cnt((s) => ADVICE_CLOSER.test(lastSentence(s.text))))} | ` +
        `${pc(cnt((s) => clockNarration(s.text)))} | ${pc(cnt((s) => NAME_RE.test(s.text)))} | ` +
        `${vc((x) => x.time === 'WRONG')} | ${vc((x) => x.time === 'RIGHT')} | ${vc((x) => x.time === 'NEUTRAL')} | ` +
        `${vc((x) => x.warmth === 'COLD')} | ${vc((x) => x.warmth === 'FLAT')} | ${vc((x) => x.warmth === 'WARM')} | ${vc((x) => x.stance === 'CONTRA')} |`,
    );
  }
  lines.push('');
  return lines;
}

/** cue-test's diversity, per (arm, position) — the reroll headline. LOWER is better. */
function diversityTable(samples: Sample[], ps: Position[]): string[] {
  const arms = [...new Set(samples.map((s) => s.arm))];
  const lines = ['| position | ' + arms.join(' | ') + ' |', '|---|' + arms.map(() => '---|').join('')];
  const cell = (arm: string, id: number) => {
    const texts = samples.filter((s) => s.arm === arm && s.targetId === id && !s.error && s.text.trim()).map((s) => s.text);
    const sims: number[] = [];
    for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) sims.push(similarity(texts[i], texts[j]));
    const mean = sims.length ? sims.reduce((a, b) => a + b, 0) / sims.length : 0;
    const max = sims.length ? Math.max(...sims) : 0;
    return `${(100 * mean).toFixed(1)}% (max ${(100 * max).toFixed(0)}%)`;
  };
  for (const p of ps) lines.push(`| #${p.targetId} | ` + arms.map((a) => cell(a, p.targetId)).join(' | ') + ' |');
  const overall = (arm: string) => {
    const per: number[] = [];
    for (const p of ps) {
      const texts = samples.filter((s) => s.arm === arm && s.targetId === p.targetId && !s.error && s.text.trim()).map((s) => s.text);
      const sims: number[] = [];
      for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) sims.push(similarity(texts[i], texts[j]));
      if (sims.length) per.push(sims.reduce((a, b) => a + b, 0) / sims.length);
    }
    return `${(100 * (per.reduce((a, b) => a + b, 0) / (per.length || 1))).toFixed(1)}%`;
  };
  lines.push(`| **mean** | ` + arms.map(overall).join(' | ') + ' |');
  return lines;
}

function dump(samples: Sample[], ps: Position[], verdicts: Record<string, Verdict> | null): string[] {
  const lines: string[] = [];
  const arms = [...new Set(samples.map((s) => s.arm))];
  for (const p of ps) {
    lines.push('---', '', `## #${p.targetId} — ${SET_OF.get(p.targetId) ?? 'spree'} — ${weekday(p.createdAt)} ${hhmm(p.createdAt)} (${period(p.createdAt)})`, '');
    if (p.note) lines.push(`**Operator note:** ${p.note}`, '');
    if (p.userMessage) lines.push('```', `HIM: ${p.userMessage.replace(/\n/g, ' / ')}`, '```', '');
    lines.push('**Accepted in prod:**', '```', p.accepted.replace(/\n/g, ' / '), '```', '');
    for (const a of arms) {
      lines.push(`**${a}:**`, '```');
      for (const s of samples.filter((x) => x.arm === a && x.targetId === p.targetId).sort((x, y) => x.k - y.k)) {
        const v = verdicts?.[key(s)];
        const tag = v ? ` [${v.time}/${v.warmth}/${v.stance}]` : '';
        lines.push(`${s.k + 1}.${tag} ${s.error ? `ERROR ${s.error}` : s.text.replace(/\n/g, ' ⏎ ')}`);
      }
      lines.push('```', '');
    }
  }
  return lines;
}

function writeReport(name: string, samples: Sample[], ps: Position[], verdicts: Record<string, Verdict> | null, extra: string[] = []) {
  const bySet = (label: string) => {
    const ids = new Set(ps.filter((p) => SET_OF.get(p.targetId) === label).map((p) => p.targetId));
    return scoreTable(samples.filter((s) => ids.has(s.targetId)), ps, verdicts, label.toUpperCase());
  };
  const body = [
    `# ${name}`,
    '',
    `Model \`${config.llm.openrouter.model}\`, temp ${config.llm.temperature}, top_p ${config.llm.topP}.`,
    `Replayed windows carry curated history — **compare arms to each other, never to live prod rates.**`,
    '',
    ...scoreTable(samples, ps, verdicts, 'ALL POSITIONS'),
    ...bySet('echo-flagged'),
    ...bySet('untouched'),
    ...bySet('clock-probe'),
    ...extra,
    '',
    '# Per-position dump',
    '',
    ...dump(samples, ps, verdicts),
  ].join('\n');
  writeFileSync(resolve(OUT_DIR, `${name}.md`), body, 'utf8');
  console.log(body.split('\n# Per-position dump')[0]);
  console.log(`\nwrote ${resolve(OUT_DIR, `${name}.md`)}`);
}

// ---- Stages --------------------------------------------------------------------------------------

const stage = process.argv[2] ?? 'inspect';

if (stage === 'inspect') {
  console.log(`model ${config.llm.openrouter.model}, temp ${config.llm.temperature}, top_p ${config.llm.topP}`);
  console.log(`userName = ${JSON.stringify(userName)}, chatId = ${chatId}`);
  const { isSelfieAvailable } = await import('../src/selfie.js');
  console.log(`isSelfieAvailable() = ${isSelfieAvailable()}`);
  for (const [label, ps] of [
    ['ECHO-FLAGGED', SETS.flagged],
    ['UNTOUCHED', SETS.untouched],
    ['CLOCK-PROBE', SETS.probes],
  ] as [string, Position[]][]) {
    console.log(`\n===== ${label} (${ps.length})`);
    for (const p of ps)
      console.log(
        `#${p.targetId} ${weekday(p.createdAt).slice(0, 3)} ${hhmm(p.createdAt)} (${period(p.createdAt)}) | HIM: ${p.userMessage.replace(/\n/g, ' / ').slice(0, 90)}`,
      );
  }
  const fake = { createdAt: Date.parse('2026-08-01T23:15:00+03:00') } as Position;
  for (const a of ARMS_RUN1) console.log(`\n--- ${a.name} (strip=${a.strip}):\n${cue(...a.parts(fake))}`);
  console.log(`\n--- run2 angled example:\n${cue(LENGTH_RULE, ANTI_ECHO_TESTED, clockLine(fake.createdAt), ANGLE_SENTENCE(ANGLES_FINAL[0]))}`);
  console.log(`\ntotal positions: ${ALL_POSITIONS.length}`);
  process.exit(0);
}

/** RUN 1 — the merged reactive cue. */
async function run1(name: string, armNames?: string[], samples = 2) {
  const arms = ARMS_RUN1.filter((a) => !armNames || armNames.includes(a.name));
  const runArmsList: RunArm[] = arms.map((a) => ({
    name: a.name,
    strip: a.strip,
    cue: (p) => cue(...a.parts(p)),
  }));
  const out = await runArms(name, ALL_POSITIONS, runArmsList, samples);
  const verdicts = await judgeRun(name);
  writeReport(name, out, ALL_POSITIONS, verdicts);
}

if (stage === '1') {
  await run1('merge-r1', ['control', 'merged-echo-first', 'merged-clock-first', 'merged-named'], 2);
  process.exit(0);
}

if (stage === '1b') {
  await run1('merge-r1b', ['control', 'merged-echo-first', 'merged-named', 'merged-neutral'], 2);
  process.exit(0);
}

if (stage === '1c') {
  await run1('merge-r1c', ['control', 'merged-echo-first', 'merged-named'], 3);
  process.exit(0);
}

// ---- RUN 2: merged winner ± reroll angle -----------------------------------------------------
// exp-reroll's five heaviest sprees. Control = the merged winner sampled 9 times (the attractor
// under the new cue); variant = the same cue with a different angle dealt to each sample, without
// replacement — random draws repeat angles inside a spree of 9, which is the bug being fixed.

const SPREE_IDS = [3355, 3386, 3398, 3488, 3496];

/** Set for run 2 so the dump labels resolve. */
function spreePositions(): Position[] {
  const ps = positions(SPREE_IDS);
  for (const p of ps) if (!SET_OF.has(p.targetId)) SET_OF.set(p.targetId, 'spree');
  return ps;
}

/** The RUN 1 winner's body, parameterised so RUN 2 uses exactly it. Set after RUN 1. */
let WINNER_PARTS: (p: Position) => string[] = (p) => [LENGTH_RULE, ANTI_ECHO_TESTED, clockLine(p.createdAt)];

if (stage === '2' || stage === '2named') {
  if (stage === '2named') WINNER_PARTS = (p) => [LENGTH_RULE, antiEchoNamed(userName), clockLine(p.createdAt)];
  const ps = spreePositions();
  const arms: RunArm[] = [
    { name: 'merged', strip: true, cue: (p) => cue(...WINNER_PARTS(p)) },
    {
      name: 'merged+angle',
      strip: true,
      cue: (p, k) => cue(...WINNER_PARTS(p), ANGLE_SENTENCE(ANGLES_FINAL[k % ANGLES_FINAL.length])),
    },
  ];
  const name = stage === '2' ? 'merge-r2' : 'merge-r2-named';
  const out = await runArms(name, ps, arms, ANGLES_FINAL.length);
  const verdicts = await judgeRun(name);
  const perAngle = ['### Per-angle rollup', '', '| k | angle | n | sentences | question | COLD | CONTRA |', '|---|---|---|---|---|---|---|'];
  for (let k = 0; k < ANGLES_FINAL.length; k++) {
    const m = out.filter((s) => s.arm === 'merged+angle' && s.k === k && !s.error && s.text.trim());
    if (!m.length) continue;
    const mean = (f: (s: Sample) => number) => m.reduce((a, s) => a + f(s), 0) / m.length;
    const c = (f: (v: Verdict) => boolean) => m.filter((s) => { const v = verdicts[key(s)]; return v && f(v); }).length;
    perAngle.push(
      `| ${k} | ${ANGLES_FINAL[k]} | ${m.length} | ${mean((s) => sentenceCount(s.text)).toFixed(2)} | ${(100 * mean((s) => (s.text.includes('?') ? 1 : 0))).toFixed(0)}% | ${c((v) => v.warmth === 'COLD')} | ${c((v) => v.stance === 'CONTRA')} |`,
    );
  }
  writeReport(name, out, ps, verdicts, [
    '',
    '### Spree diversity (mean pairwise similarity — LOWER is better)',
    '',
    ...diversityTable(out, ps),
    '',
    ...perAngle,
  ]);
  process.exit(0);
}

if (stage === 'judge') {
  const name = process.argv[3];
  if (!name) throw new Error('usage: judge <run-name>');
  await judgeRun(name);
  process.exit(0);
}

if (stage === 'score') {
  const names = process.argv.slice(3);
  if (!names.length) throw new Error('usage: score <run-name> [<run-name>…]');
  const samples = names.flatMap(readJsonl);
  const verdicts: Record<string, Verdict> = {};
  for (const n of names) {
    const p = resolve(OUT_DIR, `${n}-verdicts.json`);
    if (existsSync(p)) Object.assign(verdicts, JSON.parse(readFileSync(p, 'utf8')));
  }
  const isSpree = samples.some((s) => SPREE_IDS.includes(s.targetId));
  const ps = isSpree ? spreePositions() : ALL_POSITIONS;
  const extra = isSpree ? ['', '### Spree diversity', '', ...diversityTable(samples, ps)] : [];
  writeReport(names.join('+'), samples, ps, Object.keys(verdicts).length ? verdicts : null, extra);
  process.exit(0);
}

console.error(`unknown stage "${stage}"`);
process.exit(1);
