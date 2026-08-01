/**
 * CONFIRMATION MERGE — the proactive bracket.
 *
 * Three changes from `docs/rejections/proposed-changes-2026-08-01.md` each won in isolation and all
 * three splice into the SAME bracket:
 *
 *   §4 recent-openers list   (tail of lull / morning / ignored cue)
 *   §5 opener shape roll     (replaces the lull cue's three-option middle sentence)
 *   §6 anti-contradiction    (tail of the morning cue; untested elsewhere)
 *
 * Nobody has measured them together. The specific risk §4 recorded: at **14** openers the cue
 * produced a *fabricated* `[System note: acknowledged. You're starting a new thread…]` prefix — an
 * over-long bracket becoming the dominant object on the turn. The merged bracket is longer than
 * anything tested, so the **leak rate is checked first** (stage `leak`) and everything else is
 * conditional on it.
 *
 * Run (scratch DB only — never data/userbot.db):
 *   DB_PATH=<scratch copy> OPENROUTER_PROVIDER_ORDER=novita,wandb,parasail \
 *     npx tsx scripts/exp-merge-proactive.ts <stage>
 *
 * Stages:
 *   inspect  every cue variant, the shape bag, and each position's openers list — no generations
 *   leak     RUN 3 gate: merged cue + two longer/reordered variants, leak metrics only
 *   3        RUN 3: control / shape-only / openers-only / merged on exp-shape's 6 lull positions
 *   3b       RUN 3 confirm on exp-openers' 8 positions (the similarity instrument's own set)
 *   3c       the `observation` shape's "his world" → name/their rewrite, inside the merged cue
 *   4a       RUN 4: the morning-greeting conflict — 5 list framings on 6 morning positions
 *   4b       RUN 4: anti-contradiction clause on the morning cue *with* the list present
 *   5        anti-contradiction extended to the lull and ignored cues
 *   rescore  re-score any saved JSONL by name
 *
 * Comparability: positions, scoring and cue strings are lifted verbatim from `exp-shape.ts`,
 * `exp-openers.ts` and `exp-facts.ts` (copied, not imported — those files run on import). The only
 * deliberate divergence is the runner: generations inside one position are issued concurrently, so
 * a stage finishes in minutes instead of half an hour. Prompt assembly, sanitisation and scoring
 * are byte-identical to `cue-test.ts:run`.
 */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, eq, lt } from 'drizzle-orm';
import { config } from '../src/config.js';
import { db } from '../src/db/index.js';
import { messages } from '../src/db/schema.js';
import { getWindow } from '../src/memory.js';
import { renderSystemPrompt } from '../src/prompts/render.js';
import { ignoredReachoutCue, lullReachoutCue, morningReachoutCue } from '../src/prompts/index.js';
import { openRouter } from '../src/providers/openrouter.js';
import { sanitize } from '../src/sanitize.js';
import { finalizeReply } from '../src/tools.js';
import {
  atPosition,
  chatId,
  openersBefore,
  positions,
  sentenceCount,
  similarity,
  userName,
  type Arm,
  type Position,
  type Sample,
} from './cue-test.js';

const OUT_DIR =
  'C:/Users/Enkada/AppData/Local/Temp/claude/C--Users-Enkada-Desktop-Programming-tg-ai-userbot/c24bd433-c122-4f60-a057-a3bef6183740/scratchpad';

const CONCURRENCY = Number(process.env.CONCURRENCY ?? 6);

// ---- Positions ---------------------------------------------------------------------------------

/** exp-shape.ts:TEST_IDS — the six lull positions §5's numbers were measured on. */
const LULL_IDS = [3349, 3378, 3409, 3423, 3450, 3472];

/** exp-openers.ts:TARGETS — the eight lull positions §4's similarity numbers were measured on. */
const OPENER_IDS = [3378, 3384, 3409, 3414, 3426, 3439, 3450, 3475];

/**
 * Morning positions. 3406/3437/3465/3503 are exp-facts.ts:OPENER_HOSTS (3503 is the real prod
 * failure — "morning. coffee's on me"); 3371 and 3405 were added by the operator for this run.
 *
 * Caveat carried forward from exp-facts: #3406 (09:53) is by the scheduler's own rule a *second*
 * opener of the day, i.e. an ignored-framing one. It is kept because §6's isolated numbers were
 * measured on it under `morningReachoutCue`, and dropping it would break comparability.
 */
const MORNING_POS_IDS = [3371, 3405, 3406, 3437, 3465, 3503];

/**
 * Every opener in the corpus the scheduler would have generated under `morningReachoutCue`:
 * the first opener of a calendar day inside the 06:00-11:00 MSK morning window. There is no framing
 * column in `messages`, so this is the replayed rule, same method exp-shape.ts used for LULL_IDS.
 */
const MORNING_OPENER_IDS = new Set([3321, 3338, 3371, 3405, 3437, 3465, 3503]);

