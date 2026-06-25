/**
 * Proactive messaging — the bot initiating conversation on its own, instead of only
 * replying. A periodic tick evaluates each chat's schedule (kept in the DB so it survives
 * restarts).
 *
 *  - **Reach-outs**: an always-on good-morning greeting (random time in the morning window),
 *    then daytime openers on an *escalating cooldown* — the first comes a base gap after the
 *    user goes quiet, and every reach-out that goes unanswered lengthens the next gap and
 *    bumps an `ignoredCount`. After `maxIgnored` unanswered ones she goes fully silent until
 *    the user replies (which resets the count). No yes/no model call gates this — ignoring is
 *    itself the "stop" signal, via the escalation.
 *
 * The *first* reach-out since the user last replied is deliberately time-agnostic — it never
 * mentions the silence, it just opens a thread, the way a real person fires off a random text
 * in a lull. Only from the 2nd unanswered one on does the cue let her notice she's been left
 * on read, and even then lightly. The escalating gap is a scheduling mechanism, kept separate
 * from tone: she isn't told which attempt this is, only whether a prior one went unanswered.
 *
 * Openers are generated through the normal persona path (full in-character generation with an
 * ephemeral director cue), never a flattened control-flow prompt. The cue is a stage direction
 * — motivation and constraints only — and must never assert facts about who she is (body, day,
 * activities); that's persona.txt's job exclusively.
 */
import type { InputPeerLike, TelegramClient } from '@mtcute/node';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { enqueue } from './queue.js';
import { renderSystemPrompt } from './prompt.js';
import { activeProviderId, type ChatResult } from './llm.js';
import { ephemeralSearchStrategy, generateReply } from './generate.js';
import {
  getLastUserMessageAt,
  getProactiveState,
  saveMessage,
  upsertProactiveState,
} from './memory.js';
import { finalizeReply } from './tools.js';
import { ReplyStreamer } from './send.js';
import { withTyping } from './typing.js';

const log = createLogger('proactive');

type Framing = 'morning' | 'daytime';

// ---- Scheduling helpers ------------------------------------------------------------------

/**
 * A random epoch-ms due time for the next reach-out. `ignored` is how many reach-outs have
 * already gone unanswered: the gap is the base silence range plus one escalation step per
 * ignored one, so it stretches out the longer she's been left on read.
 */
function nextSilenceDue(ignored: number): number {
  const { silenceMinMinutes, silenceMaxMinutes, silenceSkew, escalationStepMinutes } = config.proactive;
  // Right-skewed pick across the base range: random()**skew (skew > 1) clusters the gap toward
  // the short end with a long tail toward the max, so most first reach-outs land sooner but some
  // give hours of breathing room — burstier and less learnable than a flat random.
  const span = silenceMaxMinutes - silenceMinMinutes;
  const base = silenceMinMinutes + span * Math.pow(Math.random(), silenceSkew);
  const minutes = base + Math.max(0, ignored) * escalationStepMinutes;
  return Date.now() + minutes * 60_000;
}

/** A random epoch-ms time within today's morning window, never earlier than now. */
function morningDueAt(now: Date): number {
  const { morningStartHour, morningEndHour } = config.proactive;
  const start = new Date(now);
  start.setHours(morningStartHour, 0, 0, 0);
  const end = new Date(now);
  end.setHours(morningEndHour, 0, 0, 0);
  const at = start.getTime() + Math.random() * (end.getTime() - start.getTime());
  return Math.max(at, now.getTime());
}

/** Hours since the user's last message (large sentinel when there's no user message yet). */
function hoursSinceLastUser(chatId: number): number {
  const at = getLastUserMessageAt(chatId);
  if (at == null) return 99;
  return Math.max(0, (Date.now() - at) / 3_600_000);
}

// ---- Generating & sending an opener ------------------------------------------------------

/**
 * Builds the ephemeral director cue for a reach-out (appended as a user turn to the generation
 * window, never stored). `attempt` is which reach-out this is since the user last replied (1 =
 * first). The first is time-agnostic — it never mentions the silence; from the 2nd unanswered
 * one on, the cue lets her notice she's been left on read, lightly. The exact hour-count and
 * attempt number are deliberately *not* fed in — only the on/off "a prior one went unanswered"
 * — to keep tone from fixating on time (a dedicated time-sense system can do that later).
 */
