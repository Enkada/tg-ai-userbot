/**
 * Verbal-tic control. Three seams, one catalog (.scratch/analysis-2026-10/tic_catalog.md, mined
 * from all 2,355 of her replies on 2026-10-03):
 *
 * 1. **Window laundering** ({@link scrubTics}) — her *past* turns are cleaned before they re-enter
 *    the prompt. Contagion is the engine of every tic measured: a tic in her last few replies makes
 *    the next one 1.9× (" - ", ", huh") to 5.5× (hearts) likelier, and in-chat bans faded within
 *    50-200 replies because the window kept re-teaching them. Removing the examples breaks the loop
 *    without touching the DB or the chat — the same model-input-only seam as stripModelBrackets.
 * 2. **Outgoing guard** ({@link stripHardTics}) — the few tics he explicitly complained about that
 *    can be removed *locally* (no sentence dropping), so a per-bubble pass on send and a whole-text
 *    pass on save always agree and the stored row matches the chat.
 * 3. **Avoid-list** ({@link avoidListClause}) — a tail-cue line naming what she has been leaning on
 *    lately, computed from her raw stored replies. Same instrument as the recent-openers list,
 *    which took "hey" openers 37% → 5%. Retrospectively, a listed item shows up in her very next
 *    reply 11.9% of the time vs 2.3% for unlisted ones — the list names exactly what's about to recur.
 */

// ---- shared text helpers ----------------------------------------------------------------------

const TOKEN = /[a-z0-9]+(?:'[a-z]+)?/g;
const tokens = (s: string): string[] => s.toLowerCase().match(TOKEN) ?? [];

const STOPWORDS = new Set(
  `i me my mine you your yours you're i'm it it's its the a an and or but so to of in on at for with is are was were be been being
that that's this these those just not do don't did does doing have has had what if then like he his him she her they them we us our
as about up out no yes yeah oh all can can't get got go some one any there here when how why who will would could should
i'll i'd you'd you'll you've i've gonna wanna by from too very really now than more much even still also only well
am isn't aren't wasn't didn't doesn't won't haven't hasn't there's what's let's into over off back`.split(/\s+/),
);
const DIGIT_WORDS: Record<string, string> = { '1': 'one', '2': 'two', '3': 'three', '4': 'four', '5': 'five', '6': 'six', '7': 'seven' };

function stem(word: string): string {
  let w = DIGIT_WORDS[word] ?? word;
  w = w.replace(/'s$|'re$|'ve$|'ll$|'d$/, '');
  for (const suf of ['ing', 'ed', 'es', 's', 'ly']) {
    if (w.length > 4 && w.endsWith(suf)) return w.slice(0, -suf.length);
  }
  return w;
}
const contentWords = (s: string): string[] => tokens(s).filter((t) => !STOPWORDS.has(t) && t.length > 2).map(stem);

/** Re-glues punctuation after a removal: no doubled spaces, no " ,", no ".,", no leading comma. */
function tidy(s: string): string {
  return s
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.?!])/g, '$1')
    .replace(/([.?!]),/g, '$1')
    .replace(/,[ \t]*([.?!])/g, '$1')
    .replace(/^[\s,.\-]+/, '')
    .trim();
}

// ---- 1. window laundering ---------------------------------------------------------------------

/**
 * Her #1 tic: opening with his own words handed back — `"fap material" - …`, `two days left, huh.`,
 * `vibe coding a sidescroller?` (24.6% of recent replies, up from 6.7% in July). The fragment is
 * only cut when it really is his: ≤ 8 content words, ≥ 60% of them in his previous turn, and not a
 * reciprocal greeting ("morning." / "love you too.").
 */
