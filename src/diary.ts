/**
 * Diary — unprompted posts to the character's private channel ("the basement tapes").
 *
 * A separate one-way surface, not a second chat: 1-3 entries land in the channel on a
 * random daily plan, written from the same persona + long-term context the chat uses, but
 * framed as private thoughts nobody reads. Nothing flows back — the channel is not in the
 * whitelist, entries never enter chat memory/summaries/facts, and the chat never learns the
 * diary exists (which is what keeps the "he doesn't read it" fiction airtight).
 *
 * Prompt shape (tested against prod context, see scripts/diary-test.ts):
 *  - system: persona → Now line → facts → memory → [recent-conversation transcript] →
 *    recent diary entries → the diary instruction layer (prompts/diary.txt);
 *  - user: one ephemeral director cue carrying the per-entry variance.
 *
 * Variance is rolled in code, not requested from the model (asking one prompt to "vary"
 * produces the average every time): a length bucket, a mood register, a focus roll (most
 * entries must NOT be about the user — enforced by omitting the transcript *and* an explicit
 * exclusion line; instructions alone reliably failed in testing), and random spark words
 * from a curated list as an optional topic lifeline (the anti-blank-page trick that beats
 * cranking temperature — structure varies, coherence keeps the chat sampling params).
 *
 * Prior entries are fed back as a *system reference block*, never as assistant turns —
 * as few-shot turns the model clones their structure and ruts within days (same failure
 * class as the opener/summary fixation that exiled memory from proactive openers).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { desc, eq } from 'drizzle-orm';
import type { TelegramClient } from '@mtcute/node';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { db } from './db/index.js';
import { diaryPosts, diaryState, type DiaryPostRow, type DiaryStateRow } from './db/schema.js';
import { getSummaryState, getWindowDetailed } from './memory.js';
import { dayPeriod, renderFactsBlock, renderMemoryBlock, renderPersona } from './prompt.js';
import { diaryEntry } from './providers/openrouter.js';
import { getCharName } from './settings.js';
import { sanitize } from './sanitize.js';
import { finalizeReply } from './tools.js';
import { formatDateTime } from './format.js';

const log = createLogger('diary');

// ---- Static assets (loaded once at startup, like the technical prompt layer) ---------------

/** The diary instruction layer, `{{tag}}` placeholders intact. */
const diaryLayerRaw = readFileSync(resolve(process.cwd(), config.diary.promptPath), 'utf8').trim();

/** Curated spark words, one per line. */
const sparkWords = readFileSync(resolve(process.cwd(), config.diary.wordsPath), 'utf8')
  .split('\n')
  .map((w) => w.trim())
  .filter(Boolean);

log.info(`Loaded diary layer (${diaryLayerRaw.length} chars) and ${sparkWords.length} spark words`);

/** The single conversation the diary draws context from (single-user bot by design). */
function primaryChatId(): number | undefined {
  return [...config.whitelist][0];
}

// ---- DB access ------------------------------------------------------------------------------

/** Singleton diary_state row id. */
const ROW_ID = 1;

function getDiaryState(): DiaryStateRow | null {
  return db.select().from(diaryState).where(eq(diaryState.id, ROW_ID)).get() ?? null;
}

/** Installs a fresh day plan (resets the cursor). */
function saveDiaryPlan(planDay: string, dueTimes: number[]): void {
  const now = Date.now();
  db.insert(diaryState)
    .values({ id: ROW_ID, planDay, dueTimes, nextIdx: 0, updatedAt: now })
    .onConflictDoUpdate({
      target: diaryState.id,
      set: { planDay, dueTimes, nextIdx: 0, updatedAt: now },
    })
    .run();
}

/** Advances the plan cursor past a posted (or stale-skipped) slot. */
function advanceCursor(nextIdx: number): void {
  db.update(diaryState).set({ nextIdx, updatedAt: Date.now() }).where(eq(diaryState.id, ROW_ID)).run();
}