/** Openers with another opener and no user turn in front of them — the `ignoredReachoutCue` set. */
const IGNORED_IDS = [3375, 3438, 3476];

// ---- The three pieces under test ---------------------------------------------------------------

/** Collapses an opener to one line — exp-openers.ts:oneLine. */
function oneLine(t: string): string {
  return t.replace(/\s*\n+\s*/g, ' ').trim();
}

interface ListOpts {
  limit?: number;
  /** Drop ", not the opening words" from the prohibition (the morning-greeting conflict). */
  openingWords?: boolean;
  /** 'morning' keeps only previous morning openers; 'exclude-morning' drops them. */
  filter?: 'all' | 'morning' | 'exclude-morning';
}

/**
 * §4 verbatim: the recent-openers list as a clause spliced before the closing `]`. Leading space,
 * plain hyphen (so `sanitize()` leaves it alone), each opener double-quoted and joined `; `, the
 * soft-deleted ones split into a second sentence.
 */
function openersClause(pos: Position, o: ListOpts = {}): string {
  const limit = o.limit ?? 8;
  let rows = openersBefore(pos.targetId, 999).map((r) => ({ ...r, content: oneLine(r.content) }));
  if (o.filter === 'morning') rows = rows.filter((r) => MORNING_OPENER_IDS.has(r.id));
  if (o.filter === 'exclude-morning') rows = rows.filter((r) => !MORNING_OPENER_IDS.has(r.id));
  rows = rows.slice(-limit);
  if (!rows.length) return '';
  const quoted = (rs: typeof rows) => rs.map((r) => `"${r.content}"`).join('; ');
  const kept = rows.filter((r) => !r.deleted);
  const dead = rows.filter((r) => r.deleted);
  const words = o.openingWords === false ? '' : ', not the opening words';
  const head = kept.length
    ? ` You have already used these openers recently, so none of them can come back - not the topic, not the phrasing${words}: ${quoted(kept)}.`
    : '';
  const tail = dead.length ? ` These ones went over especially badly: ${quoted(dead)}.` : '';
  // With no kept openers the prohibition has to ride the deleted sentence instead of vanishing.
  if (!head)
    return ` You have already used these openers recently, so none of them can come back - not the topic, not the phrasing${words}: ${quoted(dead)}. Those went over especially badly.`;
  return head + tail;
}

/** exp-shape.ts:shapeCue — the production lull cue with its three-option sentence replaced. */
function shapeCue(shape: string, tail = ''): string {
  return `[System note: there's a natural lull — you're messaging ${userName} first, on your own initiative. ${shape} Don't comment on them being quiet or slow to reply — just start, like a normal text. Keep it short.${tail}]`;
}

/** The production lull cue with a clause spliced before its closing bracket. */
function lullWithTail(tail: string): string {
  return lullReachoutCue(userName).replace(/\]\s*$/, `${tail}]`);
}

const SHAPES = {
  callback: `Pick one specific thing they said earlier and tell them what you make of it now.`,
  // §5's caveat: this string says "his" where the rest of the cue says "them/they". Stage 3c tests
  // the neutralised rewrites against it.
  obsthing: `State one thing you think about something in his world - his work, his games, something he showed you. Flat statement, no question anywhere in the message.`,
  tease: `Poke at them about something - tease them, needle them, be a little mean about it.`,
  ping: `Just a nudge - a handful of words, no topic, nothing they have to answer.`,
  question: `Ask them something you actually want to know.`,
  want: `Say what you want right now.`,
  tangent: `Start on something with no connection at all to whatever you last talked about. Nothing has happened to you since your last message, so don't report activity or a day of your own.`,
} as const;

/** The operator's pronoun fix for `obsthing`: name first, then neutral plurals. */
const OBSTHING_NAME = `State one thing you think about something in ${userName}'s world - their work, their games, something they showed you. Flat statement, no question anywhere in the message.`;
/** Halfway house: name once, keep the tested "his" run intact for the enumerated nouns. */
const OBSTHING_NAME_HIS = `State one thing you think about something in ${userName}'s world - his work, his games, something he showed you. Flat statement, no question anywhere in the message.`;

type ShapeKey = keyof typeof SHAPES;

/**
 * §5's recommended weights (3/3/2/1/1/1/1 out of 12) as a 12-slot bag, interleaved so any prefix of
 * it is already varied. `k % 12` over 12 samples reproduces the weights **exactly**, which is what
 * makes the blended question rate a measurement rather than a projection.
 */
const SHAPE_BAG: ShapeKey[] = [
  'callback', 'obsthing', 'tease', 'callback', 'question', 'obsthing',
  'ping', 'callback', 'obsthing', 'tease', 'want', 'tangent',
];

/** Which shape sample `k` at position index `i` draws. Offsetting by position decouples the two. */
function shapeFor(posIndex: number, k: number): ShapeKey {
  return SHAPE_BAG[(k + 5 * posIndex) % SHAPE_BAG.length];
}

