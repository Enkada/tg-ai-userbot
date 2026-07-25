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
 * Used by generate.ts:withReplyCue.
 */
export const REPLY_FORMAT_CUE =
`[System note: you text in short bursts - answer in 1-3 casual sentences, single paragraph. If there is genuinely a lot to respond to, up to 5, never a wall of text. Longer only when explicitly requested.]`;

/**
 * Extra sentence spliced inside REPLY_FORMAT_CUE's closing bracket while the selfie tool is
 * offered. Once a photo turn enters the window, the model starts imitating the record block
 * instead of calling the tool (measured 3/8 on the prod transcript that surfaced it). A rule
 * inside the selfie prompt section did nothing (3/8 unchanged) — only the tail position beats
 * the in-context pattern: 0/8 imitation with this sentence riding the cue (2026-07-19).
 * Note the leading space — it joins mid-sentence. Used by generate.ts:withReplyCue.
 */
export const SELFIE_FORMAT_CUE =
` Bracketed [...] lines in the chat are system records - never write one yourself; to send a picture, output the send_selfie tool call.`;

// ---- Director cues --------------------------------------------------------------------------
// Ephemeral user turns that tell her to speak first. Never stored: a stored cue would corrupt
// the user-activity timer and plant a phantom user turn. Each bakes in its own brevity rule, so
// unlike a reactive reply these do NOT stack REPLY_FORMAT_CUE on top.

/**
 * Morning reach-out. Used by proactive.ts:buildReachoutCue.
 */
export function morningReachoutCue(userName: string): string {
  return `[System note: it's morning and ${userName} hasn't messaged yet — you're reaching out first. Greet them warmly and gently start the day. Keep it short and natural, like a real text.]`;
}

/**
 * First reach-out since they last replied — just starts a thread, the way someone fires off a
 * random text in a lull. Deliberately time-agnostic and substrate-neutral: no mention of them
 * being away, so it never asserts anything the persona is meant to own.
 * Used by proactive.ts:buildReachoutCue.
 */
export function lullReachoutCue(userName: string): string {
  return `[System note: there's a natural lull — you're messaging ${userName} first, on your own initiative. Open with whatever feels natural: something on your mind, a question for them, or pick a previous thread back up. Don't comment on them being quiet or slow to reply — just start, like a normal text. Keep it short.]`;
}

/**
 * A prior reach-out went unanswered: she may let that show, lightly. The exact hour-count and
 * attempt number are deliberately NOT fed in — only the on/off fact — to keep tone from
 * fixating on time. Used by proactive.ts:buildReachoutCue.
 */
export function ignoredReachoutCue(userName: string): string {
  return `[System note: you already reached out a little while ago and ${userName} still hasn't replied. You can let that show a little — mildly curious, wry, or playfully impatient, however fits you — but don't dwell on it or make it the whole message; vary how you put it and mostly just keep trying to reach them. Keep it short.]`;
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