function saveDiaryPost(content: string, tgMessageId: number | null, cue: string): void {
  db.insert(diaryPosts).values({ content, tgMessageId, cue }).run();
}

/** The newest `limit` entries, oldest first (chronological when stacked in the prompt). */
export function getRecentDiaryPosts(limit: number): DiaryPostRow[] {
  const rows = db.select().from(diaryPosts).orderBy(desc(diaryPosts.id)).limit(limit).all();
  rows.reverse();
  return rows;
}

/** Total entries ever posted (for `/diary` status). */
function diaryPostCount(): number {
  return db.select().from(diaryPosts).all().length;
}

// ---- The per-entry roll ----------------------------------------------------------------------

/** Mood registers, picked uniformly. Mood only — deliberately user-agnostic, focus is rolled apart. */
const REGISTERS = [
  'venting - something has been quietly bugging you',
  'wry - amused at something dumb',
  'petty - small, unreasonable, and you know it',
  'nostalgic',
  'philosophical - chasing a thought',
  'self-critical - picking at your own flaws',
  'restless',
  'tired, running on fumes',
  'weirdly good mood for no reason',
  'soft - quietly affectionate',
] as const;

/** Length buckets with cumulative-weight thresholds (30% / 45% / 25%). */
const LENGTHS: { upTo: number; text: string }[] = [
  { upTo: 0.3, text: 'a couple of short lines' },
  { upTo: 0.75, text: 'one solid paragraph' },
  { upTo: 1, text: 'two or three paragraphs' },
];

/** One entry's rolled parameters. */
export interface EntryRoll {
  length: string;
  register: string;
  /** True ⇒ the entry may involve the user: transcript included, no exclusion line. */
  aboutUsAllowed: boolean;
}

/** Rolls length, register and focus for one entry. */
export function rollEntry(): EntryRoll {
  const r = Math.random();
  return {
    length: (LENGTHS.find((l) => r <= l.upTo) ?? LENGTHS[LENGTHS.length - 1]).text,
    register: REGISTERS[Math.floor(Math.random() * REGISTERS.length)],
    aboutUsAllowed: Math.random() < config.diary.aboutChance,
  };
}

/** `n` distinct random spark words. */
function sampleSparks(n: number): string[] {
  const pool = [...sparkWords];
  const picked: string[] = [];
  while (picked.length < n && pool.length > 0) {
    picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return picked;
}

// ---- Prompt assembly --------------------------------------------------------------------------

/** Cached display name of the chat peer (same source the summarizer uses). */
function diaryUserName(chatId: number): string {
  return getSummaryState(chatId)?.userName ?? 'user';
}

/**
 * The last stretch of chat as a labeled system-block transcript — context, not turns. Sent
 * as flattened lines (never user/assistant messages): the model's prior on a trailing user
 * turn is "reply to it", which would make entries covert answers to the last text.
 */
function renderConversationBlock(chatId: number, userName: string): string {
  const cutoff = Date.now() - config.diary.transcriptHours * 3_600_000;
  const rows = getWindowDetailed(chatId)
    .filter((m) => m.at >= cutoff)
    .slice(-config.diary.transcriptMaxMessages);
  if (rows.length === 0) return '';
  const charName = getCharName();
  const lines = rows.map((m) => {
    const t = new Date(m.at);
    const label =
      t.toLocaleDateString('en-US', { weekday: 'short' }) +
      ' ' +
      t.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    return `[${label}] ${m.role === 'user' ? userName : charName}: ${m.content}`;
  });
  return (
    `# Recent conversation\n` +
    `The last stretch of your chat with ${userName}, for context only - today's entry does not have to touch it.\n\n` +
    lines.join('\n')
  );
}

/** Date label for a prior entry, e.g. "Friday, July 18, morning". */
function entryDateLabel(ms: number): string {
  const d = new Date(ms);
  return (
    d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) +
    `, ${dayPeriod(d.getHours())}`
  );
}

