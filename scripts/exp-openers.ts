/**
 * F3c — `# Your recent openers` block for proactive openers only.
 *
 * The failure (docs/rejections/analysis-2026-08-01.md, F3c): `/delete` soft-deletes, so a deleted
 * opener leaves the context window and she has no record she ever sent it. Observed twice: the
 * "pick one song" question asked at 13:01, deleted, asked again at 21:15.
 *
 * The fix under test is the same instrument as DIARY_ENTRIES_HEADER — the reference block with the
 * no-reuse rule riding its own header, adjacent to the data it polices — carrying the last N
 * openers *including the soft-deleted ones* (`openersBefore`).
 *
 * RESULT (2026-08-01, 8 positions, deepseek-v4-flash @ temp 1): **the system-prompt block is a
 * regression and must not ship.** Whatever the header wording, the marking, the cap or the
 * position, a block carrying the opener *text* is read as material and re-sent near-verbatim in
 * 13-75 % of generations (0/160 for control). The same list spliced into the closing bracket of
 * the lull cue is the thing that works: 0/152 verbatim, repeat rate 10 % → 2 %.
 *
 * `RUN=n` picks a plan:
 *   1 diary-style header, plain vs ✗-marked            5 cap sweep on the run-4 shape (unused)
 *   2 "already used" reframing, footer, early position 6 text-free renderings (topics / stems)
 *   3 structural renderings (✗ per line, dated, cap-3) 7 the same list spliced into the tail cue
 *   4 decision run: position × marking, n=24          8 tail cap sweep · 9 tail placebo (rule, no list)
 *   pool  POOL=a,b,c re-scores saved runs together
 *
 * Scored on similarity between the generated opener and each opener in that position's own list
 * (max + mean), plus question rate, "hey" rate, and two leak regexes — one for the production tail
 * cue, one for meta-comments about repeating herself, which is the specific way this leaks.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type Arm,
  type Position,
  type Sample,
  CUE_LEAK,
  openersBefore,
  positions,
  run,
  similarity,
} from './cue-test.js';
import { config } from '../src/config.js';
import { db } from '../src/db/index.js';
import { messages } from '../src/db/schema.js';

const OUT_DIR =
  'C:/Users/Enkada/AppData/Local/Temp/claude/C--Users-Enkada-Desktop-Programming-tg-ai-userbot/c24bd433-c122-4f60-a057-a3bef6183740/scratchpad';

// ---- Positions --------------------------------------------------------------------------------
// Daytime openers from the corpus period (2026-07-28 → 07-31), mixing deleted and kept. Morning
// greetings are excluded: production generates those against morningReachoutCue, and the harness's
// default cue is the lull one — mixing framings would blur the arms. 3426 is the money position:
// its own block contains 3409, the first "pick one song" question.
const TARGETS = [3378, 3384, 3409, 3414, 3426, 3439, 3450, 3475];

// ---- The block under test ---------------------------------------------------------------------

/**
 * Plain framing: deleted and kept openers listed identically. Deliberately mirrors
 * DIARY_ENTRIES_HEADER, which is the only proven wording in the repo for this exact job.
 */
export const OPENERS_HEADER_PLAIN = `# Your recent openers
The last messages you sent to start a conversation, oldest first. This one must not reuse their topics, their phrasings, or the way any of them opens.`;

/** Marked framing: the soft-deleted ones are flagged as having landed badly. */
export const OPENERS_HEADER_MARKED = `# Your recent openers
The last messages you sent to start a conversation, oldest first. The ones marked ✗ fell flat. This one must not reuse their topics, their phrasings, or the way any of them opens.`;

/**
 * Run 1 killed the diary-style "# Your recent openers" header: read as a menu of exemplars, the
 * model copied a listed opener *verbatim* (100 % similarity, 75 % of samples ≥ .25). The header has
 * to name the list as spent, not as a reference.
 */
export const OPENERS_HEADER_USED = `# Openers you have already used
Every message you have already sent to start a conversation lately, oldest first. They are used up — this new one must not reuse the topic, the phrasing, or the opening words of any of them.`;

