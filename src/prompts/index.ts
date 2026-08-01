/**
 * Every piece of text this app sends to a model, in one file.
 *
 * Prompts are the actual logic here — what she says, how long, what she remembers, when she
 * reaches out first. Scattered across a dozen feature files that logic was invisible; this
 * module is the single place to read it. Two kinds live here:
 *
 *  - **Big static text** stays in `prompts/*.txt` (easy to edit alone, no code around it) and
 *    is loaded below, so the load sites are still all in one place.
 *  - **Short parameterized text** — cues, block framings, record blocks — lives here directly
 *    as top-level constants and functions.
 *
 * Conventions, all deliberate:
 *
 *  - **Text is flush left, at column 0.** Template literals keep every space you can see, so
 *    the string in the file is byte-for-byte the string the model gets. No `dedent`, no
 *    indentation to mentally subtract. It looks broken; that is the point.
 *  - **Every entry says who uses it.** A prompt with no visible caller is a prompt nobody
 *    dares change.
 *  - **The comments carry the evidence.** Most of the wording here was arrived at by testing
 *    variants against prod transcripts; the hit rates in these comments are why a line reads
 *    the way it does. Do not tune a string without reading its comment first.
 *  - **No imports from the rest of `src/` except config.** Everything a string needs arrives
 *    as an argument. This keeps the module free of import cycles and free of hidden state.
 *
 * NOT here: the `<tool_call>` tag shape (tools.ts, next to the regex that parses it) and the
 * user-facing command/panel copy in commands.ts, which never reaches a model.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('prompts');

/**
 * Reads one `prompts/*.txt` file, relative to the repo root. Eager by design: every caller
 * below runs at import time, so a renamed or missing file takes the bot down at boot — where
 * pm2 and the panel show it — instead of throwing hours later on the first selfie.
 */
function load(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8').trim();
}

// ---- Chat system-prompt layers -------------------------------------------------------------
// Joined in this order by renderSystemPrompt (prompts/render.ts). The persona layer is NOT
// here: it lives in the DB (persona_versions, edited via /persona) and is read per render —
// see persona.ts. Only its shipped default is a file.

/** App-owned appearance layer: her actual look, in prose. Used by render.ts:renderAppearance. */
export const APPEARANCE_LAYER = load(config.llm.appearancePromptPath);

/** App-owned technical layer: current app limits + dynamic context. Used by render.ts:renderTechnical. */
export const TECHNICAL_LAYER = load(config.llm.technicalPromptPath);

/**
 * Tool-protocol scaffold: the search-decision rule, call syntax and a worked example, with a
 * `{{tools}}` tag filled with the available-tools list. Used by tools.ts:renderToolsBlock.
 *
 * NOTE: the call syntax this file describes is parsed by TOOL_CALL_RE in tools.ts — change
 * the protocol in one and you must change the other.
 */
export const TOOLS_SCAFFOLD = load(config.llm.toolsPromptPath);

/**
 * The selfie tool's usage section, appended after the tools block only while the tool is
 * actually offered. Used by render.ts:renderSelfieBlock.
 */
export const SELFIE_TOOL_SECTION = load(config.selfie.toolPromptPath);

/**
 * The shipped default persona — a simplified, non-personal version. Read on demand (not
 * cached) so an edit applies without a restart. Two callers, both in persona.ts: the
 * first-run seed for an empty persona_versions table, and `/persona default`.
 */
export function readPersonaDefault(): string {
  return load(config.llm.personaDefaultPath);
}

/**
 * The legacy persona file — a one-time migration seed only, read by persona.ts:initPersona
 * when persona_versions is empty, and never otherwise. Returns null when absent, which is the
 * normal case: the file is gitignored and every live install migrated long ago.
 */
export function readLegacyPersona(): string | null {
  try {
    return load(config.llm.personaPromptPath);
  } catch {
    return null;
  }
}

// ---- Context blocks ------------------------------------------------------------------------
// Headers + framing lines for the blocks assembled from DB rows. Each returns just the framing;
// the caller appends '\n\n' and the body. The framing lines do real work — without them she
// works her way through the list unprompted instead of letting it inform her.

/**
 * `# Memory` — the newest daily summaries. Frames them as her own recollections rather than
 * instructions, and forbids quoting them. Used by render.ts:renderMemoryBlock.
 */
