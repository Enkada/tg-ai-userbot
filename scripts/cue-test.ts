/**
 * A/B harness for prompt cues — replays *real* turns from a DB snapshot against the production
 * prompt-assembly path, swapping only the thing under test, and scores the output.
 *
 * The point is comparability: every experiment in this file's format produces the same metrics
 * over the same kind of positions, so two people testing two different cues can put their numbers
 * side by side. Nothing here talks to Telegram.
 *
 * **How a position is replayed.** To regenerate assistant message `#3357` as it was *first*
 * generated, every row with `id >= 3357` is temporarily flagged `deleted` in the scratch DB, so
 * `getWindow()` — the real one, with captions, search records and selfie acks — returns exactly the
 * window that existed at that moment. The flags are restored in a `finally`. This is why the DB
 * must be a **scratch copy**: the harness writes to it.
 *
 *   Snapshot:  scp root@<prod>:/home/enkada/tg-ai-userbot/data/userbot.db /tmp/scratch.db
 *              (plus -wal and -shm; better-sqlite3 replays the WAL on open)
 *   Run:       $env:DB_PATH='C:/tmp/scratch.db'; npx tsx scripts/my-experiment.ts
 *
 * **Two arms minimum.** Absolute rates measured here do NOT match live prod rates — a replayed
 * window contains her *curated* history (the operator kept the good replies), so the model is
 * primed better than it is live. Only the control-vs-variant delta is meaningful, and the control
 * arm must be re-measured in-harness rather than compared to numbers from the corpus analysis.
 *
 * **The model** is forced to OpenRouter (`openRouter.chat`) rather than `llm.ts:chat`, which would
 * prefer a local server if one happens to be running. Sampling params come from the env exactly as
 * production reads them — set them to match prod (`LLM_TEMPERATURE=1`, `LLM_TOP_P=0.95`,
 * `OPENROUTER_MODEL=deepseek/deepseek-v4-flash`) or the numbers describe a model nobody ships.
 */
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, eq, gte, inArray } from 'drizzle-orm';
import { config } from '../src/config.js';
import { db, runMigrations } from '../src/db/index.js';
import { messages, messageRevisions } from '../src/db/schema.js';
import { initPersona } from '../src/persona.js';
import { initSettings } from '../src/settings.js';
import { getSummaryState, getWindow } from '../src/memory.js';
import { renderSystemPrompt } from '../src/prompts/render.js';
import { withReplyCue } from '../src/generate.js';
import { lullReachoutCue } from '../src/prompts/index.js';
import { openRouter } from '../src/providers/openrouter.js';
import { sanitize } from '../src/sanitize.js';
import { finalizeReply } from '../src/tools.js';
import type { ChatMessage } from '../src/llm.js';

runMigrations();
initSettings();
initPersona();

export const chatId = [...config.whitelist][0];
export const userName = getSummaryState(chatId)?.userName ?? 'user';

// ---- Positions ------------------------------------------------------------------------------

/** One replayed turn: the assistant row to regenerate, plus everything needed to judge the output. */
export interface Position {
  /** messages.id of the assistant reply being regenerated. */
  targetId: number;
  /** His message that prompted it ('' for a proactive opener). */
  userMessage: string;
  /** What she actually said, post-operator-workflow — the accepted version. */
  accepted: string;
  /** The first generated version, when the turn was rerolled (message_revisions v1). Else null. */
  firstPass: string | null;
  /** Operator notes on this turn, joined. */
  note: string | null;
  proactive: boolean;
  /**
   * Epoch ms the original reply was generated. The prompt is rendered with this as "now", so
   * `{{day}}/{{date}}/{{period}}` match the historical moment — without it a replay of a 23:15
   * turn renders today's afternoon and any clock experiment measures nothing.
   */
  createdAt: number;
}