function buildReachoutCue(framing: Framing, attempt: number, userName: string): string {
  if (framing === 'morning') {
    return (
      `[System note: it's morning and ${userName} hasn't messaged yet — you're reaching out first. ` +
      `Greet them warmly and gently start the day. Keep it short and natural, like a real text.]`
    );
  }
  if (attempt <= 1) {
    // First opener since they last replied: just start a thread, the way someone fires off a
    // random text in a lull. No mention of time or them being away — substrate-neutral so it
    // never asserts anything persona.txt is meant to own.
    return (
      `[System note: there's a natural lull — you're messaging ${userName} first, on your own ` +
      `initiative. Open with whatever feels natural: something on your mind, a question for them, ` +
      `or pick a previous thread back up. Don't comment on them being quiet or slow to reply — ` +
      `just start, like a normal text. Keep it short.]`
    );
  }
  // A prior reach-out has gone unanswered: she may let that show, but lightly — it's flavor,
  // not the whole message, and it shouldn't fixate.
  return (
    `[System note: you already reached out a little while ago and ${userName} still hasn't replied. ` +
    `You can let that show a little — mildly curious, wry, or playfully impatient, however fits you ` +
    `— but don't dwell on it or make it the whole message; vary how you put it and mostly just keep ` +
    `trying to reach them. Keep it short.]`
  );
}

/**
 * Generates an opener in-character (against the given cue) and sends it, persisting it as a
 * proactive assistant message. The cue is injected only into the in-memory generation array —
 * never stored — so it can't pollute the user-activity timer or future context; the opener may
 * still run the `web_search` tool, with the search held in memory only (see
 * {@link ephemeralSearchStrategy}). Throws on failure (the caller decides how to recover).
 */
async function sendOpener(
  client: TelegramClient,
  chatId: number,
  cue: string,
  userName: string,
  label: string,
): Promise<void> {
  const systemPrompt = renderSystemPrompt({ userName });
  const peer: InputPeerLike = chatId;
  const streamer = new ReplyStreamer(client, peer);
  let reply: ChatResult;
  try {
    reply = await withTyping(client, peer, () =>
      generateReply(systemPrompt, ephemeralSearchStrategy(chatId, cue), label, streamer),
    );
  } catch (err) {
    // If bubbles already streamed, persist them (proactive flag) so the "one outstanding
    // proactive message" guard stays consistent with the chat, then rethrow for the caller.
    const partialText = finalizeReply(streamer.streamedText);
    if (streamer.ids.length > 0 && partialText) {
      saveMessage(chatId, 'assistant', partialText, streamer.ids, { provider: activeProviderId(), model: null }, true);
    }
    throw err;
  }
  const text = finalizeReply(reply.content);
  const sentIds = await streamer.finalize(text);
  saveMessage(chatId, 'assistant', text, sentIds, { provider: activeProviderId(), model: reply.model }, true);
  log.info(`${label} sent: ${text.slice(0, 80)}`);
}

/** Sends a reach-out (morning greeting or daytime opener) as attempt #`attempt`. */
async function sendReachout(
  client: TelegramClient,
  chatId: number,
  framing: Framing,
  attempt: number,
  userName: string,
): Promise<void> {
  const cue = buildReachoutCue(framing, attempt, userName);
  await sendOpener(client, chatId, cue, userName, `Proactive [${framing} #${attempt}] chat ${chatId}`);
}

// ---- The per-chat reach-out state machine ------------------------------------------------

/** Reschedules the next reach-out after one was just sent, or hard-blocks at the cap. */
function rescheduleAfterReachout(chatId: number, ignoredCount: number): void {
  const atCap = ignoredCount >= config.proactive.maxIgnored;
  upsertProactiveState(chatId, {
    ignoredCount,
    isMorning: false,
    // At the cap: unarm (dueAt null) and stay silent until the user replies. Otherwise arm
    // the next reach-out with the escalated gap.
    dueAt: atCap ? null : nextSilenceDue(ignoredCount),
  });
}

/**
 * Evaluates one chat's reach-out schedule and, when due, sends an opener. Must run inside the
 * chat's queue (see {@link enqueue}) so it never races a user reply.
 */
async function evaluateReachout(client: TelegramClient, chatId: number, now: Date): Promise<void> {
  const hour = now.getHours();
  const p = config.proactive;

  // Outside the active window (night): unarm so the morning opener re-arms tomorrow. The
  // ignored-count is deliberately preserved across the night (an ignored chain continues).
  if (hour < p.windowStartHour || hour >= p.windowEndHour) {
    const state = getProactiveState(chatId);
    if (state?.dueAt != null) upsertProactiveState(chatId, { dueAt: null, isMorning: false });
    return;
  }

  const state = getProactiveState(chatId);
  const ignored = state?.ignoredCount ?? 0;

  // Cap reached: hard block — no reach-outs at all (not even the morning greeting) until the
  // user replies, which resets the count via onUserActivity.
  if (ignored >= p.maxIgnored) {
    if (state?.dueAt != null) upsertProactiveState(chatId, { dueAt: null, isMorning: false });
    return;
  }

  // Unarmed (fresh, or just reset by night): arm the next check.
  if (!state || state.dueAt == null) {
    if (hour < p.morningEndHour) {
      // Still within/before the morning window — arm the good-morning opener.
      upsertProactiveState(chatId, { dueAt: morningDueAt(now), isMorning: true });
    } else {
      // Past the morning window (e.g. an afternoon restart) — begin the daytime cadence,
      // honouring any escalation already in progress.
      upsertProactiveState(chatId, { dueAt: nextSilenceDue(ignored), isMorning: false });
    }
    return;
  }

  // Armed but not yet due.
  if (Date.now() < state.dueAt) return;

  // Due: send (no gate). This is the (ignored+1)-th reach-out since the user last replied.
  const framing: Framing = state.isMorning ? 'morning' : 'daytime';
  const userName = state.userName ?? 'there';
  const attempt = ignored + 1;
  try {
    await sendReachout(client, chatId, framing, attempt, userName);
    rescheduleAfterReachout(chatId, attempt);
  } catch (err) {
    // Failed send doesn't count as an ignored message — retry at the same escalation level.
    log.error(`Proactive send failed for chat ${chatId}; rescheduling.`, err);
    upsertProactiveState(chatId, { dueAt: nextSilenceDue(ignored) });
  }
}

