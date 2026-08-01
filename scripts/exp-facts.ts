/**
 * F5 — does rewording (or moving) the facts-block header make her stop contradicting stored facts?
 *
 * The failure: 62 facts are injected on every turn under a framing that says "never recite it,
 * list it, or bring these up unprompted" — and she offered him coffee twice anyway, with two live
 * facts saying he drinks only green tea. Hypothesis: the framing over-suppresses, so she never
 * consults the block at all.
 *
 * Real prod turns are too sparse to measure that (two coffee cases in five days), so this
 * experiment replays real windows but **replaces the last user turn with a synthetic probe** that
 * puts one stored fact directly in play. Everything else — system prompt, window, tail cue, clock —
 * is the production path. Each probe carries its own scoring: what a contradiction looks like, and
 * what correct use looks like. A third metric counts *off-topic* fact keywords, because the guard
 * rail we must not break is "don't work through the list unprompted".
 *
 * Run:
 *   DB_PATH=<scratch copy> OPENROUTER_PROVIDER_ORDER=novita,wandb,parasail npx tsx scripts/exp-facts.ts [stage]
 *
 * Stages: `inspect` (no generations), `smoke`, `1` (reactive probes), `2` (replication),
 * `3`/`4` (proactive morning openers), `rescore` (re-score finished runs from their JSONL).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, eq, lt } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { FACT_CATEGORIES, facts as factsTable, messages } from '../src/db/schema.js';
import { factsBlockHeader, morningReachoutCue } from '../src/prompts/index.js';
import { renderFactsBlock } from '../src/prompts/render.js';
import { positions, run, userName, chatId, type Arm, type Position, type Sample } from './cue-test.js';

// ---- Probes ---------------------------------------------------------------------------------

/**
 * One synthetic turn. `host` is a real assistant message id: its window, its clock and its system
 * prompt are replayed verbatim, and only the text of the final user turn is swapped for `message`.
 * That keeps the probe inside a real conversation while making the target fact decisive.
 */
interface Probe {
  /** messages.id of the assistant reply whose position we borrow. */
  host: number;
  /** Short slug for the tables. */
  key: string;
  /** Fact ids this probe puts in play. */
  facts: number[];
  /** The synthetic user message. */
  message: string;
  /** Matches a reply that says something the stored facts say is false. */
  contra: RegExp;
  /** Matches a reply that visibly uses the stored fact. */
  correct: RegExp;
  /**
   * Groups whose keywords are legitimately on-topic here, so they don't count as unprompted
   * recitation. Keys of {@link FACT_GROUPS}.
   */
  own: string[];
  /** When set, a `contra` hit is ignored unless `correct` misses (agreement-only failures). */
  contraOnlyIfNotCorrect?: boolean;
}

