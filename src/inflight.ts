/**
 * Per-chat in-flight generation registry — the handle `/stop` reaches for.
 *
 * A reply is generated inside the chat's queue (see {@link import('./queue.js')}), so a `/stop`
 * that waited its turn would only run *after* the generation it means to interrupt. Instead the
 * dispatcher handles `/stop` out-of-band and calls {@link stopInFlight}, which trips the live
 * generation directly: it aborts the model's SSE call (stopping the token spend) and flips the
 * streamer's stop flag (no further bubbles). Whatever already reached the chat is kept and
 * persisted by the generation's own partial-failure path.
 *
 * Only one generation runs per chat at a time (the queue guarantees it), so a single entry per
 * chat suffices. The handle identity is checked on clear so a finished generation never wipes a
 * newer one that took its place.
 */

/** A live generation's stop levers: abort the model call, and stop the bubble stream. */
export interface InFlightHandle {
  /** Aborts the in-flight model SSE call (rejects it with an `AbortError`). */
  controller: AbortController;
  /** Stops the reply streamer from sending any further bubbles. */
  stop: () => void;
}

const inFlight = new Map<number, InFlightHandle>();

/** Registers the chat's current generation as interruptible. Returns the handle (for {@link clearInFlight}). */
export function registerInFlight(chatId: number, handle: InFlightHandle): InFlightHandle {
  inFlight.set(chatId, handle);
  return handle;
}

/** Clears the chat's registration once its generation ends — but only if `handle` is still the current one. */
export function clearInFlight(chatId: number, handle: InFlightHandle): void {
  if (inFlight.get(chatId) === handle) inFlight.delete(chatId);
}

/**
 * Stops the chat's in-flight generation, if any: aborts the model call and halts the bubble
 * stream. Returns true when there was something to stop. Idempotent — the entry is removed, so a
 * second `/stop` is a no-op.
 */
export function stopInFlight(chatId: number): boolean {
  const handle = inFlight.get(chatId);
  if (!handle) return false;
  inFlight.delete(chatId);
  handle.stop();
  handle.controller.abort();
  return true;
}
