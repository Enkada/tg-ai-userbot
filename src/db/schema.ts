import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Conversation memory. Every user message and AI reply is stored as one row.
 * Deletion is soft (the `deleted` flag) — `/reset` flags rows instead of removing them.
 */
export const messages = sqliteTable(
  'messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Telegram chat (peer) id the message belongs to. */
    chatId: integer('chat_id').notNull(),
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    content: text('content').notNull(),
    /**
     * Telegram message id(s) of the sent message(s), when known, as a JSON array. A reply
     * is one memory row but may be delivered as several chat bubbles when streaming splits
     * it (see {@link splitMessage}); all their ids live here so `/delete` can revoke every
     * bubble and `/reroll` / `/update` can replace the whole set. A non-streamed reply (or a
     * user message) stores a single-element array. NULL for rows written before id tracking.
     */
    tgMessageIds: text('tg_message_ids', { mode: 'json' }).$type<number[]>(),
    /**
     * Which backend generated this reply (assistant rows only; NULL for user rows and
     * for rows written before provenance tracking existed). See {@link LlmProvider}.
     */
    provider: text('provider', { enum: ['llamacpp', 'openrouter'] }),
    /**
     * The model that actually served the reply, taken from the completion response
     * (not the configured slug — OpenRouter may route `:free` requests to a different
     * served model, and a local server may have a different model loaded). NULL for
     * user rows / pre-tracking rows.
     */
    model: text('model'),
    /**
     * True when this assistant reply was sent unprompted by the proactive scheduler
     * (the bot initiating). NULL/false for user rows and ordinary reactive replies.
     * Drives the "one outstanding proactive message" guard.
     */
    proactive: integer('proactive', { mode: 'boolean' }).notNull().default(false),
    /** Soft-delete flag. Set by /reset; excluded from the context window. */
    deleted: integer('deleted', { mode: 'boolean' }).notNull().default(false),
    /** Epoch milliseconds. */
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index('idx_messages_chat').on(t.chatId, t.deleted, t.id)],
);

export type MessageRow = typeof messages.$inferSelect;

/**
 * Image attachments for a message. Each row is one image's text description (caption),
 * produced by a vision pass over the photo at receive time. Captions are kept here —
 * not baked into `messages.content` — and injected as `[image N: …]` blocks only when
 * the context window is built, so the stored user text stays clean and the captions can
 * later be trimmed from old turns without rewriting message rows.
 *
 * `idx` orders multiple images within one message (0-based). One image per message today;
 * the column is here so albums (2+ photos in one turn) drop in without a schema change.
 */
export const attachments = sqliteTable(
  'attachments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Owning message row (messages.id, NOT the Telegram message id). */
    messageId: integer('message_id')
      .notNull()
      .references(() => messages.id),
    /** Position of this image within its message, 0-based. */
    idx: integer('idx').notNull().default(0),
    /** Concise text description of the image, used in place of the pixels. */
    caption: text('caption').notNull(),
  },
  (t) => [index('idx_attachments_message').on(t.messageId)],
);

export type AttachmentRow = typeof attachments.$inferSelect;

/**
 * Web-search results for a message. Each row is one search (query + distilled summary)
 * the model ran while answering. Like {@link attachments}, the summary is kept here —
 * not baked into `messages.content` — and injected as a `[web search "…": …]` block when
 * the context window is built, placed *after* the user's text (a search is a response to
 * the question, unlike an image which precedes it in Telegram's UI).
 *
 * `idx` orders multiple searches within one turn (0-based) — the model may search more
 * than once per message (capped) when the first result isn't enough.
 */
export const searches = sqliteTable(
  'searches',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Owning message row (messages.id) — the user turn that triggered the search. */
    messageId: integer('message_id')
      .notNull()
      .references(() => messages.id),
    /** Position of this search within its message, 0-based. */
    idx: integer('idx').notNull().default(0),
    /** The query the model asked for. */
    query: text('query').notNull(),
    /** Distilled, model-readable result text (Tavily answer + compact sources). */
    summary: text('summary').notNull(),
    /** Epoch milliseconds. */
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index('idx_searches_message').on(t.messageId)],
);

export type SearchRow = typeof searches.$inferSelect;

/**
 * Per-chat scheduling state for proactive messaging. One row per chat. Kept in the DB
 * (not in process memory) so the schedule survives restarts — the scheduler reasons from
 * `dueAt`/`isMorning` rather than from in-RAM timers that reset on every reboot.
 */
export const proactiveState = sqliteTable('proactive_state', {
  /** Telegram chat (peer) id — the same key as {@link messages.chatId}. */
  chatId: integer('chat_id').primaryKey(),
  /**
   * Epoch ms when the next proactive check becomes due. NULL means "unarmed" — the next
   * daytime tick arms the morning opener; a night tick resets it to NULL so morning re-arms.
   */
  dueAt: integer('due_at'),
  /** Whether the next due check should use the "good morning" framing rather than daytime. */
  isMorning: integer('is_morning', { mode: 'boolean' }).notNull().default(false),
  /**
   * How many proactive messages the bot has sent since the user last replied, with no
   * answer. Drives the escalating cooldown (each unanswered one lengthens the next gap),
   * the hard-block cap, and the tone of the opener cue. Reset to 0 on any user activity.
   */
  ignoredCount: integer('ignored_count').notNull().default(0),
  /**
   * Dead column — the short mid-conversation "follow-up" timer was removed (it nagged more than
   * it helped; reach-outs cover continuation on a humane timescale). Kept nullable and unwritten
   * to avoid a migration; safe to drop in a future schema change.
   */
  followupDueAt: integer('followup_due_at'),
  /** Cached display name of the peer, for the {{user}} tag when generating an opener. */
  userName: text('user_name'),
  /** Epoch ms of the last update. */
  updatedAt: integer('updated_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export type ProactiveStateRow = typeof proactiveState.$inferSelect;