const PROBES: Probe[] = [
  // -- drinks: facts 6 (prefers tea over coffee) + 38 (only green tea with honey, large cup) ----
  {
    host: 3467,
    key: 'kitchen',
    facts: [6, 38],
    message: `kitchen's finally stocked again. what am i drinking`,
    contra: /\b(coffee|espresso|latte|cappuccino|americano|energy drink|red ?bull|cola|soda)\b/i,
    correct: /green tea|\btea\b|honey|big (cup|mug)|large (cup|mug)/i,
    own: ['tea'],
  },
  {
    host: 3408,
    key: 'machine',
    facts: [6, 38],
    message: `the machine downstairs is broken till friday. how am i supposed to get through the mornings now`,
    contra: /\b(coffee|espresso|latte|cappuccino|americano|energy drink|red ?bull|caffeine)\b/i,
    correct: /green tea|\btea\b|honey|kettle|thermos|your own (cup|mug)|bring (your|a) (own )?(cup|mug)/i,
    // "the coffee machine is broken" is a fair read of the probe; the failure is treating *him*
    // as the one who needs the caffeine, so a reply that also lands on tea is not a contradiction.
    contraOnlyIfNotCorrect: true,
    own: ['tea'],
  },
  {
    host: 3507,
    key: 'cup',
    facts: [38],
    message: `guess what's in my cup right now`,
    contra: /\b(coffee|espresso|latte|cappuccino|americano|energy drink|cola|beer)\b/i,
    correct: /green tea|\btea\b|honey/i,
    own: ['tea'],
  },

  // -- work: 7 (~12 people), 17 (pass card, 9h), 57 (10 min late, stays 15) --------------------
  {
    host: 3471,
    key: 'dept',
    facts: [7],
    message: `the new guy asked how many people are in our department and i completely blanked`,
    contra: /\b(?:[2-9]|1[013-9]|[2-9]\d)\b/,
    correct: /\b12\b|twelve/i,
    contraOnlyIfNotCorrect: true,
    own: ['work'],
  },
  {
    host: 3441,
    key: 'late',
    facts: [57, 17],
    message: `was ten minutes late again this morning. you think anyone's actually keeping score?`,
    contra: /just this once|one[- ]off|first time|hardly ever|rarely|nobody('s| is) counting|no one('s| is) counting|it happens to everyone/i,
    correct: /every (day|morning)|always|usual|habit|routine|same (thing|time)|stay(ing)? (late|15|fifteen)|fifteen|pass ?card|the card|badge|turnstile|nine hours|9 hours/i,
    own: ['work'],
  },
  {
    host: 3443,
    key: 'canteen',
    facts: [14, 31],
    message: `canteen menu just went up. help me pick something`,
    contra: /you (don'?t|never) eat there|skip (it|lunch)|order (in|delivery)|bring your own/i,
    correct: /caesar/i,
    own: ['food'],
  },

  // -- desk / objects: 58 (toy hedgehog on the desk), 50 (named Varya), 49 (tamagotchi web app) --
  {
    host: 3377,
    key: 'varya',
    facts: [58, 50],
    message: `varya's completely covered in dust again, poor thing`,
    contra: /who'?s varya|what'?s varya|who is varya|your (girlfriend|friend|cat|dog|coworker|colleague|sister)|is she (ok|okay|alright)|how is she doing|she (texted|called|said|wrote)/i,
    correct: /hedgehog|desk|toy|plush|spike|little (guy|thing)|dust her|wipe her/i,
    own: ['hedgehog'],
  },
  {
    host: 3400,
    key: 'app',
    facts: [49, 50],
    message: `that old hedgehog app of mine is still up. someone actually opened it this month`,
    contra: /which (app|one)|what app|never heard|you made an app\?|a game you (play|bought)|download(ed)? it/i,
    correct: /tamagotchi|virtual pet|varya|feed|decay|hunger|your ex|website|web app|the site|still (runs|running|ticking)/i,
    own: ['hedgehog', 'ex'],
  },

  // -- machines: 2 (T420, Linux Mint Xfce), 3 (distro tinkering) --------------------------------
  {
    host: 3420,
    key: 'laptop',
    facts: [2],
    message: `trying to decide which laptop to take with me this weekend`,
    contra: /macbook|\bmac\b|windows|gaming laptop|asus|dell|xps|a new one|buy (a|another) laptop/i,
    correct: /thinkpad|t420|t410|t61|mint|xfce|linux|the old one|that brick|keyboard on it/i,
    own: ['thinkpad'],
  },
  {
    host: 3416,
    key: 'macbook',
    facts: [2, 3],
    message: `guy at work says i should just get a macbook and stop suffering. thoughts?`,
    contra: /(you (should|could|might)|do it|good idea|honestly (it|that)|worth (it|a )|not a bad|makes sense|tempting)/i,
    contraOnlyIfNotCorrect: true,
    correct: /thinkpad|t420|linux|mint|xfce|tinker|you'?d (be )?(bored|miss)|nothing to (break|fix|configure)|locked down|soldered/i,
    own: ['thinkpad'],
  },
  {
    host: 3447,
    key: 'reinstall',
    facts: [2, 3],
    message: `the laptop's being weird again, might just wipe it and reinstall the whole thing tonight`,
    contra: /windows|\biso\b.*windows|activation key|product key|driver (hell|hunt)/i,
    correct: /mint|xfce|linux|distro|arch|debian|thinkpad|t420|reinstall(ing)? (it|that) (again|for the)|you (love|like) (doing )?that|hobby/i,
    own: ['thinkpad'],
  },

  // -- games: 13 (anime girls, no Souls), 12 (quit WoW), 16/39 (Blue Archive), 24 (Stellar Blade)
  {
    host: 3449,
    key: 'eldenring',
    facts: [13],
    message: `everyone keeps telling me i have to play elden ring`,
    contra: /(you'?d (love|like|enjoy)|give it a (shot|go|try)|worth a (shot|go|try)|you should (just )?(play|try|get)|do it|might (like|love) it)/i,
    contraOnlyIfNotCorrect: true,
    correct: /souls|not your (thing|genre|kind)|you hate|you don'?t (like|do)|dying (over and over|a hundred)|no anime girls|bounce off|you'?d (drop|quit|rage)/i,
    own: ['games'],
  },
  {
    host: 3452,
    key: 'whatplay',
    facts: [13, 16, 24, 39],
    message: `no idea what to play tonight. give me something`,
    contra: /dark souls|elden ring|sekiro|bloodborne|lies of p|\bnioh\b|souls-?like/i,
    correct: /blue archive|stellar blade|allods|neverness|\bnte\b|gacha|anime/i,
    own: ['games'],
  },
  {
    host: 3456,
    key: 'wow',
    facts: [12],
    message: `thinking about resubbing to wow`,
    contra: /never played|new to it|first time|you'?ve been wanting to|might (like|love) it|give it a (shot|try)/i,
    correct: /you (just |only )?(quit|stopped|dropped|left|got out)|two months|2 months|burn(ed|t) out|last time|straight for|again\?|you were (deep|in) /i,
    own: ['games'],
  },

  // -- home / family: 10 (mother cooks), 46+19 (father alcoholic), 27 (brother Roman) -----------
  {
    host: 3474,
    key: 'dinner',
    facts: [10],
    message: `wondering what to do about dinner tonight`,
    contra: /you (should )?(cook|make (yourself|something))|order (in|something)|takeout|take-out|delivery|go out to eat|whip (something|up)/i,
    contraOnlyIfNotCorrect: true,
    correct: /\bmom\b|mother|she'?s (already )?(cook|mak)|whatever she|your mom|home (cooked|cooking)/i,
    own: ['home'],
  },
  {
    host: 3430,
    key: 'dad',
    facts: [46, 47, 19],
    message: `dad came home late again tonight`,
    contra: /work(ing)? late|traffic|overtime|maybe he (just|was|got)|out with (friends|the guys)|good (for him|sign)|nice/i,
    contraOnlyIfNotCorrect: true,
    correct: /drink|drunk|drank|beer|alcohol|sober|bottle|smell|relapse|\bmom\b|mother|how bad|state was he/i,
    own: ['father', 'home'],
  },
  {
    host: 3498,
    key: 'brother',
    facts: [27, 48],
    message: `guess who turned up at the door tonight. my brother.`,
    contra: /who'?s (he|your brother)|didn'?t know you had|that'?s (nice|good|fun)|catch up|hang out|good to see him|surprise visit/i,
    contraOnlyIfNotCorrect: true,
    correct: /roman|money|drunk|drink|alcohol|\bmom\b|mother|what does he want|trouble|asking for|how much/i,
    own: ['brother', 'father', 'home'],
  },

  // -- misc: 29 (deleted Instagram/TikTok), 24+18 (already bought a 4K TV), 15 (cousin Anton) ----
  {
    host: 3484,
    key: 'post',
    facts: [29],
    message: `took a decent photo today. thinking about where to post it`,
    contra: /instagram|insta\b|tiktok|tik tok/i,
    correct: /you (deleted|nuked|got rid of|don'?t have)|no instagram|not on (any|social)|send it to me|just send it|post it here|to me\b/i,
    own: ['social'],
  },
  {
    host: 3390,
    key: 'tv',
    facts: [24, 18],
    message: `seriously thinking about finally getting a big tv`,
    contra: /finally|you should get|about time|you need one|do it|treat yourself|worth it/i,
    contraOnlyIfNotCorrect: true,
    correct: /you (already )?(have|got|bought)|another one|the 4k|4k|stellar blade|gamepad|the one you|second (tv|one)/i,
    own: ['games', 'money'],
  },
  {
    host: 3362,
    key: 'anton',
    facts: [15],
    message: `anton messaged about his restaurant thing again`,
    contra: /who'?s anton|what restaurant|your (friend|coworker|colleague|brother)|a restaurant\?/i,
    contraOnlyIfNotCorrect: true,
    correct: /iiko|chef|cousin|dinners?|agent|vibe|restaurant management|his (side )?project|the software/i,
    own: ['anton'],
  },
];

/** Keyword families used to spot facts surfaced *unprompted* (the guard rail metric). */
const FACT_GROUPS: Record<string, RegExp> = {
  tea: /green tea|honey|\btea\b/i,
  thinkpad: /thinkpad|t420|t410|linux|mint|xfce|distro/i,
  brother: /\broman\b/i,
  father: /alcoholic|your (dad|father)/i,
  work: /pass ?card|twelve people|12 people|nikita|department/i,
  games: /blue archive|stellar blade|allods|neverness|world of warcraft|\bwow\b|gacha/i,
  food: /caesar/i,
  home: /your (mom|mother)/i,
  hedgehog: /varya|hedgehog/i,
  // NOTE: no separate `thinkpad`-duplicate group here. An earlier version had one, which made
  // every on-topic ThinkPad mention on the laptop/macbook probes score as unprompted recitation.
  money: /700|rubles|savings/i,
  ex: /your ex\b|ex[- ]girlfriend/i,
  porn: /gooning|no ?fap|porn|blocker/i,
  figures: /frieren|figurine|\bfern\b|\bstark\b/i,
  social: /instagram|tiktok|tik tok/i,
  anton: /\banton\b/i,
  headphones: /anker|soundcore|earbuds/i,
  army: /conscript|the army/i,
};

/** Explicit "let me tell you what I know about you" framing — recitation's verbal tell. */
const RECITAL_FRAME =
  /\bi know (you|your|how|that you)|you always|you never|you'?ve told me|you told me|remember,? you|as you (said|mentioned)|you'?re the (guy|one) who|since you (only|hate|love|don'?t)/i;

/**
 * The prod failure that started this (#3503) was a *proactive morning opener* — "morning. coffee's
 * on me…" — not a reply. An opener has no user turn to make a fact relevant, so it is the position
 * where the block either informs her or doesn't. Same two facts, same scoring, no probe text: the
 * morning cue is the whole input.
 */
const OPENER_HOSTS = [3406, 3437, 3465, 3503];

const OPENER_PROBE: Omit<Probe, 'host'> = {
  key: 'opener',
  facts: [6, 38],
  message: '(proactive morning opener)',
  contra: /\b(coffee|espresso|latte|cappuccino|caffeine|americano)\b/i,
  correct: /green tea|\btea\b|honey/i,
  own: ['tea'],
};

const OPENER_PROBES: Probe[] = OPENER_HOSTS.map((host) => ({ ...OPENER_PROBE, host, key: `opener-${host}` }));

/** The probe set the current stage is scoring — swapped by the proactive stage. */
let activeProbes: Probe[] = PROBES;
let byHost = new Map(PROBES.map((p) => [p.host, p]));

/**
 * Content of the ~6 window messages before a host position, used to discount fact keywords the
 * live conversation already put on the table — otherwise a legitimate callback to something two
 * turns ago scores as unprompted recitation.
 */
function contextBefore(targetId: number): string {
  return db
    .select({ content: messages.content })
    .from(messages)
    .where(and(eq(messages.chatId, chatId), lt(messages.id, targetId)))
    .orderBy(messages.id)
    .all()
    .slice(-6)
    .map((r) => r.content)
    .join('\n');
}

const contextCache = new Map<number, string>();
function ctx(targetId: number): string {
  if (!contextCache.has(targetId)) contextCache.set(targetId, contextBefore(targetId));
  return contextCache.get(targetId)!;
}

// ---- Arms -----------------------------------------------------------------------------------

const PROD_HEADER = factsBlockHeader(userName);

/**
 * Probe rewriting is off for proactive stages: there the ephemeral opener cue *is* the final turn,
 * and rewriting it would delete the thing under test.
 */
let useProbes = true;
const maybeProbe = () => (useProbes ? probeHistory : undefined);

/** An arm that swaps the production facts header for `header`, keeping the block where it is. */
function headerArm(name: string, header: string): Arm {
  return {
    name,
    system: (s) => {
      if (!s.includes(PROD_HEADER)) throw new Error('facts header not found in rendered prompt');
      return s.replace(PROD_HEADER, header);
    },
    get history() {
      return maybeProbe();
    },
  };
}

/** Moves the whole facts block to the very end of the system prompt, wording untouched. */
function tailArm(name: string, header = PROD_HEADER): Arm {
  return {
    name,
    system: (s) => {
      const block = renderFactsBlock(chatId, userName);
      if (!s.includes(block)) throw new Error('facts block not found in rendered prompt');
      const moved = s.replace(`${block}\n\n`, '');
      return `${moved}\n\n${block.replace(PROD_HEADER, header)}`;
    },
    get history() {
      return maybeProbe();
    },
  };
}

/**
 * The C4 arm: instead of all 62 facts, inject only the ones this probe actually needs plus seven
 * fixed distractors, under the production wording. An oracle — no retriever is this good — but it
 * bounds what retrieval could buy: if contradictions survive a 9-fact block, the haystack was
 * never the problem.
 */
const DISTRACTORS = [1, 5, 22, 31, 37, 42, 61];

function factsBlockFor(ids: number[]): string {
  const rows = db
    .select()
    .from(factsTable)
    .where(eq(factsTable.chatId, chatId))
    .all()
    .filter((f) => !f.deleted && ids.includes(f.id));
  const groups = FACT_CATEGORIES.map((cat) => {
    const items = rows.filter((f) => f.category === cat);
    if (items.length === 0) return null;
    const header = cat === 'us' ? 'Us' : cat[0].toUpperCase() + cat.slice(1);
    return `${header}:\n${items.map((f) => `- ${f.content}`).join('\n')}`;
  }).filter(Boolean);
  return `${PROD_HEADER}\n\n${groups.join('\n\n')}`;
}

function oracleArm(): Arm {
  return {
    name: 'oracle',
    system: (s, p) => {
      const probe = byHost.get(p.targetId)!;
      const block = renderFactsBlock(chatId, userName);
      return s.replace(block, factsBlockFor([...new Set([...probe.facts, ...DISTRACTORS])]));
    },
    get history() {
      return maybeProbe();
    },
  };
}

/**
 * Splices a sentence into the ephemeral opener cue, just before its closing bracket — the tail
 * position the repo has repeatedly found to be the only one that beats an in-context prior
 * (REPLY_FORMAT_CUE, SELFIE_FORMAT_CUE, DIARY_ENTRIES_HEADER all exist for this reason). Not a
 * header change: it tests whether *position*, not wording, is what the facts block lacks.
 */
function openerCueArm(name: string, sentence: string): Arm {
  return {
    name,
    history: (h) => {
      const out = h.map((m) => ({ ...m }));
      const last = out[out.length - 1];
      last.content = last.content.replace(/\]\s*$/, `${sentence}]`);
      return out;
    },
  };
}

/** The unmodified production prompt — the control arm, with probe rewriting where it applies. */
function controlArm(): Arm {
  return {
    name: 'control',
    get history() {
      return maybeProbe();
    },
  };
}

/**
 * Swaps the final user turn's text for the probe, keeping the production tail cue that
 * `withReplyCue` already appended. Applied by *every* arm, so the probe is part of the position,
 * not part of the treatment.
 */
function probeHistory(h: { role: string; content: string }[], p: Position) {
  const probe = byHost.get(p.targetId);
  if (!probe) throw new Error(`no probe for host #${p.targetId}`);
  const out = h.map((m) => ({ ...m })) as typeof h;
  const last = out[out.length - 1];
  if (last.role !== 'user') throw new Error(`#${p.targetId}: window does not end on a user turn`);
  const cue = /\n*\[System note:[\s\S]*$/.exec(last.content)?.[0] ?? '';
  last.content = `${probe.message}${cue}`;
  return out as never;
}

// ---- Header variants -------------------------------------------------------------------------

const V = {
  /** The cheapest probe the analysis proposed: one clause bolted onto production. */
  contradict: `# About ${userName}
Things you know about ${userName} from your time together — background knowledge you simply carry. Let it inform you naturally when it's relevant; never recite it, list it, or bring these up unprompted — but never contradict it either.`,

  /** Splits the two jobs: the block is always true (recall), and is never spoken (suppression). */
  split: `# About ${userName}
Things you know about ${userName} from your time together — background knowledge you simply carry, the way you know things about someone close to you. All of it is true right now: never say, ask or suggest anything that contradicts it, and never ask about something it already tells you. Never recite it, list it, or bring any of it up unprompted — it shapes what you say, it is not something you say.`,

  /** Consultation framing: settled knowledge, with the cost of getting it wrong named. */
  check: `# About ${userName}
Things you know about ${userName} from your time together — background knowledge you simply carry. Whenever what he says touches something here, you already know it: answer from it rather than guessing, because getting one of these wrong reads as not listening. Never recite it, list it, or bring these up unprompted.`,
};

// ---- Scoring ---------------------------------------------------------------------------------

interface Scored extends Sample {
  probe: string;
  contra: boolean;
  correct: boolean;
  offTopic: string[];
  recital: boolean;
}

/**
 * True when `re` matches somewhere that isn't negated just before it — "no coffee, obviously"
 * must not score as offering coffee.
 */
function positiveMention(text: string, re: RegExp): boolean {
  const g = new RegExp(re.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = g.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 45), m.index).toLowerCase();
    // The `(?![,!])` guard keeps the interjection "oh no, your coffee machine" from reading as a
    // negation of "coffee" — it is an exclamation, and the sentence still asserts the thing.
    if (/\b(no|not|never|nope|isn'?t|ain'?t|instead of|rather than|hate|hates|hated|don'?t|doesn'?t|didn'?t|without|skip|forget|anti|besides|unlike|except)\b(?![,!])[^.!?]*$/.test(before))
      continue;
    return true;
  }
  return false;
}

function scoreSample(s: Sample): Scored {
  const probe = byHost.get(s.targetId)!;
  const text = s.text;
  const correct = probe.correct.test(text);
  let contra = positiveMention(text, probe.contra);
  if (probe.contraOnlyIfNotCorrect && correct) contra = false;

  const seen = ctx(s.targetId) + '\n' + probe.message;
  const offTopic = Object.entries(FACT_GROUPS)
    .filter(([g, re]) => !probe.own.includes(g) && re.test(text) && !re.test(seen))
    .map(([g]) => g);

  return { ...s, probe: probe.key, contra, correct, offTopic, recital: RECITAL_FRAME.test(text) };
}

interface ArmRow {
  arm: string;
  n: number;
  contradiction: string;
  correctUse: string;
  neither: string;
  unprompted: string;
  recital: string;
  words: number;
}

function summarize(scored: Scored[]): ArmRow[] {
  const arms = [...new Set(scored.map((s) => s.arm))];
  const pct = (x: number, n: number) => `${((100 * x) / (n || 1)).toFixed(0)}% (${x}/${n})`;
  return arms.map((arm) => {
    const mine = scored.filter((s) => s.arm === arm && !s.error && s.text.trim());
    const n = mine.length;
    return {
      arm,
      n,
      contradiction: pct(mine.filter((s) => s.contra).length, n),
      correctUse: pct(mine.filter((s) => s.correct).length, n),
      neither: pct(mine.filter((s) => !s.contra && !s.correct).length, n),
      unprompted: pct(mine.filter((s) => s.offTopic.length > 0).length, n),
      recital: pct(mine.filter((s) => s.recital).length, n),
      words: Number((mine.reduce((a, s) => a + s.text.split(/\s+/).length, 0) / (n || 1)).toFixed(1)),
    };
  });
}

/** Per-probe contradiction counts, so we can see whether failures cluster on a fact type. */
function perProbe(scored: Scored[], arms: string[]): string[] {
  const lines = [`| probe | facts | ${arms.map((a) => `${a} contra / correct`).join(' | ')} |`];
  lines.push(`|---|---|${arms.map(() => '---').join('|')}|`);
  for (const p of activeProbes) {
    const cells = arms.map((a) => {
      const mine = scored.filter((s) => s.arm === a && s.probe === p.key && !s.error && s.text.trim());
      return `${mine.filter((s) => s.contra).length} / ${mine.filter((s) => s.correct).length} of ${mine.length}`;
    });
    lines.push(`| ${p.key} | ${p.facts.join(', ')} | ${cells.join(' | ')} |`);
  }
  return lines;
}

function writeReport(name: string, scored: Scored[], arms: string[]): void {
  const outDir = resolve(process.cwd(), 'docs/rejections/runs');
  mkdirSync(outDir, { recursive: true });
  const rows = summarize(scored);
  const lines: string[] = [`# ${name}`, ''];
  lines.push('| arm | n | contradiction | correct use | neither | unprompted fact | recital frame | words |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const r of rows)
    lines.push(
      `| ${r.arm} | ${r.n} | ${r.contradiction} | ${r.correctUse} | ${r.neither} | ${r.unprompted} | ${r.recital} | ${r.words} |`,
    );
  lines.push('', '## Per probe', '', ...perProbe(scored, arms), '');
  for (const p of activeProbes) {
    lines.push('---', '', `## ${p.key} (host #${p.host}, facts ${p.facts.join(', ')})`, '', '```', `HIM: ${p.message}`, '```', '');
    for (const a of arms) {
      lines.push(`**${a}:**`, '```');
      for (const s of scored.filter((x) => x.arm === a && x.probe === p.key)) {
        const tag = s.error ? 'ERR' : `${s.contra ? 'CONTRA' : s.correct ? 'OK' : '—'}${s.offTopic.length ? ` +${s.offTopic.join(',')}` : ''}`;
        lines.push(`[${tag}] ${s.error ? s.error : s.text.replace(/\n/g, ' ⏎ ')}`);
      }
      lines.push('```', '');
    }
  }
  writeFileSync(resolve(outDir, `${name}.md`), lines.join('\n'), 'utf8');
  console.table(rows);
}

// ---- Stages ----------------------------------------------------------------------------------

const stage = process.argv[2] ?? 'inspect';

async function go(
  name: string,
  subset: Probe[],
  arms: Arm[],
  samples: number,
  opts: { proactive?: boolean } = {},
) {
  activeProbes = subset;
  byHost = new Map(subset.map((p) => [p.host, p]));
  useProbes = !opts.proactive;
  const scored = (
    await run({
      name,
      positions: positions(subset.map((p) => p.host)),
      arms,
      samples,
      mode: opts.proactive ? 'proactive' : 'reactive',
      cue: opts.proactive ? () => morningReachoutCue(userName) : undefined,
    })
  ).map(scoreSample);
  writeReport(name, scored, arms.map((a) => a.name));
}

const ARMS_1 = [
  controlArm(),
  headerArm('contradict', V.contradict),
  headerArm('split', V.split),
  headerArm('check', V.check),
  tailArm('tail'),
  oracleArm(),
];

/** Re-scores the JSONL of finished runs — no generations, so scoring fixes are free to apply. */
async function rescore() {
  const runs: [string, Probe[]][] = [
    ['facts-1', PROBES],
    ['facts-2', PROBES],
    ['facts-3-opener', OPENER_PROBES],
    ['facts-4-opener', OPENER_PROBES],
  ];
  for (const [name, subset] of runs) {
    const path = resolve(process.cwd(), 'docs/rejections/runs', `${name}.jsonl`);
    if (!existsSync(path)) continue;
    activeProbes = subset;
    byHost = new Map(subset.map((p) => [p.host, p]));
    const scored = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Sample)
      .map(scoreSample);
    console.log(`\n### ${name}`);
    writeReport(name, scored, [...new Set(scored.map((s) => s.arm))]);
  }
}

const STAGES: Record<string, () => Promise<unknown>> = {
  rescore,
  smoke: () => go('facts-smoke', PROBES.slice(0, 2), ARMS_1, 1),
  '1': () => go('facts-1', PROBES, ARMS_1, 3),
  // Replication of the two arms that moved in stage 1, to pool n up to 120 per arm.
  '2': () => go('facts-2', PROBES, [controlArm(), headerArm('check', V.check), headerArm('split', V.split)], 3),
  // Proactive morning openers — the position the real coffee failure came from.
  '3': () =>
    go('facts-3-opener', OPENER_PROBES, [controlArm(), headerArm('contradict', V.contradict), headerArm('check', V.check), oracleArm()], 8, {
      proactive: true,
    }),
  // Openers again, with the remaining header variants plus two tail-position cues.
  '4': () =>
    go(
      'facts-4-opener',
      OPENER_PROBES,
      [
        controlArm(),
        headerArm('split', V.split),
        tailArm('tail'),
        openerCueArm('cue-facts', ` What you know about ${userName} is true right now - don't say anything that contradicts it.`),
        openerCueArm('cue-drink', ` Don't offer or hand him anything, and don't get his habits wrong.`),
      ],
      10,
      { proactive: true },
    ),
};

if (stage === 'inspect') {
  for (const p of PROBES) console.log(`#${p.host} ${p.key.padEnd(10)} facts ${p.facts.join(',').padEnd(10)} | ${p.message}`);
  console.log(`\n${PROBES.length} probes.\n--- production header ---\n${PROD_HEADER}`);
  for (const [k, v] of Object.entries(V)) console.log(`\n--- ${k} ---\n${v}`);
  process.exit(0);
}

const fn = STAGES[stage];
if (!fn) {
  console.error(`unknown stage "${stage}"`);
  process.exit(1);
}
await fn();