/** Builds {@link Position}s for the given assistant message ids, in id order. */
export function positions(ids: number[]): Position[] {
  const rows = db.select().from(messages).where(eq(messages.chatId, chatId)).orderBy(messages.id).all();
  const byIdx = new Map(rows.map((r, i) => [r.id, i]));
  const revs = db.select().from(messageRevisions).orderBy(messageRevisions.id).all();

  return ids
    .map((id) => {
      const i = byIdx.get(id);
      if (i === undefined) throw new Error(`no message #${id} in ${config.dbPath}`);
      const row = rows[i];
      if (row.role !== 'assistant') throw new Error(`#${id} is a ${row.role} message, not a reply`);
      // Nearest preceding user turn — '' when a proactive opener has none in front of it.
      let j = i - 1;
      while (j >= 0 && rows[j].role !== 'user') j--;
      const mine = revs.filter((r) => r.messageId === id);
      const notes = mine.map((r) => r.note).filter(Boolean).join(' || ');
      return {
        targetId: id,
        userMessage: j >= 0 && !row.proactive ? rows[j].content : '',
        accepted: row.content,
        firstPass: mine.find((r) => r.content)?.content ?? null,
        note: notes || null,
        proactive: Boolean(row.proactive),
        createdAt: row.createdAt,
      };
    })
    .sort((a, b) => a.targetId - b.targetId);
}

/** Assistant ids whose operator notes match `re` — the "known failures" set for a category. */
export function notedPositions(re: RegExp): number[] {
  const revs = db.select().from(messageRevisions).all();
  const ids = new Set<number>();
  for (const r of revs) if (r.note && re.test(r.note)) ids.add(r.messageId);
  const assistant = new Set(
    db.select({ id: messages.id }).from(messages).where(eq(messages.role, 'assistant')).all().map((r) => r.id),
  );
  return [...ids].filter((id) => assistant.has(id)).sort((a, b) => a - b);
}

/**
 * `count` assistant ids the operator left alone, newest-first from `newerThan` — the control set.
 * Untouched turns are the ones a change must not break; a cue that fixes flagged turns and wrecks
 * these is a regression, and without this set the harness can't see that.
 */
export function untouchedPositions(count: number, opts: { proactive?: boolean; newerThan?: number } = {}): number[] {
  const touched = new Set(db.select({ id: messageRevisions.messageId }).from(messageRevisions).all().map((r) => r.id));
  const rows = db
    .select()
    .from(messages)
    .where(and(eq(messages.chatId, chatId), eq(messages.role, 'assistant'), eq(messages.deleted, false)))
    .orderBy(messages.id)
    .all();
  return rows
    .filter((r) => !touched.has(r.id))
    .filter((r) => Boolean(r.proactive) === Boolean(opts.proactive))
    .filter((r) => r.id > (opts.newerThan ?? 0))
    .slice(-count)
    .map((r) => r.id);
}

/**
 * The `limit` proactive openers sent before `targetId`, oldest first — **including soft-deleted
 * ones**, which is the entire point: a deleted opener leaves the window, so today she has no way to
 * know she already asked that, and the same question comes back days later (observed twice).
 * Feed this to a "your recent openers" block.
 */
export function openersBefore(targetId: number, limit = 8): { id: number; content: string; deleted: boolean }[] {
  return db
    .select({ id: messages.id, content: messages.content, deleted: messages.deleted })
    .from(messages)
    .where(and(eq(messages.chatId, chatId), eq(messages.role, 'assistant'), eq(messages.proactive, true)))
    .orderBy(messages.id)
    .all()
    .filter((r) => r.id < targetId)
    .slice(-limit)
    .map((r) => ({ ...r, deleted: Boolean(r.deleted) }));
}

// ---- Replay ---------------------------------------------------------------------------------

/**
 * Runs `fn` with the DB rewound to just before `targetId`: every row at or after it is flagged
 * deleted so the production window builder sees the historical state. Restores exactly the rows it
 * flagged (rows already deleted stay deleted), even if `fn` throws.
 */