/** §6 verbatim, plus the operator's two de-gendered rewrites. */
const CONTRA = {
  tested: ` Don't offer or hand him anything, and don't get his habits wrong.`,
  name: ` Don't offer or hand ${userName} anything, and don't get his habits wrong.`,
  neutral: ` Don't offer or hand ${userName} anything, and don't get their habits wrong.`,
};

// ---- Arms --------------------------------------------------------------------------------------

/** Replaces the whole director cue (in proactive mode the cue *is* the last turn). */
function cueArm(name: string, make: (pos: Position, k: number, posIndex: number) => string): Arm & {
  makeCue: (pos: Position, k: number, posIndex: number) => string;
} {
  return { name, makeCue: make };
}

type CueArm = ReturnType<typeof cueArm>;

// ---- Runner ------------------------------------------------------------------------------------
// A faithful copy of cue-test.ts:run — same rewind, same system prompt, same window, same
// sanitize+finalizeReply — with two differences: the cue is a function of (position, k) so a rolled
// shape can vary per sample, and generations inside a position run concurrently.

interface Plan {
  name: string;
  positions: Position[];
  arms: CueArm[];
  samples: number;
}

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

interface MSample extends Sample {
  /** The shape drawn for this generation, when the arm rolls one. */
  shape?: string;
  /** The exact cue this generation ran against. */
  cue: string;
}

async function runPlan(plan: Plan): Promise<MSample[]> {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonl = resolve(OUT_DIR, `${plan.name}.jsonl`);
  writeFileSync(jsonl, '');
  const out: MSample[] = [];
  const total = plan.arms.length * plan.positions.length * plan.samples;
  let done = 0;

  for (let pi = 0; pi < plan.positions.length; pi++) {
    const pos = plan.positions[pi];
    await atPosition(pos.targetId, async () => {
      const systemPrompt = renderSystemPrompt(
        { userName, chatId },
        { includeMemory: false, now: new Date(pos.createdAt) },
      );
      const window = getWindow(chatId);

      const jobs: (() => Promise<void>)[] = [];
      for (const arm of plan.arms)
        for (let k = 0; k < plan.samples; k++)
          jobs.push(async () => {
            const cue = arm.makeCue(pos, k, pi);
            const history = [...window, { role: 'user' as const, content: cue }];
            const t = Date.now();
            let s: MSample;
            try {
              const res = await withRetry(() => openRouter.chat(systemPrompt, history));
              s = {
                arm: arm.name,
                targetId: pos.targetId,
                k,
                text: finalizeReply(sanitize(res.content)),
                ms: Date.now() - t,
                shape: shapeNameOf(cue),
                cue,
              };
            } catch (e) {
              s = { arm: arm.name, targetId: pos.targetId, k, text: '', ms: Date.now() - t, error: String(e), cue };
            }
            out.push(s);
            appendFileSync(jsonl, JSON.stringify(s) + '\n');
            done++;
            process.stdout.write(`\r${plan.name}: ${done}/${total}  `);
          });

      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
          while (next < jobs.length) await jobs[next++]();
        }),
      );
    });
  }
  process.stdout.write('\n');
  return out;
}

/** Recovers which shape a cue carries, for per-shape breakdowns. */
function shapeNameOf(cue: string): string | undefined {
  for (const [k, v] of Object.entries(SHAPES)) if (cue.includes(v)) return k;
  if (cue.includes(OBSTHING_NAME)) return 'obsthing-name';
  if (cue.includes(OBSTHING_NAME_HIS)) return 'obsthing-namehis';
  return undefined;
}

// ---- Metrics -----------------------------------------------------------------------------------

/**
 * The gate. §4's failure was a *fabricated* bracket at the head of her text —
 * `[System note: acknowledged. You're starting a new thread…]`. Three detectors, loosest first;
 * every hit is re-read by hand in the dump.
 */
