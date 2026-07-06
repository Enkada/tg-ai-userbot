import { tl, type InputPeerLike, type InputText, type TelegramClient } from '@mtcute/node';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from './db/index.js';
import { commandDebris } from './db/schema.js';

/**
 * Ephemeral command output ("the panel") and its janitorial state.
 *
 * Every slash command renders its result into a single reusable message per chat — the
 * panel — edited in place, so consecutive commands never stack output. The panel, any
 * `/dump` file messages, and the user's own `/command` messages are tracked as debris
 * rows in the DB (see {@link commandDebris}); the next normal message sweeps them all
 * away. Because the state is persisted, a restart can't orphan anything: whatever the
 * old process left behind is collected on the next interaction, and a surviving panel
 * is simply picked up and edited by the next command.
 */

type DebrisKind = 'panel' | 'file' | 'command';

/** Telegram's per-call cap on deleteMessages ids. */
const DELETE_CHUNK = 100;

/** Records one chat message as command debris, to be revoked by a later sweep. */
export function trackDebris(chatId: number, tgMessageId: number, kind: DebrisKind): void {
  db.insert(commandDebris).values({ chatId, tgMessageId, kind }).run();
}

/**
 * Releases one tracked message after it was successfully revoked. Call only when the
 * revoke didn't throw — on failure the row must stay so the next sweep retries.
 */
export function untrackDebris(chatId: number, tgMessageId: number): void {
  db.delete(commandDebris)
    .where(and(eq(commandDebris.chatId, chatId), eq(commandDebris.tgMessageId, tgMessageId)))
    .run();
}

/**
 * Drops a chat's debris rows without touching Telegram. For `/nuke`: the messages died
 * with the history wipe, so only the bookkeeping is left to clear.
 */
export function forgetDebris(chatId: number): void {
  db.delete(commandDebris).where(eq(commandDebris.chatId, chatId)).run();
}

/** The chat's panel row (the one editable output message), if a panel currently exists. */
function getPanelRow(chatId: number): { id: number; tgMessageId: number } | undefined {
  return db
    .select({ id: commandDebris.id, tgMessageId: commandDebris.tgMessageId })
    .from(commandDebris)
    .where(and(eq(commandDebris.chatId, chatId), eq(commandDebris.kind, 'panel')))
    .limit(1)
    .get();
}

/**
 * Renders command output into the chat's panel message: edits the existing panel in
 * place, or sends a fresh one (and tracks it) when there is none. If the edit is
 * rejected because the content is identical, that's success — the panel already shows
 * it. Any other edit failure (Telegram's 48h edit limit, the panel deleted by hand)
 * falls back to replacing the panel with a new message.
 */
export async function showPanel(
  client: TelegramClient,
  peer: InputPeerLike,
  chatId: number,
  content: InputText,
): Promise<void> {
  const panel = getPanelRow(chatId);
  if (panel) {
    try {
      await client.editMessage({ chatId: peer, message: panel.tgMessageId, text: content });
      return;
    } catch (err) {
      if (err instanceof tl.RpcError && err.is('MESSAGE_NOT_MODIFIED')) return;
      // The old panel can't be edited — demote its row to `file` (plain sweepable junk,
      // no longer *the* panel) before replacing it, so even if the immediate revoke
      // fails the message stays collectable by a later sweep instead of being orphaned.
      db.update(commandDebris).set({ kind: 'file' }).where(eq(commandDebris.id, panel.id)).run();
      try {
        await client.deleteMessagesById(peer, [panel.tgMessageId], { revoke: true });
        db.delete(commandDebris).where(eq(commandDebris.id, panel.id)).run();
      } catch {
        // Keep the demoted row; the next sweep retries the revoke.
      }
    }
  }
  const sent = await client.sendText(peer, content);
  trackDebris(chatId, sent.id, 'panel');
}

/**
 * Revokes the chat's panel message (if any). Used by commands whose success output is
 * the conversation itself — `/reroll`, `/update` — where leftover panel content (say, a
 * `/prompt` dump) should vanish at the moment the new reply lands.
 */
export async function dropPanel(
  client: TelegramClient,
  peer: InputPeerLike,
  chatId: number,
): Promise<void> {
  const panel = getPanelRow(chatId);
  if (!panel) return;
  try {
    await client.deleteMessagesById(peer, [panel.tgMessageId], { revoke: true });
    db.delete(commandDebris).where(eq(commandDebris.id, panel.id)).run();
  } catch {
    // Revoke failed (network/flood) — keep the row; a later sweep retries.
  }
}

/**
 * Revokes and forgets a chat's tracked debris — all kinds by default, or only the given
 * ones (command dispatch sweeps `file` + `command` leftovers but keeps the panel to edit
 * it in place). Rows are released only after Telegram accepted the revoke; on failure
 * they stay so the next sweep retries. Revoking an id that's already gone is a no-op on
 * Telegram's side, so retries and stale rows are harmless.
 */
export async function sweepDebris(
  client: TelegramClient,
  peer: InputPeerLike,
  chatId: number,
  kinds?: DebrisKind[],
): Promise<void> {
  const rows = db
    .select({ id: commandDebris.id, tgMessageId: commandDebris.tgMessageId })
    .from(commandDebris)
    .where(
      and(
        eq(commandDebris.chatId, chatId),
        kinds ? inArray(commandDebris.kind, kinds) : undefined,
      ),
    )
    .all();
  if (rows.length === 0) return;

  try {
    const ids = rows.map((r) => r.tgMessageId);
    for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
      await client.deleteMessagesById(peer, ids.slice(i, i + DELETE_CHUNK), { revoke: true });
    }
    db.delete(commandDebris)
      .where(inArray(commandDebris.id, rows.map((r) => r.id)))
      .run();
  } catch {
    // Revoke failed partway — keep the unreleased rows; the next sweep retries them.
  }
}
