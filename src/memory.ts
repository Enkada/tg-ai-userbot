import { and, asc, count, desc, eq, gte, inArray, lt } from 'drizzle-orm';
import { db } from './db/index.js';
import { attachments, messages, proactiveState, searches, summaries, summaryState } from './db/schema.js';
import type { ProactiveStateRow, SummaryStateRow } from './db/schema.js';
import type { ChatMessage } from './llm.js';
import type { ProviderId } from './providers/types.js';
import { sanitize } from './sanitize.js';

/** Minimum number of recent messages always kept in the context window. */
export const MIN_WINDOW = 60;
/** The window re-anchors (drops the oldest `STEP`) once every `STEP` new messages. */
export const STEP = 20;

/**
 * Cache-friendly window size for a conversation of `n` messages.
 *
 * Instead of a 1-message sliding window (which shifts the prompt prefix on every
 * message and forces the LLM to re-evaluate the whole conversation), the window
 * stays anchored and only grows — from `MIN_WINDOW` (60) up to `MIN_WINDOW + STEP - 1`
 * (79) — then snaps back to 60 on the 20th message. Between snaps the older messages
 * are byte-identical, so the llama.cpp KV cache is reused (≈19 cheap, 1 full recompute).
 */
export function windowSize(n: number): number {
  if (n <= MIN_WINDOW) return n;
  const k = Math.floor((n - MIN_WINDOW) / STEP);
  return n - k * STEP; // ranges 60..79
}

/** Count of non-deleted messages in a chat. */
export function messageCount(chatId: number): number {
  const row = db
    .select({ c: count() })
    .from(messages)
    .where(and(eq(messages.chatId, chatId), eq(messages.deleted, false)))
    .get();
  return row?.c ?? 0;
}

/** Provenance of an assistant reply: which backend and model produced it. */
export interface GenerationSource {
  provider: ProviderId;
  /** Served model id from the completion response, or null if the API omitted it. */
  model: string | null;
}

/**
 * Appends a message to the conversation memory. `tgMessageIds` are the Telegram id(s) of the
 * sent message(s) — one for a user message or a single-bubble reply, several when streaming
 * splits a reply into bubbles (stored so they can be revoked/replaced later). `source` records
 * which provider/model generated an assistant reply (omit for user messages). `proactive` marks
 * an assistant reply the bot sent unprompted (the initiating message). Returns the new row's id,
 * so image captions can be linked to it via {@link saveAttachment}.
 */
export function saveMessage(
  chatId: number,
  role: 'user' | 'assistant',
  content: string,
  tgMessageIds?: number[],
  source?: GenerationSource,
  proactive = false,
): number {
  const row = db
    .insert(messages)
    .values({
      chatId,
      role,
      // DB-write seam of the "anti-AI" cleanup: store the plain-keyboard form so the record
      // matches what was sent and every later reader (window, /dump, summarizer) sees it clean.
      content: sanitize(content),
      tgMessageIds,
      provider: source?.provider,
      model: source?.model,
      proactive,
    })
    .returning({ id: messages.id })
    .get();
  return row.id;
}

/**
 * Records one image's caption against a message row (see {@link saveMessage}). `idx`
 * is the image's 0-based position within the message. The caption is injected as an
 * `[image …]` block when the window is built, not stored in the message content.
 */
export function saveAttachment(messageId: number, idx: number, caption: string): void {
  db.insert(attachments).values({ messageId, idx, caption }).run();
}

/**
 * Records one web search (query + distilled summary) against a message row — the user
 * turn that triggered it (see {@link saveMessage}). `idx` is the search's 0-based position
 * within the turn (a message may trigger several, capped). The summary is injected as a
 * `[web search "…": …]` block after the message text when the window is built, not stored
 * in the message content.
 */
export function saveSearch(messageId: number, idx: number, query: string, summary: string): void {
  db.insert(searches).values({ messageId, idx, query, summary }).run();
}