/**
 * Prior posts as a dated reference block. The no-reuse rule rides the block header — adjacent
 * to the data it polices — because the same rule stated only in the (further-away) diary layer
 * measurably failed: run 2 of testing reproduced a near-identical opening with the rule present
 * there alone.
 */
function renderRecentEntriesBlock(): string {
  const rows = getRecentDiaryPosts(config.diary.recentEntries);
  if (rows.length === 0) return '';
  const body = rows.map((e) => `[${entryDateLabel(e.createdAt)}]\n${e.content}`).join('\n\n');
  return (
    `# Your recent entries\n` +
    `Your latest posts in this channel, oldest first. Today's entry must not reuse their ` +
    `topics, images, phrasings, or the way any of them opens.\n\n` +
    body
  );
}

/**
 * The diary system prompt: persona → Now line → facts → memory → [transcript] → recent
 * entries → diary layer. The chat's technical/tools layers are deliberately absent (photo
 * protocol, tool protocol and texting-style rules don't apply here — the diary layer sets
 * its own register); only the Now line survives from the technical layer.
 *
 * The memory block is kept despite the known no-anchor fixation risk (see renderSystemPrompt's
 * opener note) — a diary without recall is pointless; sparks + the recent-entries no-reuse rule
 * are the counterweights, and early output is under watch.
 */