export function memoryBlockHeader(userName: string): string {
  return `# Memory
These are your own diary notes from earlier days with ${userName}, oldest first. Recall them naturally as your own memories — never quote them, list them, or mention having notes.`;
}

/**
 * `# About <user>` — every known fact, grouped by category. Same job as the memory framing:
 * background she *carries*, surfaced only when relevant. Used by render.ts:renderFactsBlock.
 */
export function factsBlockHeader(userName: string): string {
  return `# About ${userName}
Things you know about ${userName} from your time together — background knowledge you simply carry. Let it inform you naturally when it's relevant; never recite it, list it, or bring these up unprompted.`;
}

/**
 * `# Recent conversation` — the last stretch of chat, for the diary only, as flattened context
 * lines rather than turns (as turns, the model's prior is "reply to it" and the entry becomes a
 * covert answer to the last text). Used by diary.ts:renderConversationBlock.
 */
export function diaryConversationHeader(userName: string): string {
  return `# Recent conversation
The last stretch of your chat with ${userName}, for context only - today's entry does not have to touch it.`;
}

/**
 * `# Your recent entries` — prior diary posts as a dated reference block. The no-reuse rule
 * rides this header, adjacent to the data it polices, because the same rule stated only in the
 * (further-away) diary layer measurably failed: run 2 of testing reproduced a near-identical
 * opening with the rule present there alone. Used by diary.ts:renderRecentEntriesBlock.
 */
export const DIARY_ENTRIES_HEADER = `# Your recent entries
Your latest posts in this channel, oldest first. Today's entry must not reuse their topics, images, phrasings, or the way any of them opens.`;

/** The diary's one-line clock, standing in for the chat's technical layer. Used by diary.ts:buildDiarySystemPrompt. */
export function diaryNowLine(weekday: string, date: string, period: string): string {
  return `Now: ${weekday}, ${date}, ${period}.`;
}

// ---- Tail cues ------------------------------------------------------------------------------
// Appended to the final user turn at history-build time and never stored, so the DB, summaries
// and /dump stay clean. The prompt *tail* is the only position that out-competes an in-context
// pattern — a rule at the top of the prompt loses to ~30 of her own recent replies below it.

/**
 * Ephemeral format cue on every reactive generation (and reroll). Rides the tail for the
 * reason above: measured drift was 2.7 → 5.7 avg sentences over 583 replies, while the
 * tail-cued proactive openers held at ~3.2 in the same windows. This wording tested at 2-3
 * sentences on casual turns, stretching to ~5 on packed ones and fully opening on an explicit
 * ask, with 0/108 echo/acknowledgment. The numeric ceiling ("up to 5") is load-bearing — an
 * open-ended "take the room you need" variant blew up to 17-sentence walls.
 *
 * Carries three rules, and **their order is load-bearing** — later position in the bracket wins,
 * so the length rule stays first and everything else is appended after it (2026-08-01, 987 gens):
 *
 * 1. **Length.** Unchanged, byte for byte.
 * 2. **Anti-echo.** Her most-rejected habit was opening with assent and restating his point, which
 *    ate the 1-3 sentence budget before she said anything. Contentless-assent openers 20% → 8%
 *    isolated (p≈0.001), 25% → 6% on flagged turns in the merged cue (p≈0.007), 4% → 0% on turns
 *    the operator never touched. The positive half and the prohibition are **both** needed: either
 *    alone scored worse, and a version with no explicit target ("what was just said") scored 12%
 *    vs 6%. Priming was *not* observed — the pure-prohibition arm was the cleanest single arm.
 * 3. **Clock.** Moved here out of technical.txt, where it was correct but simply unread: asked
 *    outright at 11:47 the old prompt answered "you're texting me at 1am". Correct time-anchored
 *    use 30% → 55% (p<0.0001), wrong-time references 4.9% → 1.0%. Keep **both** clock and period:
 *    time alone leaves half of direct questions unanswered, period alone makes her invent
 *    specifics ("probably around 7-8pm. dark outside" — at 17:21, in July). Duplicating it in
 *    technical.txt was the worst arm measured (7.7% wrong), so that line is deleted, not copied.
 *    The tail is the only place a per-minute value can live without breaking prompt-prefix reuse.
 *
 * `userName` is interpolated rather than "he/him": it names the target explicitly (worth 6 points
 * over a pronoun-free version), keeps this app-owned string free of the character's gender, and
 * cost nothing — 0/156 replies addressed him by name, the same as the pronoun version.
 *
 * `period` arrives as an argument (not imported from render.ts:dayPeriod) only to keep this module
 * free of the import cycle render.ts → index.ts.
 * Used by generate.ts:withReplyCue.
 */