/** The most recent assistant reply in a chat, or null if there is none. */
export interface LastAssistant {
  /** Row id, used to override the record in place. */
  id: number;
  content: string;
  /**
   * Telegram message id(s) of the reply's bubble(s), or null for rows saved before id
   * tracking. A single-bubble reply has one id; a streamed reply has one per bubble.
   */
  tgMessageIds: number[] | null;
}

/** Returns the latest non-deleted assistant message for a chat, or null. */
export function getLastAssistant(chatId: number): LastAssistant | null {
  const row = db
    .select({ id: messages.id, content: messages.content, tgMessageIds: messages.tgMessageIds })
    .from(messages)
    .where(
      and(eq(messages.chatId, chatId), eq(messages.role, 'assistant'), eq(messages.deleted, false)),
    )
    .orderBy(desc(messages.id))
    .limit(1)
    .get();
  return row ?? null;
}

/**
 * Returns the role of the latest non-deleted message in a chat, or null if empty.
 * Used to confirm a `/reroll` would actually regenerate the most recent turn (the
 * last row is an assistant reply) rather than overwrite an older one.
 */
export function getLastRole(chatId: number): 'user' | 'assistant' | null {
  const row = db
    .select({ role: messages.role })
    .from(messages)
    .where(and(eq(messages.chatId, chatId), eq(messages.deleted, false)))
    .orderBy(desc(messages.id))
    .limit(1)
    .get();
  return row?.role ?? null;
}

/** Role + proactive flag of the latest non-deleted message in a chat, or null if empty. */
export interface LastMessageMeta {
  role: 'user' | 'assistant';
  /** True when that last message is an unprompted (proactive) assistant reply. */
  proactive: boolean;
}

/**
 * Returns the role + proactive flag of the most recent non-deleted message. The proactive
 * scheduler uses this as its "one outstanding message" guard: if the last message is an
 * unanswered proactive reply, it won't send another until the user replies.
 */
export function getLastMessageMeta(chatId: number): LastMessageMeta | null {
  const row = db
    .select({ role: messages.role, proactive: messages.proactive })
    .from(messages)
    .where(and(eq(messages.chatId, chatId), eq(messages.deleted, false)))
    .orderBy(desc(messages.id))
    .limit(1)
    .get();
  return row ?? null;
}

/** Epoch ms of the latest non-deleted *user* message in a chat, or null if there is none. */
export function getLastUserMessageAt(chatId: number): number | null {
  const row = db
    .select({ at: messages.createdAt })
    .from(messages)
    .where(
      and(eq(messages.chatId, chatId), eq(messages.role, 'user'), eq(messages.deleted, false)),
    )
    .orderBy(desc(messages.id))
    .limit(1)
    .get();
  return row?.at ?? null;
}

/** Fields of a chat's proactive schedule that callers may update. */
export interface ProactivePatch {
  /** Epoch ms the next check is due, or null to "unarm" (re-arm at next morning). */
  dueAt?: number | null;
  isMorning?: boolean;
  /** Consecutive ignored reach-outs since the user last replied (escalation counter). */
  ignoredCount?: number;
  userName?: string | null;
}

/** Current proactive schedule for a chat, or null if none has been recorded yet. */
export function getProactiveState(chatId: number): ProactiveStateRow | null {
  const row = db
    .select()
    .from(proactiveState)
    .where(eq(proactiveState.chatId, chatId))
    .limit(1)
    .get();
  return row ?? null;
}

/** Inserts or updates a chat's proactive schedule, touching only the provided fields. */
export function upsertProactiveState(chatId: number, patch: ProactivePatch): void {
  const now = Date.now();
  db.insert(proactiveState)
    .values({ chatId, ...patch, updatedAt: now })
    .onConflictDoUpdate({ target: proactiveState.chatId, set: { ...patch, updatedAt: now } })
    .run();
}

/**
 * Overrides the content of an existing message row in place (no new row is created).
 * The `source` argument controls provenance:
 * - a {@link GenerationSource} → set provider/model (a `/reroll` regenerated the reply);
 * - `null` → clear provider/model (a manual `/update` — the text is now human-authored);
 * - omitted → leave provenance unchanged.
 * `tgMessageIds`, when given, replaces the stored bubble id(s) — `/reroll` and `/update`
 * revoke the old bubbles and send fresh ones, so the row must point at the new messages.
 */