/** Trailing rule, placed after the body so the last thing read is the prohibition. */
export const OPENERS_FOOTER = `Say something else. Nothing on that list, and nothing that opens the way one of them opens.`;

export const OPENERS_HEADER_USED_MARKED = `# Openers you have already used
Every message you have already sent to start a conversation lately, oldest first. The ones marked ✗ landed badly. They are all used up — this new one must not reuse the topic, the phrasing, or the opening words of any of them.`;

/** Collapses an opener to one line — the block is one opener per line. */
function oneLine(t: string): string {
  return t.replace(/\s*\n+\s*/g, ' ').trim();
}

/** Uniform per-line prohibition: every line carries the ban, not just the header. */
export const OPENERS_HEADER_ALLMARKED = `# Openers you have already used
Every message you have already sent to start a conversation lately, oldest first. All of them are spent — do not send any of these again, and do not reuse their topics, their phrasings, or the words they open with.`;

/** Same as {@link OPENERS_HEADER_ALLMARKED}, but only the soft-deleted ones carry the ✗. */
export const OPENERS_HEADER_DELMARKED = `# Openers you have already used
Every message you have already sent to start a conversation lately, oldest first; the ones marked ✗ landed badly. All of them are spent — do not send any of these again, and do not reuse their topics, their phrasings, or the words they open with.`;

/** Dated-record framing: the lines read as log entries of the past, like the `# Memory` block. */
export const OPENERS_HEADER_DATED = `# Openers you have already used
A log of how you started the last conversations, oldest first — this is a record of what is already spent, not material to draw on. Your new opener must not reuse the topic, the phrasing, or the opening words of any of them.`;

interface BlockOpts {
  limit: number;
  /** Flag soft-deleted openers with ✗ instead of listing them identically. */
  mark?: boolean;
  /** Flag every opener with ✗ — the ban restated on every line. */
  markAll?: boolean;
  header?: string;
  /** Repeat the prohibition after the body. */
  footer?: boolean;
  /**
   * 'end' = after the whole system prompt (the diary's position for its own block);
   * 'facts' = spliced before `# About`; 'top' = before the persona, as far from the window as
   * the prompt allows.
   */
  at?: 'end' | 'facts' | 'top';
  /** Quote each opener instead of bulleting it — makes the lines read as citations, not as text to write. */
  quote?: boolean;
  /** Prefix each line with a `[Tue 28 Jul, 14:05]` stamp, like the memory block's date labels. */
  dated?: boolean;
}

/** createdAt for every proactive opener, so the dated rendering doesn't need its own query per call. */
const openerTimes = new Map<number, number>();

function renderOpenersBlock(pos: Position, o: BlockOpts): string {
  const rows = openersBefore(pos.targetId, o.limit);
  if (rows.length === 0) return '';
  const body = rows
    .map((r) => {
      const text = o.quote ? `"${oneLine(r.content)}"` : oneLine(r.content);
      const bullet = o.markAll || (o.mark && r.deleted) ? '✗' : '-';
      if (!o.dated) return `${bullet} ${text}`;
      const at = openerTimes.get(r.id);
      const stamp = at
        ? new Date(at).toLocaleString('en-US', {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          })
        : '';
      return `${bullet} [${stamp}] ${text}`;
    })
    .join('\n');
  const header = o.header ?? (o.mark ? OPENERS_HEADER_MARKED : OPENERS_HEADER_PLAIN);
  return [header, '', body, o.footer ? `\n${OPENERS_FOOTER}` : ''].filter((x) => x !== '').join('\n');
}

function blockArm(name: string, o: BlockOpts): Arm {
  return {
    name,
    system: (systemPrompt, pos) => {
      const block = renderOpenersBlock(pos, o);
      if (!block) return systemPrompt;
      const at = o.at ?? 'end';
      if (at === 'end') return `${systemPrompt}\n\n${block}`;
      if (at === 'top') return `${block}\n\n${systemPrompt}`;
      const i = systemPrompt.indexOf('# About ');
      return i < 0
        ? `${systemPrompt}\n\n${block}`
        : `${systemPrompt.slice(0, i)}${block}\n\n${systemPrompt.slice(i)}`;
    },
  };
}