export async function atPosition<T>(targetId: number, fn: () => Promise<T>): Promise<T> {
  const hidden = db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.chatId, chatId), gte(messages.id, targetId), eq(messages.deleted, false)))
    .all()
    .map((r) => r.id);
  if (hidden.length) db.update(messages).set({ deleted: true }).where(inArray(messages.id, hidden)).run();
  try {
    return await fn();
  } finally {
    if (hidden.length) db.update(messages).set({ deleted: false }).where(inArray(messages.id, hidden)).run();
  }
}

// ---- Arms -----------------------------------------------------------------------------------

/**
 * One side of the comparison. Both hooks are optional; an arm with neither is the control (the
 * production prompt, unmodified). Mutate nothing — return new values.
 *
 * `system` receives the fully rendered system prompt (persona → appearance → technical → facts →
 * memory → tools → selfie). `history` receives the window with the production tail cue already
 * applied, so a cue experiment usually rewrites `history.at(-1).content`.
 */
export interface Arm {
  name: string;
  system?: (systemPrompt: string, pos: Position) => string;
  history?: (history: ChatMessage[], pos: Position) => ChatMessage[];
}

/** Convenience: an arm that replaces the whole bracketed tail cue on the last user turn. */
export function tailCueArm(name: string, cue: string): Arm {
  return {
    name,
    history: (h) => {
      const out = h.map((m) => ({ ...m }));
      const last = out[out.length - 1];
      // The production cue is appended to the last user turn after a blank line; strip it and
      // substitute, so the arm tests its own wording rather than stacking on top of the old one.
      last.content = `${last.content.replace(/\n*\[System note:[\s\S]*$/, '').trimEnd()}\n\n${cue}`;
      return out;
    },
  };
}

// ---- Running --------------------------------------------------------------------------------

export interface Sample {
  arm: string;
  targetId: number;
  /** 0-based index of this sample within its (arm, position) cell. */
  k: number;
  text: string;
  ms: number;
  error?: string;
}

export interface Experiment {
  /** Short slug — names the output files. */
  name: string;
  positions: Position[];
  arms: Arm[];
  /** Generations per (arm, position). 3 is usually enough to see a rate move; 5 for diversity work. */
  samples: number;
  /**
   * 'reactive' replays a normal reply (window + production tail cue). 'proactive' replays an
   * opener: memory block dropped, and `cue` appended as an ephemeral user turn, mirroring
   * proactive.ts:sendCued.
   */
  mode?: 'reactive' | 'proactive';
  /** The director cue for `mode: 'proactive'`. Defaults to the production lull cue. */
  cue?: (pos: Position) => string;
  /** Where to write results. Defaults to `docs/rejections/runs`. */
  outDir?: string;
}

/**
 * Runs every (arm × position × sample) cell, writing a JSONL line per generation as it goes so a
 * crashed or aborted run keeps its partial results. Returns every sample.
 *
 * Output passes through the production `sanitize` + `finalizeReply`, so what's scored is what the
 * user would have seen — tool calls stripped, protocol markers suppressed.
 */
export async function run(exp: Experiment): Promise<Sample[]> {
  const outDir = exp.outDir ?? resolve(process.cwd(), 'docs/rejections/runs');
  mkdirSync(outDir, { recursive: true });
  const jsonl = resolve(outDir, `${exp.name}.jsonl`);
  writeFileSync(jsonl, '');

  const mode = exp.mode ?? 'reactive';
  const out: Sample[] = [];
  const total = exp.arms.length * exp.positions.length * exp.samples;
  let done = 0;

  for (const pos of exp.positions) {
    await atPosition(pos.targetId, async () => {
      const baseSystem = renderSystemPrompt(
        { userName, chatId },
        { includeMemory: mode === 'reactive', now: new Date(pos.createdAt) },
      );
      const window = getWindow(chatId);
      const baseHistory =
        mode === 'proactive'
          ? [...window, { role: 'user' as const, content: exp.cue?.(pos) ?? defaultOpenerCue() }]
          : withReplyCue(window, userName, { now: new Date(pos.createdAt) });

      for (const arm of exp.arms) {
        const systemPrompt = arm.system ? arm.system(baseSystem, pos) : baseSystem;
        const history = arm.history ? arm.history(baseHistory, pos) : baseHistory;
        for (let k = 0; k < exp.samples; k++) {
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
          process.stdout.write(`\r${exp.name}: ${done}/${total}  `);
        }
      }
    });
  }
  process.stdout.write('\n');
  return out;
}