const ECHO_OPENER = /^(?:"[^"\n]{1,60}"|[^.?!,"\n]{1,50}?)(?:,\s*huh)?\s*(?:[.?!]+\s+|[ \t]-[ \t])(?=\S)/i;
const RECIPROCAL = /^\W*(?:good ?morning|morning|mornin|good ?night|night|hey|hi|yo|sup|(?:for the record:? )?(?:i )?(?:love|miss) you(?: too)?|thanks?|thank you|sorry|same|goodnight)\b/i;

function isEcho(fragment: string, prevUser: string): boolean {
  if (RECIPROCAL.test(fragment)) return false;
  // He asked something: a short opener built from his words is her *answer* ("what's missing?"
  // → "long-term memory is the big one."), not an echo. Cutting it would rewrite history so she
  // never answered.
  if (/\?\s*$/.test(prevUser.trim())) return false;
  const frag = contentWords(fragment);
  if (frag.length < 1 || frag.length > 8) return false;
  const his = new Set(contentWords(prevUser));
  return frag.filter((w) => his.has(w)).length / frag.length >= 0.6;
}

/** Ordered rewrite steps; each must leave ≥ 2 words or it's skipped. Tested over her last 300. */
const SCRUB_STEPS: ReadonlyArray<readonly [RegExp, string]> = [
  // A leading "<restatement>, huh." sentence goes whole — the tag marks it as an echo.
  [/^[^.?!\n]{1,70},\s*huh\s*[.?!]*\s+(?=\S)/i, ''],
  [/,\s*huh\b/gi, ''],
  [/(^|[.?!]\s+)(?:yeah,?\s+|okay,?\s+|ok,?\s+|you know what,?\s+)?fair(?: enough| point)?(?:,\s*honestly)?\s*[.,!]\s*/gim, '$1'],
  [/,\s*fair enough(?=[.?!]|$)/gim, ''],
  [/(^|[.?!]\s+)(?:yeah,?\s+)?exactly[.,!]?\s+/gim, '$1'],
  // "and honestly, the fact" → "and the fact": a following comma goes with the word.
  [/\bactually,\s+|\bactually\s+(?=[a-z0-9"*])|,?\s+actually(?=[.!]|$)/gim, ''],
  [/\bhonestly,\s+|\bhonestly\s+(?=[a-z0-9"*])|,?\s+honestly(?=[.!]|$)/gim, ''],
  // "X or just Y?" → "X?" — keeps the real question, drops the sneer tail.
  [/(?<![.?!]),?\s+or (?:are you |did you |you |were you |is it |you're )?just\b[^.?!\n]*\?/gi, '?'],
  // Short standalone reassurance ("i'm still here.", "not going anywhere") — he asked her to stop.
  [/(^|[.?!]\s+)(?:but |and |well,? |yeah,? |either way,? |anyway,? )?(?:i'm (?:still |always |right )?here|i'll (?:always |still )?be (?:right )?here|i'm not going anywhere)(?! for| to)[^.?!\n]{0,30}(?:[.?!]+(?=\s|$)|$)/gim, '$1'],
  [/\s*(?:❤️|❤|💋|🥰|😘|💕|💖|🖤|♥️|♥)/gu, ''],
];

/**
 * Absence reproach, a whole sentence at a time. On return-after-silence turns she guilted him in
 * every replay arm — with no gap clause and no memory too — because her own Sep 8-16 replies
 * ("remember i exist", "left me in a drawer for five days") were the examples in front of her.
 * Phrased to hit things said *to him* ("you ghosted me"), not "my guitar is collecting dust".
 * Lookbehind, not a captured lead-in, so back-to-back reproach sentences all match.
 */
const REPROACH =
  /(?<=^|[.?!]\s+)[^.?!\n]*\b(?:remember(?:ed|s)? (?:that )?i (?:still )?exist(?:ed)?|forgot (?:that )?i exist(?:ed)?|forg[eo]t (?:about )?me\b|you(?:'ve)? (?:\w+ )?ghost(?:ed|ing)? me|ghosting me|(?:i'?ve been|i was|i'?m|been|just|sat here|sitting here)[^.?!\n]{0,20}collect(?:ing|ed)? (?:digital )?dust|waiting for you to (?:remember|show|come back|text)|left me (?:here|sitting|alone|in a drawer|on read)|abandon(?:ed|ing)? me|grace me with your presence|deign(?:ed|ing)? to)\b[^.?!\n]*(?:[.?!]+|$)/gim;

/**
 * The " - " aside drifted 4% → 37% of replies; a comma reads the same and stops the cadence.
 * Between letters/quotes only and on one line — never "5 - 3", never a "- item" list line — and
 * skipped entirely when the reply holds a code block.
 */
const DASH_ASIDE = /(?<=[a-z'")\]])[ \t]+-[ \t]+(?=[a-z'"(])/gi;

/**
 * Cleans one of her past replies for the prompt window. `prevUser` is his message right before it
 * (empty for a proactive opener). Model input only — the DB and the chat keep the original.
 * Returns '' for a reply that was nothing but absence reproach; the window builder drops it.
 */
export function scrubTics(text: string, prevUser = ''): string {
  // Reproach first, and it alone may empty the reply: a turn that is nothing but guilt has no
  // clean version, and leaving it in is exactly how the guilt kept teaching itself.
  REPROACH.lastIndex = 0;
  let out = text.replace(REPROACH, '');
  if (out !== text) {
    out = tidy(out);
    if (tokens(out).length === 0) return '';
  }
  const m = prevUser ? ECHO_OPENER.exec(out) : null;
  if (m && isEcho(m[0], prevUser)) {
    const rest = out.slice(m[0].length);
    if (tokens(rest).length >= 3) out = rest;
  }
  for (const [re, rep] of SCRUB_STEPS) {
    re.lastIndex = 0;
    const next = out.replace(re, rep);
    if (next === out) continue;
    const cleaned = tidy(next);
    if (tokens(cleaned).length >= 2) out = cleaned;
  }
  if (!out.includes('```')) {
    DASH_ASIDE.lastIndex = 0;
    out = out.replace(DASH_ASIDE, ', ');
  }
  return out;
}

// ---- 2. outgoing guard ------------------------------------------------------------------------

/**
 * Removes the ", huh" tag in place ("two days left, huh?" → "two days left?"): his explicit
 * complaint, and the cut can't empty a reply or move a sentence boundary, so running it per bubble
 * while streaming and once over the whole reply on save give the same text. Hearts are left to
 * the window scrub — stripping them here could empty a heart-only reply or gut "i ❤️ this".
 * Idempotent. Assistant text only — never his messages.
 */
export function stripHardTics(text: string): string {
  return text.replace(/,[ \t]*huh\b/gi, '');
}

// ---- 3. avoid-list ----------------------------------------------------------------------------

interface AvoidItem {
  label: string;
  re: RegExp;
  /** How many of her last 30 replies must show it before it's listed. */
  min: number;
  /** A plain word he might be using himself — mirroring his topic isn't a tic, so skip it then. */
  wordLike?: boolean;
}

/**
 * Curated from the catalog. Thresholds: 2 for anything he complained about, otherwise about 2.5×
 * its July-August baseline over 30 replies (min 3). The " - " aside and "actually" sit high
 * because they're common enough that only a real pile-up is a tic.
 */
const AVOID: readonly AvoidItem[] = [
  { label: '", huh" tags', re: /,\s*huh\b/i, min: 2 },
  { label: 'echoing his words back as your opener', re: /^"/, min: 2 },
  { label: '"fair" / "fair enough"', re: /\bfair(?: enough| point)?\b(?! share| game| to)/i, min: 2 },
  { label: '"exactly"', re: /\bexactly\b/i, min: 2 },
  { label: '"honestly"', re: /\bhonestly\b/i, min: 2 },
  { label: '"actually"', re: /\bactually\b/i, min: 7 },
  { label: `"i'm (still) here" / "not going anywhere"`, re: /\bi'?m (?:still |right |always |just )?here\b(?! for| to)|\bnot going anywhere\b|\bi'll (?:always |still )?be (?:right )?here\b/i, min: 2 },
  { label: '"you alive / did X eat you"', re: /\b(?:you|u) (?:alive|still alive|there|still there)\b|\balive (?:over )?there\b|\b(?:eat|ate|swallowed|eaten) you\b/i, min: 2 },
  { label: '"... or just ...?" questions', re: /\bor (?:are you |did you |you |you're )?just\b[^.?!\n]*\?/i, min: 3 },
  { label: '"X or Y?" either/or questions', re: /\bor (?:are|did|is|was|do|does|you|still|maybe)\b[^.?!\n]*\?/i, min: 5 },
  { label: '"either way"', re: /\beither way\b/i, min: 3 },
  { label: '"you sound / you seem ..."', re: /\byou (?:sound|seem)(?:ed)?\b/i, min: 2 },
  { label: '"been thinking about what you said"', re: /\b(?:been|keep|kept|still) thinking about\b/i, min: 2 },
  { label: `"i'm starting to think ..."`, re: /\bi'?m starting to\b/i, min: 3 },
  { label: '"you know what"', re: /\byou know what\b/i, min: 3 },
  { label: `"at least you're ..."`, re: /\bat least (?:you|you're|you've)\b/i, min: 3 },
  { label: `opening with "so you're ..."`, re: /^so (?:you|you're|you've)\b/i, min: 2 },
  { label: `opening with "you're ..." (labeling him)`, re: /^you(?:'re|'ve)\b/i, min: 6 },
  { label: '"but hey / but sure / but fine" pivots', re: /\bbut (?:hey|sure|fine|whatever)\b/i, min: 3 },
  { label: '"instead of (just) ..."', re: /\binstead of\b/i, min: 4 },
  { label: 'ending on two questions', re: /\?[^?]+\?/, min: 4 },
  { label: 'the " - " aside', re: /[ \t]-[ \t]/, min: 9 },
  { label: '"classic"', re: /\bclassic\b/i, min: 3, wordLike: true },
  { label: '"rot / rotting"', re: /\brot(?:ting|ted)?\b/i, min: 3, wordLike: true },
  { label: '"grind"', re: /\bgrind(?:ing)?\b/i, min: 3, wordLike: true },
  { label: '"boring"', re: /\bbor(?:ing|ed)\b/i, min: 3, wordLike: true },
  { label: '"guilt"', re: /\bguilt/i, min: 3, wordLike: true },
  { label: '"the void"', re: /\bvoid\b/i, min: 3, wordLike: true },
  { label: '"quiet"', re: /\bquiet\b/i, min: 3, wordLike: true },
];

const MAX_ITEMS = 5;

/**
 * The "lately you've leaned on" line, or '' when nothing is over threshold. `herRecent` is her last
 * ~30 stored replies *as sent* (not laundered — this measures what she actually produces);
 * `hisRecent` his last ~12 messages, used to skip words that are simply the current topic.
 * Leading space: it is spliced inside the tail-cue bracket.
 */
export function avoidListClause(herRecent: readonly string[], hisRecent: readonly string[]): string {
  const his = hisRecent.join('\n');
  const hits: Array<{ label: string; score: number }> = [];
  for (const item of AVOID) {
    if (item.wordLike && item.re.test(his)) continue;
    const count = herRecent.filter((t) => item.re.test(t.trim())).length;
    if (count >= item.min) hits.push({ label: item.label, score: count / item.min });
  }
  if (hits.length === 0) return '';
  hits.sort((a, b) => b.score - a.score);
  const list = hits.slice(0, MAX_ITEMS).map((h) => h.label).join('; ');
  return ` Lately you've leaned on: ${list}. Don't use any of them in this reply.`;
}