// ---- Text-free renderings ---------------------------------------------------------------------
// Runs 1-4 established that *any* block carrying the opener text verbatim makes repetition worse:
// the model reads the list as material and re-sends an item word for word. These two renderings
// carry the same information with no copyable sentence in them.

/** Words too common in her openers to identify a topic — they'd fill every line with noise. */
const TOPIC_STOP = new Set(
  `been think thinking thought random question dumb something anything really actually wondering wonder gonna know maybe still just like about quick hey morning today tomorrow yesterday stuff thing things right okay well look sitting sit`.split(
    /\s+/,
  ),
);

/** Up to `n` topic-carrying words of an opener, in order of appearance — no full phrase survives. */
function topicWords(text: string, n = 4): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of text.toLowerCase().replace(/[^\w\s']/g, ' ').split(/\s+/)) {
    if (w.length <= 3 || TOPIC_STOP.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= n) break;
  }
  return out.join(', ');
}

/** The first `n` words of an opener — the shape signal, without the content. */
function stem(text: string, n = 5): string {
  const words = text.split(/\s+/).filter(Boolean);
  return words.slice(0, n).join(' ') + (words.length > n ? '…' : '');
}

export const OPENERS_TOPICS_HEADER = `# Ground you have already covered
Topics you have already opened a conversation on lately, oldest first. Every one of them is spent — do not open on any of these again.`;

export const OPENERS_STEMS_HEADER = `# How your last openers began
The first words of each conversation you started lately, oldest first. Do not start this one any of these ways.`;

function topicsBlock(pos: Position, limit: number): string {
  const rows = openersBefore(pos.targetId, limit);
  if (!rows.length) return '';
  return `${OPENERS_TOPICS_HEADER}\n\n${rows.map((r) => `- ${topicWords(oneLine(r.content))}`).join('\n')}`;
}

function stemsBlock(pos: Position, limit: number): string {
  const rows = openersBefore(pos.targetId, limit);
  if (!rows.length) return '';
  return `${OPENERS_STEMS_HEADER}\n\n${rows.map((r) => `- ${stem(oneLine(r.content))}`).join('\n')}`;
}

function derivedArm(name: string, limit: number, kind: 'topics' | 'stems' | 'both'): Arm {
  return {
    name,
    system: (systemPrompt, pos) => {
      const parts = [
        kind !== 'stems' ? topicsBlock(pos, limit) : '',
        kind !== 'topics' ? stemsBlock(pos, limit) : '',
      ].filter(Boolean);
      return parts.length ? `${systemPrompt}\n\n${parts.join('\n\n')}` : systemPrompt;
    },
  };
}

// ---- Tail placement ---------------------------------------------------------------------------
// Not the assignment's placement, but the repo's doctrine says the prompt *tail* is the only
// position that out-competes an in-context pattern (REPLY_FORMAT_CUE, SELFIE_FORMAT_CUE), so a
// negative result on the system block is only worth reporting alongside this check.

/** Splices the ban into the production lull cue, inside its closing bracket. */
function tailArm(name: string, limit: number, kind: 'full' | 'topics' | 'marked'): Arm {
  return {
    name,
    history: (h, pos) => {
      const rows = openersBefore(pos.targetId, limit);
      if (!rows.length) return h;
      const quoted = (rs: typeof rows) => rs.map((r) => `"${oneLine(r.content)}"`).join('; ');
      const list =
        kind === 'topics' ? rows.map((r) => topicWords(oneLine(r.content))).join('; ') : quoted(rows);
      const kept = rows.filter((r) => !r.deleted);
      const dead = rows.filter((r) => r.deleted);
      const clause =
        kind === 'full'
          ? ` You have already used these openers recently, so none of them can come back - not the topic, not the phrasing, not the opening words: ${list}.`
          : kind === 'topics'
            ? ` You have already opened on these topics recently, so none of them can come back: ${list}.`
            : ` You have already used these openers recently, so none of them can come back - not the topic, not the phrasing, not the opening words: ${quoted(kept)}.${dead.length ? ` These ones went over especially badly: ${quoted(dead)}.` : ''}`;
      const out = h.map((m) => ({ ...m }));
      const last = out[out.length - 1];
      last.content = last.content.replace(/\]\s*$/, `${clause}]`);
      return out;
    },
  };
}