export function updateMessageContent(
  id: number,
  content: string,
  source?: GenerationSource | null,
  tgMessageIds?: number[],
): void {
  const clean = sanitize(content);
  const patch: Record<string, unknown> =
    source === undefined
      ? { content: clean }
      : { content: clean, provider: source?.provider ?? null, model: source?.model ?? null };
  if (tgMessageIds !== undefined) patch.tgMessageIds = tgMessageIds;
  db.update(messages).set(patch).where(eq(messages.id, id)).run();
}

/**
 * Renders a message's image captions as `[image …]` block(s), prepended above its text.
 * A single image gets `[image: …]`; multiple are numbered `[image 1: …]`, `[image 2: …]`.
 */
function withCaptions(content: string, captions: string[]): string {
  if (captions.length === 0) return content;
  const blocks = captions
    .map((c, i) => (captions.length === 1 ? `[image: ${c}]` : `[image ${i + 1}: ${c}]`))
    .join('\n');
  // Photo-only messages have empty content — then the blocks are the whole turn.
  return content ? `${blocks}\n${content}` : blocks;
}

/** One search's query + distilled summary, for injecting into the window. */
export interface SearchEntry {
  query: string;
  summary: string;
}

/**
 * Appends a message's web-search results as `[web search "query": …]` block(s) *after*
 * its text — a search answers the question, so it follows it (unlike an image caption,
 * which precedes the text to mirror Telegram's UI order). Exported so the proactive
 * opener's in-memory tool loop renders search blocks in the exact same format.
 */
export function withSearches(content: string, results: SearchEntry[]): string {
  if (results.length === 0) return content;
  const blocks = results.map((r) => `[web search "${r.query}":\n${r.summary}]`).join('\n');
  return content ? `${content}\n${blocks}` : blocks;
}

/** Returns the current context window (oldest → newest) for a chat. */
export function getWindow(chatId: number): ChatMessage[] {
  const take = windowSize(messageCount(chatId));
  if (take === 0) return [];

  const rows = db
    .select({ id: messages.id, role: messages.role, content: messages.content })
    .from(messages)
    .where(and(eq(messages.chatId, chatId), eq(messages.deleted, false)))
    .orderBy(desc(messages.id))
    .limit(take)
    .all();
  rows.reverse();

  const ids = rows.map((r) => r.id);

  // Pull the captions for the windowed messages in one query and group them by message.
  const captionsByMessage = new Map<number, string[]>();
  const atts = db
    .select({ messageId: attachments.messageId, caption: attachments.caption })
    .from(attachments)
    .where(inArray(attachments.messageId, ids))
    .orderBy(asc(attachments.messageId), asc(attachments.idx))
    .all();
  for (const a of atts) {
    const list = captionsByMessage.get(a.messageId);
    if (list) list.push(a.caption);
    else captionsByMessage.set(a.messageId, [a.caption]);
  }

  // Same for web-search results, grouped by message and ordered within each message.
  const searchesByMessage = new Map<number, SearchEntry[]>();
  const srch = db
    .select({ messageId: searches.messageId, query: searches.query, summary: searches.summary })
    .from(searches)
    .where(inArray(searches.messageId, ids))
    .orderBy(asc(searches.messageId), asc(searches.idx))
    .all();
  for (const s of srch) {
    const entry = { query: s.query, summary: s.summary };
    const list = searchesByMessage.get(s.messageId);
    if (list) list.push(entry);
    else searchesByMessage.set(s.messageId, [entry]);
  }

  return rows.map(({ id, role, content }) => ({
    role,
    // Captions precede the text; search results follow it. Sanitize the composed turn (window-
    // build seam of the cleanup) so legacy rows from before the feature — and the typographic
    // tells in model-written captions / external search text — reach the LLM in plain form too.
    content: sanitize(
      withSearches(
        withCaptions(content, captionsByMessage.get(id) ?? []),
        searchesByMessage.get(id) ?? [],
      ),
    ),
  }));
}

