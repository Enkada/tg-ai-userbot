import { and, asc, count, desc, eq, inArray } from 'drizzle-orm';
import { db } from './db/index.js';
import { attachments, messages, proactiveState, searches } from './db/schema.js';
import type { ProactiveStateRow } from './db/schema.js';
import type { ChatMessage } from './llm.js';
import type { ProviderId } from './providers/types.js';

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
 * Appends a message to the conversation memory. `tgMessageId` is the Telegram id of
 * the sent message (stored for assistant replies so they can be edited later). `source`
 * records which provider/model generated an assistant reply (omit for user messages).
 * `proactive` marks an assistant reply the bot sent unprompted (the initiating message).
 * Returns the new row's id, so image captions can be linked to it via {@link saveAttachment}.
 */
export function saveMessage(
  chatId: number,
  role: 'user' | 'assistant',
  content: string,
  tgMessageId?: number,
  source?: GenerationSource,
  proactive = false,
): number {
  const row = db
    .insert(messages)
    .values({
      chatId,
      role,
      content,
      tgMessageId,
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
  /** Telegram message id of the reply, or null for rows saved before it was tracked. */
  tgMessageId: number | null;
}

/** Returns the latest non-deleted assistant message for a chat, or null. */
export function getLastAssistant(chatId: number): LastAssistant | null {
  const row = db
    .select({ id: messages.id, content: messages.content, tgMessageId: messages.tgMessageId })
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
  /** Epoch ms a follow-up is due, or null to clear it (consumed / no follow-up pending). */
  followupDueAt?: number | null;
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
 */
export function updateMessageContent(
  id: number,
  content: string,
  source?: GenerationSource | null,
): void {
  const patch =
    source === undefined
      ? { content }
      : { content, provider: source?.provider ?? null, model: source?.model ?? null };
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
    // Captions precede the text; search results follow it.
    content: withSearches(
      withCaptions(content, captionsByMessage.get(id) ?? []),
      searchesByMessage.get(id) ?? [],
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
  /** Telegram message ids of the flagged rows (for revoking them in the chat). */
  tgMessageIds: number[];
}

/**
 * Soft-deletes the last `n` (non-deleted) messages of a chat — same `deleted` flag as
 * /reset, nothing is physically removed. Returns the count flagged and the Telegram ids
 * to revoke in the chat (rows without a stored id, if any, are flagged but not revokable).
 */
export function deleteLastMessages(chatId: number, n: number): DeleteResult {
  const rows = db
    .select({ id: messages.id, tgMessageId: messages.tgMessageId })
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

  const tgMessageIds = rows
    .map((r) => r.tgMessageId)
    .filter((id): id is number => id !== null);
  return { flagged: rows.length, tgMessageIds };
}

/** Soft-deletes all messages for a chat (sets `deleted`). Returns how many were flagged. */
export function resetMemory(chatId: number): number {
  const res = db
    .update(messages)
    .set({ deleted: true })
    .where(and(eq(messages.chatId, chatId), eq(messages.deleted, false)))
    .run();
  return res.changes;
}
