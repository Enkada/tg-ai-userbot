/**
 * Human pacing for incoming messages — two silent waits that make the bot read and answer
 * like a person who isn't glued to the chat:
 *
 *  - **Read delay** (before the read receipt): models attention. If the chat was active
 *    moments ago she's holding the phone and reads instantly; the longer the conversation
 *    has been idle, the longer she takes to come back to it. The delay follows a square
 *    root of how far the idle gap has run from `thresholdMinutes` toward `fullAtMinutes`
 *    (where `capSeconds` is reached), so it ramps smoothly from zero with no visible seam,
 *    with ±30% jitter so equal gaps never produce equal delays. Past a ~10-minute gap
 *    there's a small chance the curve is discarded for a 2–3s read anyway — she happened
 *    to have the phone in hand — the outlier that keeps long-gap reads from feeling like
 *    a mechanical meter.
 *
 *  - **Read→typing pause** (after the read receipt, before the typing indicator): time
 *    spent actually reading the message, so the receipt and "typing…" never appear in the
 *    same instant. Nothing is shown during it. For photos the vision pass runs inside this
 *    phase instead — see {@link photoBeatMs}.
 *
 * Callers subtract time a message already spent waiting (queue, reconnect backlog) so an
 * already-late read is never padded further — same principle as bubble pacing in send.ts.
 */
import { config } from './config.js';

/** ±fraction of jitter applied to the read-delay curve. */
const JITTER = 0.3;
/** Idle gap (minutes) past which the phone-in-hand outlier may fire (below it the curve is ≤~3s anyway). */
const INSTANT_GATE_MINUTES = 10;
/** The outlier read delay: she had the phone, it just took a moment to open the chat. */
const INSTANT_MIN_MS = 2_000;
const INSTANT_MAX_MS = 3_000;
/** The silent "looking at the photo" beat — the floor under a suspiciously fast caption pass. */
const PHOTO_BEAT_MIN_MS = 1_000;
const PHOTO_BEAT_MAX_MS = 2_000;

/** Uniform random ms in [min, max]. */
function uniformMs(minMs: number, maxMs: number): number {
  return minMs + Math.random() * (maxMs - minMs);
}

/** Promise-based sleep; zero or negative resolves immediately. */
export const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/**
 * Read delay (ms) for a message arriving `idleMs` after the chat's previous message
 * (either side — her own proactive opener resets the clock too). Zero within the
 * threshold: you're both actively in the chat.
 */
export function readDelayMs(idleMs: number): number {
  const { thresholdMinutes, capSeconds, fullAtMinutes, instantChance } = config.pacing;
  const idleMin = idleMs / 60_000;
  if (idleMin <= thresholdMinutes) return 0;
  if (idleMin > INSTANT_GATE_MINUTES && Math.random() < instantChance) {
    return uniformMs(INSTANT_MIN_MS, INSTANT_MAX_MS);
  }
  const capMs = capSeconds * 1_000;
  const frac = Math.min(1, (idleMin - thresholdMinutes) / Math.max(1, fullAtMinutes - thresholdMinutes));
  const jitter = 1 - JITTER + Math.random() * 2 * JITTER;
  return Math.min(capMs, capMs * Math.sqrt(frac) * jitter);
}

/**
 * The silent read→typing pause (ms) for a text of `length` chars: base + per-char at a
 * fast-skim reading pace, capped.
 */
export function readPauseMs(length: number): number {
  const { pauseBaseMs, pausePerCharMs, pauseMaxMs } = config.pacing;
  return Math.min(pauseMaxMs, pauseBaseMs + length * pausePerCharMs);
}

/**
 * Target duration (ms) of the silent "looking at the photo" phase. The vision pass runs
 * inside it, so its real latency is absorbed rather than stacked: the caller waits only
 * the remainder — effectively max(caption pass, this beat).
 */
export function photoBeatMs(): number {
  return uniformMs(PHOTO_BEAT_MIN_MS, PHOTO_BEAT_MAX_MS);
}