export interface WindowInfo {
  /** Total non-deleted messages stored. */
  total: number;
  /** Messages currently included in the context window. */
  windowCount: number;
  /**
   * New messages until the window next re-anchors (snaps the oldest `STEP` out and
   * forces a full KV-cache recompute). Counts down from `STEP` to 1.
   */
  untilReanchor: number;
}

export function getWindowInfo(chatId: number): WindowInfo {
  const total = messageCount(chatId);
  // The window grows 1-per-message from MIN_WINDOW up to MIN_WINDOW+STEP-1, then snaps
  // back. `untilReanchor` is how many more messages until that snap (always 1..STEP).
  const untilReanchor = STEP - ((((total - MIN_WINDOW) % STEP) + STEP) % STEP);
  return { total, windowCount: windowSize(total), untilReanchor };
}

/** Outcome of {@link deleteLastMessages}. */
export interface DeleteResult {
  /** How many memory rows were flagged deleted. */
  flagged: number;
  /** Telegram message ids of every bubble of the flagged rows (for revoking them in the chat). */
  tgMessageIds: number[];
}

/**
 * Soft-deletes the last `n` (non-deleted) messages of a chat — same `deleted` flag as
 * /reset, nothing is physically removed. Returns the count flagged and the Telegram ids
 * to revoke in the chat — every bubble of each row, since a streamed reply spans several
 * (rows without stored ids, if any, are flagged but not revokable).
 */
export function deleteLastMessages(chatId: number, n: number): DeleteResult {
  const rows = db
    .select({ id: messages.id, tgMessageIds: messages.tgMessageIds })
    .from(messages)
    .where(and(eq(messages.chatId, chatId), eq(messages.deleted, false)))
    .orderBy(desc(messages.id))
    .limit(n)
    .all();
  if (rows.length === 0) return { flagged: 0, tgMessageIds: [] };

  db.update(messages)
    .set({ deleted: true })
    .where(inArray(messages.id, rows.map((r) => r.id)))
    .run();

  const tgMessageIds = rows.flatMap((r) => r.tgMessageIds ?? []);
  return { flagged: rows.length, tgMessageIds };
}

// ---- Long-term memory: per-day summaries ------------------------------------------------

/**
 * All non-deleted messages of a chat in the logical-day range `[start, end)` (oldest → newest),
 * with image captions and web-search results rendered inline exactly as in {@link getWindow}.
 * Unlike `getWindow` this is uncapped — a whole day, however long — because it feeds the
 * summarizer, not the live context window.
 */
export function getDayMessages(chatId: number, start: number, end: number): ChatMessage[] {
  const rows = db
    .select({ id: messages.id, role: messages.role, content: messages.content })
    .from(messages)
    .where(
      and(
        eq(messages.chatId, chatId),
        eq(messages.deleted, false),
        gte(messages.createdAt, start),
        lt(messages.createdAt, end),
      ),
    )
    .orderBy(asc(messages.id))
    .all();
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);

  const captionsByMessage = new Map<number, string[]>();
  for (const a of db
    .select({ messageId: attachments.messageId, caption: attachments.caption })
    .from(attachments)
    .where(inArray(attachments.messageId, ids))
    .orderBy(asc(attachments.messageId), asc(attachments.idx))
    .all()) {
    const list = captionsByMessage.get(a.messageId);
    if (list) list.push(a.caption);
    else captionsByMessage.set(a.messageId, [a.caption]);
  }

  const searchesByMessage = new Map<number, SearchEntry[]>();
  for (const s of db
    .select({ messageId: searches.messageId, query: searches.query, summary: searches.summary })
    .from(searches)
    .where(inArray(searches.messageId, ids))
    .orderBy(asc(searches.messageId), asc(searches.idx))
    .all()) {
    const entry = { query: s.query, summary: s.summary };
    const list = searchesByMessage.get(s.messageId);
    if (list) list.push(entry);
    else searchesByMessage.set(s.messageId, [entry]);
  }

  return rows.map(({ id, role, content }) => ({
    role,
    // Same window-build cleanup as getWindow: hand the summarizer plain-keyboard text.
    content: sanitize(
      withSearches(
        withCaptions(content, captionsByMessage.get(id) ?? []),
        searchesByMessage.get(id) ?? [],
      ),
    ),
  }));
}