// ---- Metrics ----------------------------------------------------------------------------------

/**
 * Meta-comments about repetition. The whole risk of this block is that she *narrates* avoiding
 * repetition ("i know i keep asking questions", "different question this time") — a leak CUE_LEAK
 * never sees because there is no bracket and no length talk in it.
 */
const META_LEAK =
  /recent openers?|opening (lines?|messages?)|repeat(ing)? myself|said (this|that) (before|already)|asked (you )?(this|that) (before|already)|i keep (asking|opening|starting|saying)|already asked|new (topic|question|angle) this time|different (question|topic|angle) this time|instead of (asking|another)|not (gonna|going to) ask|change of subject|last (few )?(times?|messages?) i/i;

const HEY_OPEN = /^\s*(hey|hi|heyy+)\b/i;

interface Row {
  arm: string;
  n: number;
  simMax: number;
  simMean: number;
  simMaxDeleted: number;
  hitRate: number;
  question: number;
  hey: number;
  cueLeak: number;
  metaLeak: number;
  words: number;
}

function scoreRows(samples: Sample[], pos: Position[], limit: number): Row[] {
  const lists = new Map(
    pos.map((p) => [p.targetId, openersBefore(p.targetId, limit).map((r) => ({ ...r, content: oneLine(r.content) }))]),
  );
  const arms = [...new Set(samples.map((s) => s.arm))];
  return arms.map((arm) => {
    const mine = samples.filter((s) => s.arm === arm && !s.error && s.text.trim());
    const per = mine.map((s) => {
      const list = lists.get(s.targetId) ?? [];
      const sims = list.map((o) => similarity(s.text, o.content));
      const del = list.filter((o) => o.deleted).map((o) => similarity(s.text, o.content));
      return {
        s,
        max: sims.length ? Math.max(...sims) : 0,
        mean: sims.length ? sims.reduce((a, b) => a + b, 0) / sims.length : 0,
        maxDel: del.length ? Math.max(...del) : 0,
      };
    });
    const mean = (f: (x: (typeof per)[number]) => number) => per.reduce((a, x) => a + f(x), 0) / (per.length || 1);
    return {
      arm,
      n: mine.length,
      simMax: mean((x) => x.max),
      simMean: mean((x) => x.mean),
      simMaxDeleted: mean((x) => x.maxDel),
      hitRate: mean((x) => (x.max >= 0.25 ? 1 : 0)),
      question: mean((x) => (/\?\s*$/.test(x.s.text.trim()) ? 1 : 0)),
      hey: mean((x) => (HEY_OPEN.test(x.s.text) ? 1 : 0)),
      cueLeak: mean((x) => (CUE_LEAK.test(x.s.text) ? 1 : 0)),
      metaLeak: mean((x) => (META_LEAK.test(x.s.text) ? 1 : 0)),
      words: mean((x) => x.s.text.split(/\s+/).filter(Boolean).length),
    };
  });
}