/**
 * Retries a generation on transient transport failures (`fetch failed`, 429, 5xx from a routed
 * upstream). Without this a dropped connection lands in the results as an empty sample and silently
 * biases whichever arm it hit — observed on the very first smoke run.
 */
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

/** The production first-reach-out cue, i.e. what an opener is generated against today. */
function defaultOpenerCue(): string {
  return lullReachoutCue(userName);
}

// ---- Metrics --------------------------------------------------------------------------------

/** Openers that acknowledge/agree before saying anything — the F2 failure, as a regex. */
export const AGREEMENT_OPENER =
  /^(exactly|true|fair|yeah|yep|yup|right|honestly|same|good call|makes sense|ha|nice|lmao|lol|guilty|damn|oof|okay|alright)\b/i;

/** Replies that answer the bracketed system note instead of the user — the F7 failure. */
export const CUE_LEAK = /keep (it|this) short|short and sweet|i'?ll be brief|1-3 sentences|system note|\[.*\]/i;

const STOP = new Set(
  `a an the and or but if then so of to in on at for with without is are was were be been being i you he she it we they me him her them my your his its our their that this these those not no yes just like about got get gonna have has had do does did dont im thats there here what when how why who all any some more most other than as from into out up down over under again too very can will would should could yeah`.split(
    /\s+/,
  ),
);