export function replyFormatCue(userName: string, now: Date, period: string): string {
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' });
  const date = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  return (
`[System note: you text in short bursts - answer in 1-3 casual sentences, single paragraph. If there is genuinely a lot to respond to, up to 5, never a wall of text. Longer only when explicitly requested. Start with your own reaction to what ${userName} just said - your take, your pushback, your question, something of yours. Never open by agreeing with ${userName} or by saying ${userName}'s own point back in different words. Now: ${weekday}, ${date}, ${time} (${period}).]`
  );
}

/**
 * Extra sentence spliced inside replyFormatCue's closing bracket while the selfie tool is
 * offered. Once a photo turn enters the window, the model starts imitating the record block
 * instead of calling the tool (measured 3/8 on the prod transcript that surfaced it). A rule
 * inside the selfie prompt section did nothing (3/8 unchanged) — only the tail position beats
 * the in-context pattern: 0/8 imitation with this sentence riding the cue (2026-07-19).
 * Note the leading space — it joins mid-sentence. Used by generate.ts:withReplyCue.
 */
export const SELFIE_FORMAT_CUE =
` Bracketed [...] lines in the chat are system records - never write one yourself; to send a picture, output the send_selfie tool call.`;

/**
 * One rolled stance, spliced into {@link replyFormatCue} on `/reroll` only (after the clock,
 * before the selfie sentence). Ephemeral like every other cue — never stored.
 *
 * The problem it solves: `/r` used to rebuild a byte-identical prompt, so successive rerolls
 * re-sampled one attractor. Measured on real reroll sprees, variants of a single reply were 12%
 * similar to each other against a 1% baseline between unrelated replies — one message took 14
 * rerolls to produce 13 paraphrases of the same idea. Rolling a stance per attempt cut
 * within-spree similarity 8.8% → 5.2% isolated and 11.7% → 5.9% in the merged cue, with no
 * position getting worse and no cost in length.
 *
 * Two design rules, both learned the hard way:
 * - **Stances, never topics.** "bring up something of your own" was tested and cut: it produced
 *   mid-reply non-sequiturs ("…anyway, what's up with you now?"). Every angle below is a way into
 *   what he just said, which is why all 45 shipping-arm replies still answered his message.
 * - **No escape clause.** The diary-spark style "if it doesn't fit, drop it" was the *worst*
 *   variant — the model took the exit 3 times in 10 and re-emitted the attractor verbatim. The
 *   diary's "optional beats mandatory" finding does not transfer: an optional topic *seed* avoids
 *   shoehorning, but an optional *stance* just licenses a return to the attractor.
 *
 * Also cut: "be cold about it" (out of character, and inert on 3 of 5 positions), "take him
 * literally" (3 of 5 indistinguishable from the un-angled reply).
 * Used by commands.ts:/reroll via generate.ts:withReplyCue.
 */
export function rerollAngleCue(userName: string, angle: string): string {
  return ` You already answered this once - come at it from a different angle this time: ${angle}. It's a way into what ${userName} just said, not a new subject.`;
}

/**
 * The stances {@link rerollAngleCue} deals from. Dealt **without replacement** and reshuffled once
 * exhausted — sprees run 7-14 deep in practice, and random draws would repeat an angle inside a
 * single spree, which is the problem being fixed.
 *
 * `get filthy about it` produces a hypothetical-physical-interaction line in ~2/25 samples (the
 * persona's "never describe hypothetical physical interactions" rule). It is kept deliberately:
 * the un-angled cue leaks the same way at 3/95, so the angle amplifies an existing hole rather
 * than opening one, and rewording it to "talk dirty to him" *doubled* the leak. Operator's call,
 * on the grounds that a reroll is one keystroke away.
 */