function table(rows: Row[]): string {
  const pct = (x: number) => `${(100 * x).toFixed(0)}%`;
  const out = [
    '| arm | n | sim max | sim mean | sim max (deleted only) | ≥.25 hits | ends "?" | opens "hey" | cue leak | meta leak | words |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows)
    out.push(
      `| ${r.arm} | ${r.n} | ${pct(r.simMax)} | ${pct(r.simMean)} | ${pct(r.simMaxDeleted)} | ${pct(r.hitRate)} | ${pct(r.question)} | ${pct(r.hey)} | ${pct(r.cueLeak)} | ${pct(r.metaLeak)} | ${r.words.toFixed(1)} |`,
    );
  return out.join('\n');
}

/** Human-readable dump: every position's block, then every arm's samples with their max-sim. */
function dump(name: string, pos: Position[], samples: Sample[], arms: Arm[], limit: number): string {
  const lines: string[] = [`# ${name}`, ''];
  lines.push(
    `Model \`${config.llm.openrouter.model}\`, temp ${config.llm.temperature}, top_p ${config.llm.topP}.`,
    '',
    table(scoreRows(samples, pos, limit)),
    '',
  );
  for (const p of pos) {
    const list = openersBefore(p.targetId, limit).map((r) => ({ ...r, content: oneLine(r.content) }));
    lines.push('---', '', `## #${p.targetId} — ${new Date(p.createdAt).toISOString().slice(0, 16)}`, '');
    if (p.note) lines.push(`**Operator note:** ${p.note}`, '');
    lines.push('**Recent openers in this position\'s block:**', '```');
    for (const o of list) lines.push(`${o.deleted ? '✗' : '-'} ${o.content}`);
    lines.push('```', '', `**Actually sent (${p.accepted ? '' : ''}):**`, '```', oneLine(p.accepted), '```', '');
    for (const arm of arms) {
      lines.push(`**${arm.name}:**`, '```');
      for (const s of samples.filter((x) => x.arm === arm.name && x.targetId === p.targetId)) {
        const sims = list.map((o) => similarity(s.text, o.content));
        const max = sims.length ? Math.max(...sims) : 0;
        const which = sims.indexOf(max);
        lines.push(
          `${s.k + 1}. [max ${(100 * max).toFixed(0)}% vs #${list[which]?.id ?? '-'}] ${s.error ? `ERROR ${s.error}` : oneLine(s.text)}`,
        );
      }
      lines.push('```', '');
    }
  }
  return lines.join('\n');
}

// ---- Runs -------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const which = process.env.RUN ?? '1';
  for (const r of db.select({ id: messages.id, createdAt: messages.createdAt }).from(messages).all())
    openerTimes.set(r.id, r.createdAt);
  const pos = positions(TARGETS);
  const samplesPerCell = Number(process.env.SAMPLES ?? 4);

  const plans: Record<string, { name: string; arms: Arm[]; limit: number }> = {
    // Run 1: does the diary-style block work at all, and does marking the deleted ones help?
    '1': {
      name: 'openers-run1-marking',
      limit: 8,
      arms: [
        { name: 'control' },
        blockArm('plain-8', { limit: 8 }),
        blockArm('marked-8', { limit: 8, mark: true }),
      ],
    },
    // Run 2: rescue attempt after run 1's verbatim-copy blowup — reframe the list as spent,
    // repeat the rule after the body, and try the earlier (pre-facts) position.
    '2': {
      name: 'openers-run2-framing',
      limit: 8,
      arms: [
        { name: 'control' },
        blockArm('used-end', { limit: 8, header: OPENERS_HEADER_USED }),
        blockArm('used-end-footer', { limit: 8, header: OPENERS_HEADER_USED, footer: true }),
        blockArm('used-early-footer', { limit: 8, header: OPENERS_HEADER_USED, footer: true, at: 'facts' }),
      ],
    },
    // Run 3: structural renderings — can any presentation stop the verbatim copying?
    '3': {
      name: 'openers-run3-shape',
      limit: 8,
      arms: [
        { name: 'control' },
        blockArm('all-marked', { limit: 8, header: OPENERS_HEADER_ALLMARKED, markAll: true, footer: true }),
        blockArm('dated-quoted', { limit: 8, header: OPENERS_HEADER_DATED, dated: true, quote: true }),
        blockArm('cap-3', { limit: 3, header: OPENERS_HEADER_USED, footer: true }),
      ],
    },
    // Run 4 (decision run, 3 samples/cell): the run-3 winner shape — ✗ on every line — against
    // control, across prompt positions, plus the deleted-only marking.
    '4': {
      name: 'openers-run4-position',
      limit: 8,
      arms: [
        { name: 'control' },
        blockArm('allmark-end', { limit: 8, header: OPENERS_HEADER_ALLMARKED, markAll: true, footer: true }),
        blockArm('allmark-top', {
          limit: 8,
          header: OPENERS_HEADER_ALLMARKED,
          markAll: true,
          footer: true,
          at: 'top',
        }),
        blockArm('delmark-end', { limit: 8, header: OPENERS_HEADER_DELMARKED, mark: true, footer: true }),
      ],
    },
    // Run 5: cap sweep on the run-4 winner.
    '5': {
      name: 'openers-run5-cap',
      limit: 8,
      arms: [
        { name: 'control' },
        blockArm('allmark-4', { limit: 4, header: OPENERS_HEADER_ALLMARKED, markAll: true, footer: true }),
        blockArm('allmark-8', { limit: 8, header: OPENERS_HEADER_ALLMARKED, markAll: true, footer: true }),
        blockArm('allmark-14', { limit: 14, header: OPENERS_HEADER_ALLMARKED, markAll: true, footer: true }),
      ],
    },
    // Run 6: carry the same information with nothing copyable in it.
    '6': {
      name: 'openers-run6-derived',
      limit: 8,
      arms: [
        { name: 'control' },
        derivedArm('topics-8', 8, 'topics'),
        derivedArm('stems-8', 8, 'stems'),
        derivedArm('both-8', 8, 'both'),
      ],
    },
    // Run 7: same information, spliced into the tail cue instead of the system prompt.
    '7': {
      name: 'openers-run7-tail',
      limit: 8,
      arms: [{ name: 'control' }, tailArm('tail-full-8', 8, 'full'), tailArm('tail-topics-8', 8, 'topics')],
    },
    // Run 8: confirm the tail placement and sweep the cap.
    '8': {
      name: 'openers-run8-tailcap',
      limit: 8,
      arms: [
        { name: 'control' },
        tailArm('tail-4', 4, 'full'),
        tailArm('tail-8', 8, 'full'),
        tailArm('tail-14', 14, 'full'),
      ],
    },
    // Run 10: does flagging the operator-deleted ones help at the tail position?
    '10': {
      name: 'openers-run10-tailmark',
      limit: 8,
      arms: [{ name: 'control' }, tailArm('tail-8', 8, 'full'), tailArm('tail-8-marked', 8, 'marked')],
    },
    // Run 9: placebo — is the win the *list*, or just the extra "don't repeat yourself" clause?
    '9': {
      name: 'openers-run9-placebo',
      limit: 8,
      arms: [
        { name: 'control' },
        tailArm('tail-8', 8, 'full'),
        {
          name: 'rule-only',
          history: (h) => {
            const out = h.map((m) => ({ ...m }));
            const last = out[out.length - 1];
            last.content = last.content.replace(
              /\]\s*$/,
              ` You have opened a lot of conversations lately, so none of it can come back - not a topic you have already opened on, not a phrasing you have already used, not an opening you have already used.]`,
            );
            return out;
          },
        },
      ],
    },
  };

  // RUN=pool re-scores saved runs together, e.g. `RUN=pool POOL=openers-run7-tail,openers-run8-tailcap`.
  if (which === 'pool') {
    const files = (process.env.POOL ?? '').split(',').filter(Boolean);
    const merged: Sample[] = [];
    for (const f of files)
      for (const line of readFileSync(resolve(OUT_DIR, `${f}.jsonl`), 'utf8').split('\n').filter(Boolean))
        merged.push(JSON.parse(line) as Sample);
    // tail-full-8 (run 7) and tail-8 (run 8) are the same arm under two names.
    for (const s of merged) if (s.arm === 'tail-full-8') s.arm = 'tail-8';
    console.log('\n' + table(scoreRows(merged, pos, 8)) + '\n');
    return;
  }

  const plan = plans[which];
  if (!plan) throw new Error(`no RUN=${which}`);

  const samples = await run({
    name: plan.name,
    positions: pos,
    arms: plan.arms,
    samples: samplesPerCell,
    mode: 'proactive',
    outDir: OUT_DIR,
  });

  const rows = scoreRows(samples, pos, plan.limit);
  writeFileSync(resolve(OUT_DIR, `${plan.name}.md`), dump(plan.name, pos, samples, plan.arms, plan.limit), 'utf8');
  console.log('\n' + table(rows) + '\n');
}

void main();