/** Content words of a text: >3 chars, stopwords removed, lowercased. */
export function contentWords(t: string): Set<string> {
  return new Set(
    t
      .toLowerCase()
      .replace(/[^\w\s']/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w)),
  );
}

/** Share of the reply's content words lifted from his message. Weak on its own — see F2. */
export function echoShare(reply: string, userMessage: string): number {
  const u = contentWords(userMessage);
  const r = contentWords(reply);
  if (!u.size || !r.size) return 0;
  let hit = 0;
  for (const w of r) if (u.has(w)) hit++;
  return hit / r.size;
}

/** Jaccard over content words — used for spree diversity (how alike are k samples?). */
export function similarity(a: string, b: string): number {
  const x = contentWords(a);
  const y = contentWords(b);
  let i = 0;
  for (const w of x) if (y.has(w)) i++;
  return i / (x.size + y.size - i || 1);
}

export function sentenceCount(t: string): number {
  return t.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim().length > 1).length;
}

export interface ArmScore {
  arm: string;
  n: number;
  agreementOpener: number;
  echo: number;
  sentences: number;
  cueLeak: number;
  question: number;
  /** Mean pairwise similarity between the k samples of one position — lower is more varied. */
  diversity: number;
}

/** Aggregates raw samples into one row per arm. `positions` supplies each turn's user message. */
export function score(samples: Sample[], pos: Position[]): ArmScore[] {
  const byTarget = new Map(pos.map((p) => [p.targetId, p]));
  const arms = [...new Set(samples.map((s) => s.arm))];
  return arms.map((arm) => {
    const mine = samples.filter((s) => s.arm === arm && !s.error && s.text.trim());
    const mean = (f: (s: Sample) => number) => mine.reduce((a, s) => a + f(s), 0) / (mine.length || 1);

    // Diversity: mean pairwise similarity within each (arm, position) cell, averaged over cells.
    const cells = new Map<number, string[]>();
    for (const s of mine) (cells.get(s.targetId) ?? cells.set(s.targetId, []).get(s.targetId)!).push(s.text);
    const cellSims: number[] = [];
    for (const texts of cells.values()) {
      if (texts.length < 2) continue;
      const ps: number[] = [];
      for (let i = 0; i < texts.length; i++)
        for (let j = i + 1; j < texts.length; j++) ps.push(similarity(texts[i], texts[j]));
      cellSims.push(ps.reduce((a, b) => a + b, 0) / ps.length);
    }

    return {
      arm,
      n: mine.length,
      agreementOpener: mean((s) => (AGREEMENT_OPENER.test(s.text.trim()) ? 1 : 0)),
      echo: mean((s) => echoShare(s.text, byTarget.get(s.targetId)?.userMessage ?? '')),
      sentences: mean((s) => sentenceCount(s.text)),
      cueLeak: mean((s) => (CUE_LEAK.test(s.text) ? 1 : 0)),
      question: mean((s) => (s.text.includes('?') ? 1 : 0)),
      diversity: cellSims.reduce((a, b) => a + b, 0) / (cellSims.length || 1),
    };
  });
}

/**
 * Writes the human-readable report: the metric table, then every position with its operator note,
 * the accepted reply, the original first pass, and each arm's samples — the form a reviewer (or a
 * judging subagent) needs to tell whether a metric move is real quality or a regex artifact.
 */
export function report(exp: Experiment, samples: Sample[]): string {
  const scores = score(samples, exp.positions);
  const pct = (x: number) => `${(100 * x).toFixed(0)}%`;
  const lines: string[] = [];

  lines.push(`# ${exp.name}`, '');
  lines.push(
    `${exp.positions.length} positions × ${exp.arms.length} arms × ${exp.samples} samples = ${samples.length} generations.`,
    `Model \`${config.llm.openrouter.model}\`, temp ${config.llm.temperature}, top_p ${config.llm.topP ?? '(provider default)'}.`,
    `Replayed windows carry curated history — **compare arms to each other, never to live prod rates.**`,
    '',
  );
  lines.push('| arm | n | agreement opener | echo | sentences | cue leak | question | sample similarity |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const s of scores)
    lines.push(
      `| ${s.arm} | ${s.n} | ${pct(s.agreementOpener)} | ${pct(s.echo)} | ${s.sentences.toFixed(2)} | ${pct(s.cueLeak)} | ${pct(s.question)} | ${pct(s.diversity)} |`,
    );
  lines.push('');

  for (const p of exp.positions) {
    lines.push('---', '', `## #${p.targetId}${p.proactive ? ' (proactive)' : ''}`, '');
    if (p.note) lines.push(`**Operator note:** ${p.note}`, '');
    if (p.userMessage) lines.push('```', `HIM: ${p.userMessage}`, '```', '');
    if (p.firstPass) lines.push('**Original first pass (rejected):**', '```', p.firstPass, '```', '');
    lines.push('**Accepted in prod:**', '```', p.accepted, '```', '');
    for (const arm of exp.arms) {
      lines.push(`**${arm.name}:**`, '```');
      for (const s of samples.filter((x) => x.arm === arm.name && x.targetId === p.targetId))
        lines.push(`${s.k + 1}. ${s.error ? `ERROR ${s.error}` : s.text.replace(/\n/g, ' ⏎ ')}`);
      lines.push('```', '');
    }
  }
  return lines.join('\n');
}

/** Runs an experiment and writes `<name>.md` + `<name>.jsonl`; returns the scores. */
export async function runAndReport(exp: Experiment): Promise<ArmScore[]> {
  const samples = await run(exp);
  const outDir = exp.outDir ?? resolve(process.cwd(), 'docs/rejections/runs');
  writeFileSync(resolve(outDir, `${exp.name}.md`), report(exp, samples), 'utf8');
  const scores = score(samples, exp.positions);
  console.table(scores.map((s) => ({ ...s, agreementOpener: `${(100 * s.agreementOpener).toFixed(0)}%` })));
  return scores;
}
