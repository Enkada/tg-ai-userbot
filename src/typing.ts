import type { InputPeerLike, TelegramClient } from '@mtcute/node';

/** Interval (ms) for resending the typing action. Telegram clears it after ~6s. */
const TYPING_INTERVAL_MS = 5000;

/**
 * Runs `fn` while continuously showing the "typing..." status in the given chat.
 * The status is refreshed every ~5s and cancelled when the work finishes (sending
 * a message also clears it on Telegram's side).
 */
export async function withTyping<T>(
  client: TelegramClient,
  peerId: InputPeerLike,
  fn: () => Promise<T>,
): Promise<T> {
  const tick = () => void client.sendTyping(peerId, 'typing').catch(() => {});
  tick();
  const interval = setInterval(tick, TYPING_INTERVAL_MS);
  try {
    return await fn();
  } finally {
    clearInterval(interval);
  }
}