/** Evaluates the reach-out schedule for one chat in a single tick. */
async function evaluateChat(client: TelegramClient, chatId: number): Promise<void> {
  await evaluateReachout(client, chatId, new Date());
}

// ---- Public surface ----------------------------------------------------------------------

/**
 * Records that the user was just active in a chat. Resets the reach-out escalation (count → 0)
 * and arms the base daytime gap, cancels any pending good-morning (the user beat the bot to
 * it), and caches their display name for the {{user}} tag. No-op when proactivity is disabled.
 */
export function onUserActivity(chatId: number, userName: string): void {
  if (!config.proactive.enabled) return;
  upsertProactiveState(chatId, {
    dueAt: nextSilenceDue(0),
    isMorning: false,
    ignoredCount: 0,
    userName,
  });
}

/** Starts the periodic scheduler. One tick evaluates every whitelisted chat, enqueued. */
export function startProactiveLoop(client: TelegramClient): void {
  const p = config.proactive;
  log.info(
    `Proactive messaging ON — window ${p.windowStartHour}:00–${p.windowEndHour}:00, ` +
      `tick ${Math.round(p.tickMs / 1000)}s, base gap ${p.silenceMinMinutes}-${p.silenceMaxMinutes}m ` +
      `(skew ${p.silenceSkew}, +${p.escalationStepMinutes}m/ignore, cap ${p.maxIgnored}).`,
  );
  const tick = (): void => {
    for (const chatId of config.whitelist) {
      // For private chats the peer id equals the user id, so the whitelist doubles as the
      // set of target chats. Each evaluation runs in the chat's queue.
      enqueue(chatId, () =>
        evaluateChat(client, chatId).catch((err) => log.error(`Eval failed for chat ${chatId}:`, err)),
      );
    }
  };
  setInterval(tick, p.tickMs);
}

/** Human-readable schedule snapshot for the `/proactive` command. */
export function getProactiveStatus(chatId: number): string {
  const p = config.proactive;
  if (!p.enabled) return 'Proactive messaging is **off** (set `PROACTIVE_ENABLED=true`).';

  const state = getProactiveState(chatId);
  const ignored = state?.ignoredCount ?? 0;
  const fmt = (ms: number): string =>
    new Date(ms).toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });

  const due =
    ignored >= p.maxIgnored
      ? `blocked — ${ignored}/${p.maxIgnored} ignored (waiting for your reply)`
      : state?.dueAt == null
        ? 'unarmed (re-arms at morning)'
        : `${fmt(state.dueAt)}${state.isMorning ? ' (morning)' : ''}`;

  return [
    `Window: **${p.windowStartHour}:00–${p.windowEndHour}:00** · tick **${Math.round(p.tickMs / 1000)}s**`,
    `Next reach-out: **${due}**`,
    `Ignored streak: **${ignored}/${p.maxIgnored}**`,
    `Silence since last user msg: **${Math.round(hoursSinceLastUser(chatId))}h**`,
  ].join('\n');
}

/**
 * Forces an immediate reach-out for testing (`/proactive test`), bypassing the timers. It does
 * *not* mutate the schedule or the ignored-count — it's a preview of how the cue reads — so it's
 * safe to run repeatedly. The previewed attempt number tracks the current ignored streak, so
 * reply first to preview the clean attempt-1 cue, or run it while ignored to see the 2+ tone.
 */
export async function runProactiveNow(
  client: TelegramClient,
  chatId: number,
  userName: string,
): Promise<string> {
  if (!config.proactive.enabled) return 'Proactive messaging is off — enable it first.';

  try {
    const attempt = (getProactiveState(chatId)?.ignoredCount ?? 0) + 1;
    await sendReachout(client, chatId, 'daytime', attempt, userName);
    return `Reach-out sent (preview of attempt #${attempt} — schedule unchanged).`;
  } catch (err) {
    log.error('Forced proactive send failed:', err);
    return '⚠️ Send failed (see logs).';
  }
}