export function buildDiarySystemPrompt(
  chatId: number,
  userName: string,
  opts: { withConversation: boolean },
): string {
  const now = new Date();
  const nowLine =
    `Now: ${now.toLocaleDateString('en-US', { weekday: 'long' })}, ` +
    `${now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}, ` +
    `${dayPeriod(now.getHours())}.`;
  const diaryLayer = diaryLayerRaw
    .replaceAll('{{user}}', userName)
    .replaceAll('{{char}}', getCharName());
  return [
    renderPersona({ userName, chatId }, { now }),
    nowLine,
    renderFactsBlock(chatId, userName),
    renderMemoryBlock(chatId, userName),
    opts.withConversation ? renderConversationBlock(chatId, userName) : '',
    renderRecentEntriesBlock(),
    diaryLayer,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The ephemeral director cue (the single user turn) carrying one entry's rolled variance.
 * Sparks are explicitly optional and discardable — mandatory seeds produce visible
 * word-shoehorning. Never stored anywhere the model sees again; archived in diary_posts.cue
 * for offline debugging only.
 */
export function buildDiaryCue(userName: string, roll: EntryRoll): string {
  const focus = roll.aboutUsAllowed
    ? ''
    : `\nLeave ${userName} out of this one entirely - he doesn't appear in this entry at all, ` +
      `not even in passing. Write about something that's yours alone.`;
  const sparks = sampleSparks(config.diary.sparkCount).join(', ');
  return (
    `[Write your next diary entry. Length this time: ${roll.length}. Mood right now: ${roll.register}.${focus}\n` +
    `If nothing specific is already on your mind, here are random sparks - pick one and run with it, ` +
    `or ignore them all: ${sparks}.\n` +
    `Write the entry text only - no title, no date line, no signature.]`
  );
}

// ---- Generating & posting one entry ------------------------------------------------------------

/**
 * Generates one entry and posts it to the channel, recording it in diary_posts. Same output
 * hygiene as chat replies: finalizeReply strips a hallucinated tool tag (the diary prompt
 * offers no tools, but the persona's chat history is full of them), sanitize normalizes the
 * typography so the diary voice matches the chat voice. Throws on failure (caller recovers).
 */
async function postEntry(client: TelegramClient, chatId: number): Promise<string> {
  const channelId = config.diary.channelId;
  if (channelId === undefined) throw new Error('DIARY_CHANNEL_ID is not set');

  const userName = diaryUserName(chatId);
  const roll = rollEntry();
  const system = buildDiarySystemPrompt(chatId, userName, { withConversation: roll.aboutUsAllowed });
  const cue = buildDiaryCue(userName, roll);

  const raw = await diaryEntry(system, cue);
  const text = sanitize(finalizeReply(raw));

  const sent = await client.sendText(channelId, text);
  saveDiaryPost(text, sent.id, cue);
  log.info(
    `Posted entry [${roll.length} | ${roll.register} | aboutUs=${roll.aboutUsAllowed}]: ${text.slice(0, 80)}`,
  );
  return text;
}

// ---- The day plan & scheduler -------------------------------------------------------------------

/** Local calendar day as `YYYY-MM-DD` (the plan key). */
function dayKey(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Weighted count of entries for a fresh day: 1 (45%), 2 (40%) or 3 (15%). */
function rollDayCount(): number {
  const r = Math.random();
  return r < 0.45 ? 1 : r < 0.85 ? 2 : 3;
}

/**
 * Rolls today's due times: `count` random times in what's left of the posting window, spaced
 * at least `minGapMinutes` apart (rejection-sampled; if a count can't fit — e.g. the bot came
 * up at 21:00 and 3 gapped posts no longer do — the count drops until it fits). A day whose
 * window has fully passed yields an empty plan, which simply means "done for today".
 */
function rollDueTimes(now: Date): number[] {
  const p = config.diary;
  const start = new Date(now);
  start.setHours(p.windowStartHour, 0, 0, 0);
  const end = new Date(now);
  end.setHours(p.windowEndHour, 0, 0, 0);
  const from = Math.max(now.getTime(), start.getTime());
  const to = end.getTime();
  if (from >= to) return [];

  const gap = p.minGapMinutes * 60_000;
  for (let count = rollDayCount(); count >= 1; count--) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const times = Array.from({ length: count }, () => from + Math.random() * (to - from)).sort(
        (a, b) => a - b,
      );
      if (times.every((t, i) => i === 0 || t - times[i - 1] >= gap)) return times;
    }
  }
  return [];
}

/** Re-entrancy guard: a generation can outlast a tick; never overlap two posts. */
let posting = false;

/** One scheduler tick: roll a new day's plan if needed, then post the next due slot. */
async function tick(client: TelegramClient, chatId: number): Promise<void> {
  const now = new Date();
  const today = dayKey(now);

  let state = getDiaryState();
  if (state?.planDay !== today) {
    const dueTimes = rollDueTimes(now);
    saveDiaryPlan(today, dueTimes);
    log.info(
      `Rolled today's plan: ${dueTimes.length} entr${dueTimes.length === 1 ? 'y' : 'ies'}` +
        (dueTimes.length ? ` at ${dueTimes.map((t) => formatDateTime(t)).join(', ')}` : ''),
    );
    state = getDiaryState();
  }
  if (!state) return;

  const dueTimes = state.dueTimes ?? [];
  const idx = state.nextIdx;
  if (idx >= dueTimes.length) return;
  const due = dueTimes[idx];
  if (Date.now() < due) return;

  // Missed while the bot was down: skip rather than dump a backlog of instant posts.
  if (Date.now() - due > config.diary.graceMinutes * 60_000) {
    log.info(`Skipping stale diary slot (${formatDateTime(due)}) — missed by more than the grace period.`);
    advanceCursor(idx + 1);
    return;
  }

  if (posting) return;
  posting = true;
  try {
    await postEntry(client, chatId);
    advanceCursor(idx + 1);
  } catch (err) {
    // Cursor untouched — the slot retries next tick while it's within the grace period,
    // then ages out via the stale-skip above (so a dead channel can't wedge the plan).
    log.error('Diary post failed; will retry while the slot is fresh.', err);
  } finally {
    posting = false;
  }
}

/** Starts the diary scheduler. Call once at startup; no-op logging when prerequisites are missing. */
export function startDiaryLoop(client: TelegramClient): void {
  const p = config.diary;
  if (!p.enabled) return;
  if (p.channelId === undefined) {
    log.warn('Diary enabled but DIARY_CHANNEL_ID is not set — run /diary to list candidate channels.');
    return;
  }
  if (!config.llm.openrouter.apiKey) {
    log.warn('Diary enabled but OPENROUTER_API_KEY is missing — diary entries need OpenRouter.');
    return;
  }
  const chatId = primaryChatId();
  if (chatId === undefined) {
    log.warn('Diary enabled but the whitelist is empty — no conversation to draw context from.');
    return;
  }
  log.info(
    `Diary ON — channel ${p.channelId}, window ${p.windowStartHour}:00-${p.windowEndHour}:00, ` +
      `1-3 posts/day, min gap ${p.minGapMinutes}m, about-user chance ${p.aboutChance}.`,
  );
  setInterval(() => {
    tick(client, chatId).catch((err) => log.error('Diary tick failed:', err));
  }, p.tickMs);
}

// ---- /diary command surface ----------------------------------------------------------------------

/**
 * Channels this account can post to (creator or admin), for picking DIARY_CHANNEL_ID.
 * Iterates dialogs — cheap at personal-account scale.
 */
export async function listCandidateChannels(
  client: TelegramClient,
): Promise<{ id: number; title: string }[]> {
  const found: { id: number; title: string }[] = [];
  for await (const dialog of client.iterDialogs()) {
    const peer = dialog.peer;
    if (peer.type === 'chat' && peer.chatType === 'channel' && (peer.isCreator || peer.isAdmin)) {
      found.push({ id: peer.id, title: peer.title ?? '(untitled)' });
    }
  }
  return found;
}

/** Human-readable schedule snapshot for `/diary`. */
export function getDiaryStatus(): string {
  const p = config.diary;
  if (!p.enabled) return 'Diary is **off** (set `DIARY_ENABLED=true`).';
  if (p.channelId === undefined) {
    return 'Diary is enabled but `DIARY_CHANNEL_ID` is not set — candidates are listed below.';
  }

  const state = getDiaryState();
  const today = dayKey(new Date());
  const lines = [
    `Channel: \`${p.channelId}\` · window **${p.windowStartHour}:00-${p.windowEndHour}:00** · about-user chance **${p.aboutChance}**`,
  ];
  if (state?.planDay !== today) {
    lines.push(`Today's plan: **not rolled yet** (first tick of the day rolls it)`);
  } else {
    const dueTimes = state.dueTimes ?? [];
    const posted = Math.min(state.nextIdx, dueTimes.length);
    const planStr = dueTimes.length
      ? dueTimes.map((t, i) => (i < posted ? `~${formatDateTime(t)}~` : `**${formatDateTime(t)}**`)).join(' · ')
      : '**none** (window already passed when the day was rolled)';
    lines.push(`Today's plan: ${planStr}`, `Posted today: **${posted}/${dueTimes.length}**`);
  }
  lines.push(`Entries all-time: **${diaryPostCount()}**`);
  return lines.join('\n');
}

/**
 * Forces one entry right now (`/diary test`), bypassing and never mutating the day plan —
 * safe to run repeatedly. Returns a short confirmation with a preview.
 */
export async function runDiaryNow(client: TelegramClient): Promise<string> {
  if (!config.diary.enabled) return 'Diary is off — set `DIARY_ENABLED=true` first.';
  if (config.diary.channelId === undefined) return '`DIARY_CHANNEL_ID` is not set — run `/diary` to list candidates.';
  const chatId = primaryChatId();
  if (chatId === undefined) return 'Whitelist is empty — no conversation to draw context from.';
  try {
    const text = await postEntry(client, chatId);
    const preview = text.length > 300 ? `${text.slice(0, 300)}…` : text;
    return `Entry posted (plan unchanged):\n\n${preview}`;
  } catch (err) {
    log.error('Forced diary post failed:', err);
    return '⚠️ Post failed (see logs).';
  }
}