/** Count of non-deleted messages in a chat within the logical-day range `[start, end)`. */
export function messageCountInRange(chatId: number, start: number, end: number): number {
  const row = db
    .select({ c: count() })
    .from(messages)
    .where(
      and(
        eq(messages.chatId, chatId),
        eq(messages.deleted, false),
        gte(messages.createdAt, start),
        lt(messages.createdAt, end),
      ),
    )
    .get();
  return row?.c ?? 0;
}

/** True if a summary row already exists for this chat/level/period (regardless of soft-delete). */
export function summaryExists(chatId: number, level: number, periodStart: number): boolean {
  const row = db
    .select({ c: count() })
    .from(summaries)
    .where(
      and(
        eq(summaries.chatId, chatId),
        eq(summaries.level, level),
        eq(summaries.periodStart, periodStart),
      ),
    )
    .get();
  return (row?.c ?? 0) > 0;
}

/** Inserts one summary row. */
export function saveSummary(
  chatId: number,
  level: number,
  periodStart: number,
  periodEnd: number,
  content: string,
): void {
  db.insert(summaries).values({ chatId, level, periodStart, periodEnd, content }).run();
}

/** One stored summary, for injection into the system prompt. */
export interface SummaryEntry {
  periodStart: number;
  content: string;
}

/**
 * The newest `limit` level-0 (daily) summaries for a chat, returned oldest → newest so they
 * read chronologically when stacked in the `# Memory` block. Excludes soft-deleted rows.
 */
export function getRecentSummaries(chatId: number, limit: number): SummaryEntry[] {
  const rows = db
    .select({ periodStart: summaries.periodStart, content: summaries.content })
    .from(summaries)
    .where(
      and(eq(summaries.chatId, chatId), eq(summaries.level, 0), eq(summaries.deleted, false)),
    )
    .orderBy(desc(summaries.periodStart))
    .limit(limit)
    .all();
  rows.reverse();
  return rows;
}

/** Current summary-scheduler state for a chat, or null if none has been recorded yet. */
export function getSummaryState(chatId: number): SummaryStateRow | null {
  return (
    db.select().from(summaryState).where(eq(summaryState.chatId, chatId)).limit(1).get() ?? null
  );
}

/** Advances the scheduler cursor (`lastDoneStart`) for a chat. */
export function setSummaryCursor(chatId: number, lastDoneStart: number): void {
  const now = Date.now();
  db.insert(summaryState)
    .values({ chatId, lastDoneStart, updatedAt: now })
    .onConflictDoUpdate({ target: summaryState.chatId, set: { lastDoneStart, updatedAt: now } })
    .run();
}

/**
 * Caches the peer's display name for the summarizer, without touching the scheduler cursor.
 * Called on every incoming message (independent of the proactive feature) so the off-line
 * summary job can name the user even when proactivity is off.
 */
export function rememberUserName(chatId: number, userName: string): void {
  const now = Date.now();
  db.insert(summaryState)
    .values({ chatId, userName, updatedAt: now })
    .onConflictDoUpdate({ target: summaryState.chatId, set: { userName, updatedAt: now } })
    .run();
}

/**
 * Soft-deletes all messages for a chat (sets `deleted`), and the chat's summaries with them —
 * a reset wipes recalled long-term memory too, not just the live window. Returns how many
 * message rows were flagged (the figure /reset reports).
 */
export function resetMemory(chatId: number): number {
  const res = db
    .update(messages)
    .set({ deleted: true })
    .where(and(eq(messages.chatId, chatId), eq(messages.deleted, false)))
    .run();
  db.update(summaries)
    .set({ deleted: true })
    .where(and(eq(summaries.chatId, chatId), eq(summaries.deleted, false)))
    .run();
  return res.changes;
}