export const REROLL_ANGLES: readonly string[] = [
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

// ---- Director cues --------------------------------------------------------------------------
// Ephemeral user turns that tell her to speak first. Never stored: a stored cue would corrupt
// the user-activity timer and plant a phantom user turn. Each bakes in its own brevity rule, so
// unlike a reactive reply these do NOT stack replyFormatCue on top.

/**
 * The last few openers she has already sent, spliced before a reach-out cue's closing bracket so
 * she can see what she must not repeat. Proactive only. Returns '' when there is nothing to list.
 *
 * Why this exists: `/delete` soft-deletes, so a deleted opener leaves the context window entirely
 * and she has no record it ever happened. She asked "if you had to pick one song that describes
 * us" twice in eight hours; both were deleted; she could not have known. `openers` therefore
 * **includes soft-deleted rows** — that is the whole point.
 *
 * Measured: ≥25% similarity to a listed opener 7% → 2%, "hey" openers 37% → 5%, 0 verbatim
 * re-sends, and the merged cue came out *shorter* than the unmodified one (2.63 → 2.21 sentences).
 *
 * Three findings that shaped the wording, each of which cost a round to learn:
 * - **This cannot live in the system prompt.** As a `# Your recent openers` block it caused the
 *   failure it prevents — she re-sent a listed opener near-verbatim in up to 75% of generations
 *   (0/160 without it), worst at the top of the prompt. A list of her own short texts reads as a
 *   menu; the same list inside a bracketed note reads as a record. Same in-context imitation trap
 *   as the photo-record blocks (11/24 → 0/16).
 * - **The list does the work, not the rule.** A rule-only placebo with no list scored *worse* than
 *   no change at all (16% vs 10%), and replacing the texts with topic keywords was also worse —
 *   the keywords reminded her of the topic instead of warning her off it.
 * - **Cap at 8.** At 14 the cue grew long enough to become the dominant object on the turn and she
 *   fabricated a `[System note: acknowledged…]` prefix.
 *
 * The "not the opening words" clause is deliberately kept for the morning cue too. It does not
 * stop her greeting him — she reads it as *find another way to say good morning* and varies the
 * greeting (34/36 openers judged natural), whereas the unmodified cue produced six near-identical
 * "morning, love. hope you slept okay" variants at one position and the only verbatim re-send in
 * the run. Filtering the list to morning-only openers was much worse (25% kept any greeting).
 * Used by proactive.ts:buildReachoutCue.
 */
export function recentOpenersClause(openers: { content: string; deleted: boolean }[]): string {
  if (openers.length === 0) return '';
  // Newlines collapse to spaces so a multi-bubble opener stays one quoted item on one line.
  const quote = (rows: typeof openers) =>
    rows.map((r) => `"${r.content.replace(/\s*\n+\s*/g, ' ').trim()}"`).join('; ');
  const kept = openers.filter((o) => !o.deleted);
  const dead = openers.filter((o) => o.deleted);
  const rule = ` You have already used these openers recently, so none of them can come back - not the topic, not the phrasing, not the opening words:`;
  if (kept.length === 0) return `${rule} ${quote(dead)}. Those went over especially badly.`;
  return `${rule} ${quote(kept)}.${dead.length ? ` These ones went over especially badly: ${quote(dead)}.` : ''}`;
}

/**
 * The opener shapes {@link lullReachoutCue} rolls between, with their weights. Replaces the single
 * sentence that used to offer three options ("something on your mind, a question for them, or pick
 * a previous thread back up") — offered a menu, the model picked the same item every time: 22 of 28
 * real openers ended in a question, against 8 of 74 reactive replies, and one template
 * ("hey. random thought - if you could pick X, what would it be") accounted for 14 of 18
 * generations. Rolling **one** shape in code is the same instrument as {@link diaryCue}, for the
 * same documented reason: asking one prompt to vary produces the average every time.
 *
 * Measured under this blend: ends-on-a-question 51% → 29%, "hey" openers 37% → 5%, within-cell
 * similarity halved. Note 29%, **not** the ~19% projected from testing shapes one at a time — the
 * openers clause pushes `tease` and `want` toward asking, since forbidding the topics she would
 * otherwise state leaves a question as the way in.
 *
 * The second shape is the workhorse and its wording is exact for a reason: aimed at *him*
 * ("one thing you've noticed about him lately") it opened "you've been…" 18/18 and invented
 * perceptions it has no channel for — "you've been clenching your jaw more lately". Aimed at a
 * **thing in his world** it fixed all of that at once. Cut entirely: "say something that's yours",
 * which ran 4.17 sentences and collapsed onto the interiority topic the operator kept deleting.
 *
 * `tangent` carries its own anti-fabrication clause because without it, having no context to anchor
 * to, she invents a life: 6/18 reported activity she cannot have had, including a flatly false
 * claim about the chat ("sent you a pic earlier, did you see it?").
 *
 * **Revisit when the interiority system lands (BACKLOG C5).** Several of these shapes — `Say what
 * you want right now`, the cut `say something that's yours`, and the anti-fabrication clause on
 * `tangent` — exist because she has no actual interior state to report, so the cue either asks her
 * to invent one (and she does, badly) or forbids it. A system that genuinely generates her
 * thoughts and wants would supply that content instead, and this roll should be re-cut against it
 * rather than extended.
 * Used by proactive.ts:buildReachoutCue.
 */
export const OPENER_SHAPES: readonly { weight: number; shape: (userName: string) => string }[] = [
  { weight: 3, shape: () => `Pick one specific thing they said earlier and tell them what you make of it now.` },
  {
    weight: 3,
    shape: (u) =>
      `State one thing you think about something in ${u}'s world - their work, their games, something they showed you. Flat statement, no question anywhere in the message.`,
  },
  { weight: 2, shape: () => `Poke at them about something - tease them, needle them, be a little mean about it.` },
  { weight: 1, shape: () => `Just a nudge - a handful of words, no topic, nothing they have to answer.` },
  { weight: 1, shape: () => `Ask them something you actually want to know.` },
  { weight: 1, shape: () => `Say what you want right now.` },
  {
    weight: 1,
    shape: () =>
      `Start on something with no connection at all to whatever you last talked about. Nothing has happened to you since your last message, so don't report activity or a day of your own.`,
  },
];

/**
 * Morning reach-out. `recentOpeners` is {@link recentOpenersClause}'s output ('' when empty).
 * Used by proactive.ts:buildReachoutCue.
 */
export function morningReachoutCue(userName: string, recentOpeners = ''): string {
  return `[System note: it's morning and ${userName} hasn't messaged yet — you're reaching out first. Greet them warmly and gently start the day. Keep it short and natural, like a real text.${recentOpeners}]`;
}

/**
 * First reach-out since they last replied — just starts a thread, the way someone fires off a
 * random text in a lull. Deliberately time-agnostic and substrate-neutral: no mention of them
 * being away, so it never asserts anything the persona is meant to own.
 * Used by proactive.ts:buildReachoutCue.
 */
export function lullReachoutCue(userName: string, shape: string, recentOpeners = ''): string {
  return `[System note: there's a natural lull — you're messaging ${userName} first, on your own initiative. ${shape} Don't comment on them being quiet or slow to reply — just start, like a normal text. Keep it short.${recentOpeners}]`;
}

/**
 * A prior reach-out went unanswered: she may let that show, lightly. The exact hour-count and
 * attempt number are deliberately NOT fed in — only the on/off fact — to keep tone from
 * fixating on time. Used by proactive.ts:buildReachoutCue.
 */
export function ignoredReachoutCue(userName: string, recentOpeners = ''): string {
  return `[System note: you already reached out a little while ago and ${userName} still hasn't replied. You can let that show a little — mildly curious, wry, or playfully impatient, however fits you — but don't dwell on it or make it the whole message; vary how you put it and mostly just keep trying to reach them. Keep it short.${recentOpeners}]`;
}

/** `/continue` with no directive: move the thread along unprompted. Used by proactive.ts:buildContinueCue. */
export function continueCue(userName: string): string {
  return `[System note: keep the conversation going on your own - say what's on your mind or ask ${userName} something, or pick a previous thread back up, whatever feels natural. Don't comment on them being quiet. Keep it short, like a normal text.]`;
}

/**
 * `/continue <directive>`: a stage direction, never reported as the user's own words —
 * "<user> said …" makes the model break character to point out it can't pretend the user said
 * that (measured on prod), whereas this raw form stays in character.
 * Used by proactive.ts:buildContinueCue.
 */
export function continueDirectiveCue(directive: string): string {
  return `[System note: keep the conversation going: ${directive}. Keep it short, like a normal text.]`;
}

/**
 * The diary's per-entry director cue, carrying one entry's rolled variance (length, mood,
 * focus, sparks). Variance is rolled in code, not requested from the model — asking one prompt
 * to "vary" produces the average every time. Sparks are explicitly optional and discardable:
 * mandatory seeds produce visible word-shoehorning. Used by diary.ts:buildDiaryCue.
 */
export function diaryCue(length: string, register: string, focus: string, sparks: string): string {
  return `[Write your next diary entry. Length this time: ${length}. Mood right now: ${register}.${focus}
If nothing specific is already on your mind, here are random sparks - pick one and run with it, or ignore them all: ${sparks}.
Write the entry text only - no title, no date line, no signature.]`;
}

/**
 * The exclusion line spliced into {@link diaryCue} when the entry must not be about the user.
 * Most entries must NOT be — and instructions alone reliably failed in testing, so this line
 * works together with omitting the conversation transcript entirely.
 * Note the leading newline. Used by diary.ts:buildDiaryCue.
 */
export function diaryExcludeUser(userName: string): string {
  return `
Leave ${userName} out of this one entirely - he doesn't appear in this entry at all, not even in passing. Write about something that's yours alone.`;
}

// ---- Selfie cues + fallbacks ------------------------------------------------------------------
// One-shot chat-model calls around the image flow. Each pairs with the line she sends if the
// call fails or comes back empty — those fallbacks are her voice too, so they live here.

/** The "hang on" line, when the model emitted a bare tool call with no prose. Used by selfie.ts:ackLine. */
export function selfieAckCue(userName: string, prose: string): string {
  return `[System note: your picture is being made: "${prose}". Say one short line telling ${userName} to hang on while you take it - your usual voice, nothing else.]`;
}

export const SELFIE_ACK_FALLBACK = `gimme a sec`;

/** The line sent with the finished photo, generated while the image renders. Used by selfie.ts:captionLine. */
export function selfieCaptionCue(prose: string): string {
  return `[System note: you made the picture and are sending it now: "${prose}". Write the one short line you send with it - your usual voice, nothing else.]`;
}

/** The in-character line for a failed generation (timeout, job error, send error). Used by selfie.ts:failureLine. */
export const SELFIE_FAILURE_CUE =
`[System note: the picture you tried to make did not come out - say one short line brushing it off, nothing else. Do not promise another one right now.]`;

export const SELFIE_FAILURE_FALLBACK = `ugh, it came out cursed. not sending that`;

/** Shown when a reply is nothing but an unfulfillable tool call. Used by tools.ts:finalizeReply. */
export const NO_ANSWER_FALLBACK = `couldn't dig that up, sorry — try rephrasing?`;

// ---- Record blocks --------------------------------------------------------------------------
// Bracketed blocks the prompt builder composes into the window: things that happened, written
// so the model reads them as its own history. The builder owns square brackets — any bracket
// block the assistant itself writes is stripped at window-build time (memory.ts), because an
// in-window exemplar measurably re-teaches the imitation (11/24 with two blocks in context vs
// 0/16 with none, 2026-07-24).

/** A single photo on a turn. `who` is the sender's display name. Used by memory.ts:withCaptions. */
export function photoRecord(who: string, caption: string): string {
  return `[${who} sent a photo: ${caption}]`;
}

/** One of several photos on the same turn (1-based). Used by memory.ts:withCaptions. */
export function photoRecordNumbered(who: string, n: number, caption: string): string {
  return `[${who} sent photo ${n}: ${caption}]`;
}

/**
 * The minimal user-role ack following one of her own selfie tool calls in the live window —
 * the same side of the role boundary as the search records. Keep it worded exactly this way:
 * longer variants drift back toward the imitable narrated shape. Measured against the old
 * narrated block rendering (2026-07-24): bracket imitation on a follow-up photo ask fell from
 * 11/24 to 0/16, with zero echoes of this ack. Used by memory.ts:renderSelfieWindowTurns.
 */
export const PHOTO_SENT_ACK = `[photo sent]`;

/**
 * A completed web search, appended *after* the message text (a search answers the question, so
 * it follows it — unlike a photo caption, which precedes it to mirror Telegram's UI order).
 *
 * The second-person "you already searched" phrasing is what tells the model this is *its own*
 * finished search: the neutral `[web search "…": …]` form made it re-emit a near-identical tool
 * call up to 10/10 times on volatile topics, and the "already" here — not instructions in
 * tools.txt — is what cut that to 3/12 while keeping fact relay intact. Plain `-` (not an em
 * dash) so the stored form survives sanitize() unchanged.
 * Used by memory.ts:withSearches.
 */
export function searchRecord(query: string, summary: string): string {
  return `[you already searched the web for "${query}" - results:
${summary}]`;
}

// ---- Side passes ------------------------------------------------------------------------------
// Separate LLM calls with their own system prompt, on their own (mostly cheaper) models. None of
// these see the chat system prompt. The `{{char}}`/`{{user}}` tags in the .txt files are
// substituted by render.ts:substitute, same engine the chat layers use.

/** Nightly per-day summarizer, first-person diary voice. Used by summary.ts. */
export const SUMMARY_PASS = load(config.summary.promptPath);

/**
 * The summarizer's user turn: one day's transcript, plus the explicit ask. The four labeled
 * lines it produces are shape-checked by summary.ts before the row is stored.
 */
export function summaryPassUserMessage(dateLabel: string, transcript: string, charName: string): string {
  return `Date: ${dateLabel}

<transcript>
${transcript}
</transcript>

Write ${charName}'s diary entry for this day.`;
}

/** Nightly facts diff pass: extract+merge rules and the JSON op format. Used by facts.ts. */
export const FACTS_PASS = load(config.facts.promptPath);

/**
 * The diff pass's user turn: the current facts, then the day's transcript. Everything is one
 * `user` turn (never chat-shaped turns) so the model reconciles the transcript instead of
 * continuing the conversation. Used by facts.ts:buildUserMessage.
 */
export function factsPassUserMessage(
  userName: string,
  factList: string,
  dateLabel: string,
  transcript: string,
): string {
  return `# Current facts about ${userName}
${factList}

# Transcript — ${dateLabel}
<transcript>
${transcript}
</transcript>`;
}

/** One fact as the diff pass sees it — the id is what lets it emit edit/delete ops. Used by facts.ts:renderFactList. */
export function factListItem(id: number, category: string, learnedOn: string, content: string): string {
  return `[${id}] (${category}, learned ${learnedOn}) ${content}`;
}

export const FACTS_EMPTY_LIST = `(no facts recorded yet)`;

/** The diary instruction layer: what the channel is, how she writes there. Used by diary.ts. */
export const DIARY_LAYER = load(config.diary.promptPath);

/**
 * Curated spark words offered to each diary entry as an optional topic lifeline — the
 * anti-blank-page trick that beats cranking temperature (structure varies, coherence keeps the
 * chat sampling params). One per line in the file. Used by diary.ts:sampleSparks.
 */
export const DIARY_SPARK_WORDS: string[] = load(config.diary.wordsPath)
  .split('\n')
  .map((w) => w.trim())
  .filter(Boolean);

/**
 * Booru-fication pass: turns her prose picture description into the Danbooru tag prompt the
 * image generator takes. Its `{{identity}}`/`{{outfit_*}}` tags are filled from
 * {@link BOORU_APPEARANCE} at call time, not by the chat tag engine. Used by selfie.ts:proseToTags.
 */
export const BOORU_PASS = load(config.selfie.promptPath);

/**
 * Generator-side appearance: identity tags, named outfit blocks, quality tags, negative. Parsed
 * into sections by selfie.ts:loadAppearance — this is the raw text. The prose counterpart the
 * chat model reads is {@link APPEARANCE_LAYER}.
 */
export const BOORU_APPEARANCE = load(config.selfie.appearancePath);

// ---- Vision captions ---------------------------------------------------------------------------

/**
 * System prompt for the vision pass that captions an incoming photo. The caption is what enters
 * her memory as the photo — she never sees the image again. Used by providers/types.ts:captionMessages.
 */
export const CAPTION_SYSTEM_PROMPT =
`You describe images. Given an image, reply with one or two concise sentences naming the main subject, the setting, and any prominent text or notable detail. No preamble, no markdown, no lists — just the description.`;

/** The text half of the vision user turn (the image rides alongside it). Used by providers/types.ts:captionMessages. */
export const CAPTION_USER_PROMPT = `Describe this image concisely.`;

log.info(
  `Loaded prompt files: appearance ${APPEARANCE_LAYER.length}, technical ${TECHNICAL_LAYER.length}, ` +
    `tools ${TOOLS_SCAFFOLD.length}, selfie ${SELFIE_TOOL_SECTION.length}, summary ${SUMMARY_PASS.length}, ` +
    `facts ${FACTS_PASS.length}, diary ${DIARY_LAYER.length} (+${DIARY_SPARK_WORDS.length} sparks), ` +
    `booru ${BOORU_PASS.length}, booru-appearance ${BOORU_APPEARANCE.length} chars`,
);