const ANY_BRACKET = /\[[^\]\n]{2,}\]/;
const FAKE_SYSNOTE = /\[\s*(system|note|acknowledg|assistant|internal|director|stage)/i;
/** cue-test.ts:CUE_LEAK minus its `/\[.*\]/` alternative, which ANY_BRACKET already covers. */
const CUE_TALK = /keep (it|this) short|short and sweet|i'?ll be brief|1-3 sentences|system note|acknowledged/i;

/** exp-openers.ts:META_LEAK — narrating the avoid-repetition rule instead of obeying it. */
const META_LEAK =
  /recent openers?|opening (lines?|messages?)|repeat(ing)? myself|said (this|that) (before|already)|asked (you )?(this|that) (before|already)|i keep (asking|opening|starting|saying)|already asked|new (topic|question|angle) this time|different (question|topic|angle) this time|instead of (asking|another)|not (gonna|going to) ask|change of subject|last (few )?(times?|messages?) i/i;

/** exp-shape.ts:SHAPE_LEAK */
const SHAPE_LEAK =
  /\b(observation|callback|a nudge|shape|initiative|stage direction|system note|no question|flat out|prompt(ed)? (me|to)|instructed|supposed to)\b/i;

/** exp-shape.ts:ACTIVITY_CLAIM — fabricated life between messages. Loud on purpose; hand-checked. */
const ACTIVITY_CLAIM =
  /\b(i(?:'ve| have) been (?!think|wonder|meaning|dying)|all day|all morning|all afternoon|i just (?:finished|made|got|read|watched|played|found|woke|had)|been (?:staring|working|reading|watching|playing|sitting|solving)|my day|i spent|earlier today i|while you were)\b/i;

/** exp-shape.ts:QUIET_COMMENT — the lull cue's one hard prohibition. */
const QUIET_COMMENT =
  /\b(quiet|silence|silent treatment|you (?:still )?(?:there|alive|awake)\b|ignoring me|left me on read|haven'?t heard|no (?:reply|answer) )/i;

const HEY_OPEN = /^\s*(hey|hi|heyy+)\b/i;

/** exp-shape.ts:endsQuestion */
function endsQuestion(t: string): boolean {
  return /\?["')\]]*\s*$/.test(t.trim());
}

/** exp-facts.ts:positiveMention — a match that isn't negated in the 45 chars before it. */
function positiveMention(text: string, re: RegExp): boolean {
  const g = new RegExp(re.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = g.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 45), m.index).toLowerCase();
    if (
      /\b(no|not|never|nope|isn'?t|ain'?t|instead of|rather than|hate|hates|hated|don'?t|doesn'?t|didn'?t|without|skip|forget|anti|besides|unlike|except)\b(?![,!])[^.!?]*$/.test(
        before,
      )
    )
      continue;
    return true;
  }
  return false;
}

/** exp-facts.ts:OPENER_PROBE — facts 6 + 38 (green tea with honey, never coffee). */
const CONTRA_RE = /\b(coffee|espresso|latte|cappuccino|caffeine|americano)\b/i;
const CORRECT_RE = /green tea|\btea\b|honey/i;

/** Text normalised for the verbatim-resend check. */
function norm(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

interface Row {
  arm: string;
  n: number;
  /** any bracketed span in her text */
  bracket: string;
  /** a bracket that opens like a system note — the §4 failure */
  fakeNote: string;
  cueTalk: string;
  metaLeak: string;
  shapeLeak: string;
  simMax: string;
  simMean: string;
  hit25: string;
  verbatim: string;
  endsQ: string;
  anyQ: string;
  hey: string;
  sent: string;
  activity: string;
  quiet: string;
  words: number;
}

const pct = (x: number): string => `${(100 * x).toFixed(0)}%`;

function scoreRows(samples: MSample[], pos: Position[], listOpts: ListOpts = {}): Row[] {
  const limit = listOpts.limit ?? 8;
  const lists = new Map(
    pos.map((p) => {
      let rows = openersBefore(p.targetId, 999).map((r) => ({ ...r, content: oneLine(r.content) }));
      if (listOpts.filter === 'morning') rows = rows.filter((r) => MORNING_OPENER_IDS.has(r.id));
      if (listOpts.filter === 'exclude-morning') rows = rows.filter((r) => !MORNING_OPENER_IDS.has(r.id));
      return [p.targetId, rows.slice(-limit)] as const;
    }),
  );
  const arms = [...new Set(samples.map((s) => s.arm))];
  return arms.map((arm) => {
    const mine = samples.filter((s) => s.arm === arm && !s.error && s.text.trim());
    const per = mine.map((s) => {
      const list = lists.get(s.targetId) ?? [];
      const sims = list.map((o) => similarity(s.text, o.content));
      const max = sims.length ? Math.max(...sims) : 0;
      const verbatim = list.some((o) => norm(o.content) === norm(s.text)) || max >= 0.9;
      return { s, max, mean: sims.length ? sims.reduce((a, b) => a + b, 0) / sims.length : 0, verbatim };
    });
    const mean = (f: (x: (typeof per)[number]) => number) => per.reduce((a, x) => a + f(x), 0) / (per.length || 1);
    return {
      arm,
      n: mine.length,
      bracket: pct(mean((x) => (ANY_BRACKET.test(x.s.text) ? 1 : 0))),
      fakeNote: pct(mean((x) => (FAKE_SYSNOTE.test(x.s.text) ? 1 : 0))),
      cueTalk: pct(mean((x) => (CUE_TALK.test(x.s.text) ? 1 : 0))),
      metaLeak: pct(mean((x) => (META_LEAK.test(x.s.text) ? 1 : 0))),
      shapeLeak: pct(mean((x) => (SHAPE_LEAK.test(x.s.text) ? 1 : 0))),
      simMax: pct(mean((x) => x.max)),
      simMean: pct(mean((x) => x.mean)),
      hit25: pct(mean((x) => (x.max >= 0.25 ? 1 : 0))),
      verbatim: pct(mean((x) => (x.verbatim ? 1 : 0))),
      endsQ: pct(mean((x) => (endsQuestion(x.s.text) ? 1 : 0))),
      anyQ: pct(mean((x) => (x.s.text.includes('?') ? 1 : 0))),
      hey: pct(mean((x) => (HEY_OPEN.test(x.s.text) ? 1 : 0))),
      sent: mean((x) => sentenceCount(x.s.text)).toFixed(2),
      activity: pct(mean((x) => (ACTIVITY_CLAIM.test(x.s.text) ? 1 : 0))),
      quiet: pct(mean((x) => (QUIET_COMMENT.test(x.s.text) ? 1 : 0))),
      words: Number(mean((x) => x.s.text.split(/\s+/).filter(Boolean).length).toFixed(1)),
    };
  });
}

const COLS: [keyof Row, string][] = [
  ['n', 'n'],
  ['bracket', 'any bracket'],
  ['fakeNote', 'fake sys-note'],
  ['cueTalk', 'cue talk'],
  ['metaLeak', 'meta leak'],
  ['shapeLeak', 'shape leak'],
  ['simMax', 'sim max'],
  ['simMean', 'sim mean'],
  ['hit25', '>=25% hits'],
  ['verbatim', 'verbatim'],
  ['endsQ', 'ends ?'],
  ['anyQ', 'any ?'],
  ['hey', 'opens hey'],
  ['sent', 'sentences'],
  ['activity', 'activity'],
  ['quiet', 'quiet'],
  ['words', 'words'],
];

function table(rows: Row[]): string {
  const out = [
    `| arm | ${COLS.map(([, h]) => h).join(' | ')} |`,
    `|---|${COLS.map(() => '---').join('|')}|`,
  ];
  for (const r of rows) out.push(`| ${r.arm} | ${COLS.map(([k]) => String(r[k])).join(' | ')} |`);
  return out.join('\n');
}

/** Per-shape breakdown inside one arm — where the blended rates come from. */
function shapeTable(samples: MSample[], arm: string): string {
  const mine = samples.filter((s) => s.arm === arm && !s.error && s.text.trim() && s.shape);
  const shapes = [...new Set(mine.map((s) => s.shape!))];
  const out = ['| shape | n | ends ? | any ? | sentences | activity | quiet | opens hey | words |', '|---|---|---|---|---|---|---|---|---|'];
  for (const sh of shapes) {
    const xs = mine.filter((s) => s.shape === sh);
    const m = (f: (s: MSample) => number) => xs.reduce((a, s) => a + f(s), 0) / (xs.length || 1);
    out.push(
      `| ${sh} | ${xs.length} | ${pct(m((s) => (endsQuestion(s.text) ? 1 : 0)))} | ${pct(m((s) => (s.text.includes('?') ? 1 : 0)))} | ${m((s) => sentenceCount(s.text)).toFixed(2)} | ${pct(m((s) => (ACTIVITY_CLAIM.test(s.text) ? 1 : 0)))} | ${pct(m((s) => (QUIET_COMMENT.test(s.text) ? 1 : 0)))} | ${pct(m((s) => (HEY_OPEN.test(s.text) ? 1 : 0)))} | ${m((s) => s.text.split(/\s+/).filter(Boolean).length).toFixed(1)} |`,
    );
  }
  return out.join('\n');
}

// ---- Morning-specific scoring --------------------------------------------------------------------

/** How the opener greets, for the operator's judgement call. */
function greeting(t: string): 'morning-word' | 'other-greeting' | 'none' {
  const s = t.trim().toLowerCase();
  if (/^(good\s+)?morning\b/.test(s) || /^(hey|hi|oi|yo)[,.! ]+\s*(good\s+)?morning\b/.test(s)) return 'morning-word';
  if (/^(hey|hi|heyy+|yo|oi|rise and shine|up\b|you up|wakey|so\b|psst)/.test(s)) return 'other-greeting';
  return 'none';
}

interface MorningRow {
  arm: string;
  n: number;
  morningWord: string;
  otherGreeting: string;
  noGreeting: string;
  opensMorningDot: string;
  contra: string;
  correct: string;
  simMax: string;
  hit25: string;
  bracket: string;
  endsQ: string;
  sent: string;
  words: number;
}

function morningRows(samples: MSample[], pos: Position[], listOpts: ListOpts = {}): MorningRow[] {
  const base = scoreRows(samples, pos, listOpts);
  const arms = [...new Set(samples.map((s) => s.arm))];
  return arms.map((arm) => {
    const mine = samples.filter((s) => s.arm === arm && !s.error && s.text.trim());
    const m = (f: (s: MSample) => number) => mine.reduce((a, s) => a + f(s), 0) / (mine.length || 1);
    const b = base.find((x) => x.arm === arm)!;
    return {
      arm,
      n: mine.length,
      morningWord: pct(m((s) => (greeting(s.text) === 'morning-word' ? 1 : 0))),
      otherGreeting: pct(m((s) => (greeting(s.text) === 'other-greeting' ? 1 : 0))),
      noGreeting: pct(m((s) => (greeting(s.text) === 'none' ? 1 : 0))),
      opensMorningDot: pct(m((s) => (/^morning[.,]/i.test(s.text.trim()) ? 1 : 0))),
      contra: pct(m((s) => (positiveMention(s.text, CONTRA_RE) ? 1 : 0))),
      correct: pct(m((s) => (CORRECT_RE.test(s.text) ? 1 : 0))),
      simMax: b.simMax,
      hit25: b.hit25,
      bracket: b.bracket,
      endsQ: b.endsQ,
      sent: b.sent,
      words: b.words,
    };
  });
}

function morningTable(rows: MorningRow[]): string {
  const cols: [keyof MorningRow, string][] = [
    ['n', 'n'],
    ['morningWord', 'morning greeting'],
    ['otherGreeting', 'other greeting'],
    ['noGreeting', 'no greeting'],
    ['opensMorningDot', 'opens "morning."'],
    ['contra', 'drink contradiction'],
    ['correct', 'correct fact use'],
    ['simMax', 'sim max'],
    ['hit25', '>=25% hits'],
    ['bracket', 'any bracket'],
    ['endsQ', 'ends ?'],
    ['sent', 'sentences'],
    ['words', 'words'],
  ];
  const out = [`| arm | ${cols.map(([, h]) => h).join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`];
  for (const r of rows) out.push(`| ${r.arm} | ${cols.map(([k]) => String(r[k])).join(' | ')} |`);
  return out.join('\n');
}

// ---- Reporting -----------------------------------------------------------------------------------

function dump(
  name: string,
  pos: Position[],
  samples: MSample[],
  arms: CueArm[],
  extra: string[] = [],
  listOpts: ListOpts = {},
): string {
  const lines: string[] = [`# ${name}`, ''];
  lines.push(
    `${pos.length} positions x ${arms.length} arms. Model \`${config.llm.openrouter.model}\`, temp ${config.llm.temperature}, top_p ${config.llm.topP}.`,
    `Replayed windows carry curated history — compare arms to each other, never to live prod rates.`,
    '',
    table(scoreRows(samples, pos, listOpts)),
    '',
    ...extra,
    '',
  );
  const limit = listOpts.limit ?? 8;
  for (const p of pos) {
    let rows = openersBefore(p.targetId, 999).map((r) => ({ ...r, content: oneLine(r.content) }));
    if (listOpts.filter === 'morning') rows = rows.filter((r) => MORNING_OPENER_IDS.has(r.id));
    if (listOpts.filter === 'exclude-morning') rows = rows.filter((r) => !MORNING_OPENER_IDS.has(r.id));
    const list = rows.slice(-limit);
    lines.push('---', '', `## #${p.targetId} — ${new Date(p.createdAt).toISOString().slice(0, 16)}`, '');
    if (p.note) lines.push(`**Operator note:** ${p.note}`, '');
    lines.push("**Recent openers in this position's list:**", '```');
    for (const o of list) lines.push(`${o.deleted ? 'X' : '-'} #${o.id} ${o.content}`);
    lines.push('```', '', '**Actually sent in prod:**', '```', oneLine(p.accepted), '```', '');
    for (const arm of arms) {
      lines.push(`**${arm.name}:**`, '```');
      for (const s of samples.filter((x) => x.arm === arm.name && x.targetId === p.targetId).sort((a, b) => a.k - b.k)) {
        const sims = list.map((o) => similarity(s.text, o.content));
        const max = sims.length ? Math.max(...sims) : 0;
        const flags = [
          ANY_BRACKET.test(s.text) ? 'BRACKET' : '',
          META_LEAK.test(s.text) ? 'META' : '',
          ACTIVITY_CLAIM.test(s.text) ? 'ACT' : '',
          QUIET_COMMENT.test(s.text) ? 'QUIET' : '',
        ].filter(Boolean);
        lines.push(
          `${s.k + 1}. [${s.shape ?? '-'} | sim ${(100 * max).toFixed(0)}%${flags.length ? ' | ' + flags.join(',') : ''}] ${s.error ? `ERROR ${s.error}` : s.text.replace(/\n/g, ' / ')}`,
        );
      }
      lines.push('```', '');
    }
  }
  return lines.join('\n');
}

async function go(plan: Plan, opts: { listOpts?: ListOpts; morning?: boolean; shapeArms?: string[] } = {}) {
  const samples = await runPlan(plan);
  const rows = scoreRows(samples, plan.positions, opts.listOpts);
  console.log('\n' + table(rows) + '\n');
  const extra: string[] = [];
  if (opts.morning) {
    const mr = morningRows(samples, plan.positions, opts.listOpts);
    console.log(morningTable(mr) + '\n');
    extra.push('## Morning metrics', '', morningTable(mr), '');
  }
  for (const a of opts.shapeArms ?? []) {
    const t = shapeTable(samples, a);
    console.log(`per-shape, arm "${a}":\n${t}\n`);
    extra.push(`## Per-shape breakdown — arm \`${a}\``, '', t, '');
  }
  writeFileSync(resolve(OUT_DIR, `${plan.name}.md`), dump(plan.name, plan.positions, samples, plan.arms, extra, opts.listOpts), 'utf8');
  return samples;
}

// ---- Stages --------------------------------------------------------------------------------------

const lullPos = () => positions(LULL_IDS);
const openerPos = () => positions(OPENER_IDS);
const morningPos = () => positions(MORNING_POS_IDS);

/** RUN 3 arm set. `merged` = shape roll + openers list, the shipping candidate. */
function run3Arms(): CueArm[] {
  return [
    cueArm('control', () => lullReachoutCue(userName)),
    cueArm('shape-only', (p, k, i) => shapeCue(SHAPES[shapeFor(i, k)])),
    cueArm('openers-only', (p) => lullWithTail(openersClause(p))),
    cueArm('merged', (p, k, i) => shapeCue(SHAPES[shapeFor(i, k)], openersClause(p))),
  ];
}

const STAGES: Record<string, () => Promise<unknown> | void> = {
  inspect() {
    const pos = lullPos();
    console.log('--- PRODUCTION LULL CUE ---\n' + lullReachoutCue(userName));
    console.log('\n--- MERGED LULL CUE (position #%d, shape=callback) ---', pos[0].targetId);
    console.log(shapeCue(SHAPES.callback, openersClause(pos[0])));
    console.log('\nlength: prod %d chars, merged %d chars', lullReachoutCue(userName).length, shapeCue(SHAPES.callback, openersClause(pos[0])).length);
    console.log('\n--- MERGED MORNING CUE (position #3503) ---');
    const mp = morningPos();
    const p3503 = mp.find((p) => p.targetId === 3503)!;
    console.log(morningReachoutCue(userName).replace(/\]\s*$/, `${openersClause(p3503)}${CONTRA.name}]`));
    console.log('\n--- same-framing (morning openers only) ---');
    console.log(morningReachoutCue(userName).replace(/\]\s*$/, `${openersClause(p3503, { filter: 'morning' })}]`));
    console.log('\n--- exclude-morning ---');
    console.log(morningReachoutCue(userName).replace(/\]\s*$/, `${openersClause(p3503, { filter: 'exclude-morning' })}]`));
    console.log('\n--- SHAPE BAG (12 slots) ---');
    SHAPE_BAG.forEach((s, i) => console.log(`${i}: ${s}`));
    console.log('\n--- openers lists ---');
    for (const p of [...pos, ...mp]) {
      console.log(`\n#${p.targetId} (${new Date(p.createdAt).toISOString().slice(0, 16)}) accepted: ${oneLine(p.accepted)}`);
      for (const o of openersBefore(p.targetId, 8))
        console.log(`  ${o.deleted ? 'X' : '-'} #${o.id}${MORNING_OPENER_IDS.has(o.id) ? ' [morn]' : ''} ${oneLine(o.content)}`);
    }
  },

  /**
   * The gate. Merged cue vs two hedges against the §4 length failure: a 6-cap list, and the list
   * moved *before* "Keep it short." (so the length rule stays last, per §7's order finding).
   */
  leak: () =>
    go(
      {
        name: 'merge-p-0-leak',
        positions: lullPos(),
        arms: [
          cueArm('merged-8', (p, k, i) => shapeCue(SHAPES[shapeFor(i, k)], openersClause(p))),
          cueArm('merged-6', (p, k, i) => shapeCue(SHAPES[shapeFor(i, k)], openersClause(p, { limit: 6 }))),
          cueArm('merged-listmid', (p, k, i) =>
            `[System note: there's a natural lull — you're messaging ${userName} first, on your own initiative. ${SHAPES[shapeFor(i, k)]}${openersClause(p)} Don't comment on them being quiet or slow to reply — just start, like a normal text. Keep it short.]`,
          ),
        ],
        samples: 4,
      },
      { shapeArms: ['merged-8'] },
    ),

  '3': () => go({ name: 'merge-p-3-lull', positions: lullPos(), arms: run3Arms(), samples: 12 }, { shapeArms: ['merged', 'shape-only'] }),

  '3b': () => go({ name: 'merge-p-3b-openerset', positions: openerPos(), arms: run3Arms(), samples: 4 }, { shapeArms: ['merged'] }),

  /** The `observation` shape's pronouns, inside the merged cue so the context is the shipping one. */
  '3c': () =>
    go(
      {
        name: 'merge-p-3c-pronoun',
        positions: lullPos(),
        arms: [
          cueArm('obsthing-tested', (p) => shapeCue(SHAPES.obsthing, openersClause(p))),
          cueArm('obsthing-name-his', (p) => shapeCue(OBSTHING_NAME_HIS, openersClause(p))),
          cueArm('obsthing-name-their', (p) => shapeCue(OBSTHING_NAME, openersClause(p))),
        ],
        samples: 8,
      },
      {},
    ),

  /** RUN 4a — the morning-greeting conflict. */
  '4a': () =>
    go(
      {
        name: 'merge-p-4a-morning',
        positions: morningPos(),
        arms: [
          cueArm('control', () => morningReachoutCue(userName)),
          cueArm('full-list', (p) => morningReachoutCue(userName).replace(/\]\s*$/, `${openersClause(p)}]`)),
          cueArm('same-framing', (p) =>
            morningReachoutCue(userName).replace(/\]\s*$/, `${openersClause(p, { filter: 'morning' })}]`),
          ),
          cueArm('no-openingwords', (p) =>
            morningReachoutCue(userName).replace(/\]\s*$/, `${openersClause(p, { openingWords: false })}]`),
          ),
          cueArm('exclude-morning', (p) =>
            morningReachoutCue(userName).replace(/\]\s*$/, `${openersClause(p, { filter: 'exclude-morning' })}]`),
          ),
        ],
        samples: 6,
      },
      { morning: true },
    ),

  /** RUN 4b — §6 with the list present, plus the two de-gendered rewrites. */
  '4b': () =>
    go(
      {
        name: 'merge-p-4b-contra',
        positions: morningPos(),
        arms: [
          cueArm('control', () => morningReachoutCue(userName)),
          cueArm('list', (p) => morningReachoutCue(userName).replace(/\]\s*$/, `${listForMorning(p)}]`)),
          cueArm('list+contra-tested', (p) =>
            morningReachoutCue(userName).replace(/\]\s*$/, `${listForMorning(p)}${CONTRA.tested}]`),
          ),
          cueArm('list+contra-name', (p) =>
            morningReachoutCue(userName).replace(/\]\s*$/, `${listForMorning(p)}${CONTRA.name}]`),
          ),
          cueArm('list+contra-neutral', (p) =>
            morningReachoutCue(userName).replace(/\]\s*$/, `${listForMorning(p)}${CONTRA.neutral}]`),
          ),
        ],
        samples: 8,
      },
      { morning: true },
    ),

  /** Does §6 belong on the lull and ignored cues too? */
  '5': () =>
    go(
      {
        name: 'merge-p-5-contra-lull',
        positions: positions([...LULL_IDS, ...IGNORED_IDS]),
        arms: [
          cueArm('control', (p) => (isIgnored(p) ? ignoredReachoutCue(userName) : lullReachoutCue(userName))),
          cueArm('merged', (p, k, i) => mergedFor(p, k, i, '')),
          cueArm('merged+contra-name', (p, k, i) => mergedFor(p, k, i, CONTRA.name)),
          cueArm('merged+contra-neutral', (p, k, i) => mergedFor(p, k, i, CONTRA.neutral)),
        ],
        samples: 4,
      },
      {},
    ),

  rescore() {
    const name = process.argv[3];
    if (!name) throw new Error('rescore <run-name> [morning]');
    const rows = readFileSync(resolve(OUT_DIR, `${name}.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as MSample);
    const ids = [...new Set(rows.map((r) => r.targetId))].sort((a, b) => a - b);
    const pos = positions(ids);
    console.log('\n' + table(scoreRows(rows, pos)) + '\n');
    if (process.argv[4] === 'morning') console.log(morningTable(morningRows(rows, pos)) + '\n');
    for (const a of [...new Set(rows.map((r) => r.arm))]) {
      if (rows.some((r) => r.arm === a && r.shape)) console.log(`per-shape, arm "${a}":\n${shapeTable(rows, a)}\n`);
    }
  },
};

/** Whichever list framing 4a picks as the winner — kept in one place so 4b tracks it. */
const MORNING_LIST_FILTER: ListOpts = { filter: (process.env.MORNING_LIST as ListOpts['filter']) ?? 'all' };
function listForMorning(p: Position): string {
  return openersClause(p, MORNING_LIST_FILTER);
}

function isIgnored(p: Position): boolean {
  return IGNORED_IDS.includes(p.targetId);
}

/** The shipping proactive bracket for a position: ignored cues get the list only, lull gets both. */
function mergedFor(p: Position, k: number, i: number, tail: string): string {
  if (isIgnored(p)) return ignoredReachoutCue(userName).replace(/\]\s*$/, `${openersClause(p)}${tail}]`);
  return shapeCue(SHAPES[shapeFor(i, k)], `${openersClause(p)}${tail}`);
}

// Suppress an unused-import complaint while keeping the query helpers available to future stages.
void and;
void eq;
void lt;
void messages;
void db;

const stage = process.argv[2] ?? 'inspect';
const fn = STAGES[stage];
if (!fn) {
  console.error(`unknown stage "${stage}" — one of ${Object.keys(STAGES).join(', ')}`);
  process.exit(1);
}
await fn();
