/**
 * Proactive messaging — the bot initiating conversation on its own, instead of only
 * replying. A periodic tick evaluates each chat's schedule (kept in the DB so it survives
 * restarts). There are two independent systems, both driven off the same tick:
 *
 *  - **Reach-outs**: an always-on good-morning greeting (random time in the morning window),
 *    then daytime openers on an *escalating cooldown* — the first comes a base gap after the
 *    user goes quiet, and every reach-out that goes unanswered lengthens the next gap and
 *    bumps an `ignoredCount`. After `maxIgnored` unanswered ones she goes fully silent until
 *    the user replies (which resets the count). No yes/no model call gates this — ignoring is
 *    itself the "stop" signal, via the escalation.
 *
 *  - **Follow-ups**: when the user replies and then goes quiet for a couple of minutes mid-
 *    conversation, the bot continues once on its own (probabilistic, capped at one). This is
 *    a short-timescale "don't let the thread die" nudge, separate from the reach-out chain —
 *    it never touches `ignoredCount`, and only runs during active daytime hours.
 *
 * Both openers are generated through the normal persona path (full in-character generation
 * with an ephemeral director cue), never a flattened control-flow prompt.
 */
import type { InputPeerLike, TelegramClient } from '@mtcute/node';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { enqueue } from './queue.js';
import { renderSystemPrompt } from './prompt.js';
import { activeProviderId } from './llm.js';
import { ephemeralSearchStrategy, generateReply } from './generate.js';
import {
  getLastMessageMeta,
  getLastUserMessageAt,
  getProactiveState,
  saveMessage,
  upsertProactiveState,
} from './memory.js';
import { finalizeReply } from './tools.js';
import { renderMarkdown } from './format.js';
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
  const { silenceMinMinutes, silenceMaxMinutes, escalationStepMinutes } = config.proactive;
  const base = silenceMinMinutes + Math.random() * (silenceMaxMinutes - silenceMinMinutes);
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

/** A random epoch-ms due time for the follow-up timer (a couple of minutes out). */
function nextFollowupDue(): number {
  const { followupMinMinutes, followupMaxMinutes } = config.proactive;
  const minutes = followupMinMinutes + Math.random() * (followupMaxMinutes - followupMinMinutes);
  return Date.now() + minutes * 60_000;
}

/** Hours since the user's last message (large sentinel when there's no user message yet). */
function hoursSinceLastUser(chatId: number): number {
  const at = getLastUserMessageAt(chatId);
  if (at == null) return 99;
  return Math.max(0, (Date.now() - at) / 3_600_000);
}

/** True when `hour` is inside the follow-up's active-daytime window. */
function inFollowupWindow(hour: number): boolean {
  const { followupWindowStartHour, followupWindowEndHour } = config.proactive;
  return hour >= followupWindowStartHour && hour < followupWindowEndHour;
}

// ---- Generating & sending an opener ------------------------------------------------------

/**
 * Builds the ephemeral director cue for a reach-out (appended as a user turn to the generation
 * window, never stored). `attempt` is which reach-out this is since the user last replied (1 =
 * first); from the 2nd on it tells her she's been left unanswered so her tone can escalate.
 */
function buildReachoutCue(framing: Framing, hours: number, attempt: number, userName: string): string {
  if (framing === 'morning') {
    return (
      `[System note: it's morning and ${userName} hasn't messaged yet — you're reaching out first. ` +
      `Greet them warmly and gently start the day. Keep it short and natural, like a real text.]`
    );
  }
  const head =
    `[System note: ${userName} hasn't messaged in about ${Math.round(hours)}h and did NOT just ` +
    `message you — you're choosing to reach out first.`;
  if (attempt <= 1) {
    return `${head} Start a light, natural conversation — say whatever's on your mind. Keep it short.]`;
  }
  return (
    `${head} This is the ${attempt}${ordinalSuffix(attempt)} time you've reached out since they last ` +
    `replied and you've gotten no answer — let that color your tone (wry, a little hurt, or playfully ` +
    `persistent, however you feel it), but stay in character and keep it short.]`
  );
}

/** Builds the ephemeral director cue for a follow-up (continuing a stalled live conversation). */
function buildFollowupCue(userName: string): string {
  return (
    `[System note: ${userName} went quiet for a few minutes mid-conversation and hasn't replied. ` +
    `Send a natural follow-up — pick the thread back up, ask something, or if the topic feels done, ` +
    `lightly switch to something new. Keep it short, like a real text.]`
  );
}

/** English ordinal suffix for small counts (1→st, 2→nd, 3→rd, else th). */
function ordinalSuffix(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return 'th';
  switch (n % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
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
  const reply = await withTyping(client, peer, () =>
    generateReply(systemPrompt, ephemeralSearchStrategy(chatId, cue), label),
  );
  const text = finalizeReply(reply.content);
  const sent = await client.sendText(peer, renderMarkdown(text));
  saveMessage(chatId, 'assistant', text, sent.id, { provider: activeProviderId(), model: reply.model }, true);
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
  const cue = buildReachoutCue(framing, hoursSinceLastUser(chatId), attempt, userName);
  await sendOpener(client, chatId, cue, userName, `Proactive [${framing} #${attempt}] chat ${chatId}`);
}

// ---- Follow-ups --------------------------------------------------------------------------

/**
 * Runs the follow-up timer for one chat: when it's due, consume it (one shot), and — inside
 * the active-daytime window, only if the last stored message is still ours (the user hasn't
 * replied since) — roll the probability and, on a hit, continue the conversation once. Never
 * touches the reach-out escalation. Swallows send errors (the timer is already consumed).
 */
async function maybeFollowup(client: TelegramClient, chatId: number, now: Date): Promise<void> {
  const state = getProactiveState(chatId);
  if (!state || state.followupDueAt == null) return;
  if (now.getTime() < state.followupDueAt) return;

  // Due → consume immediately (capped at one per user reply, regardless of outcome).
  upsertProactiveState(chatId, { followupDueAt: null });

  const p = config.proactive;
  if (!inFollowupWindow(now.getHours())) {
    log.info(`Followup [chat ${chatId}]: skipped — outside ${p.followupWindowStartHour}:00–${p.followupWindowEndHour}:00.`);
    return;
  }

  // Only continue a live thread: the latest stored message must be ours. If the user had
  // replied, onUserActivity would have re-armed this timer rather than leaving it to fire.
  const lastMeta = getLastMessageMeta(chatId);
  if (lastMeta?.role !== 'assistant') return;

  const roll = Math.random();
  if (roll >= p.followupChance) {
    log.info(`Followup [chat ${chatId}]: roll ${roll.toFixed(2)} ≥ ${p.followupChance} — staying quiet.`);
    return;
  }
  log.info(`Followup [chat ${chatId}]: roll ${roll.toFixed(2)} < ${p.followupChance} — continuing.`);

  const userName = state.userName ?? 'there';
  try {
    await sendOpener(client, chatId, buildFollowupCue(userName), userName, `Followup chat ${chatId}`);
  } catch (err) {
    log.error(`Followup send failed for chat ${chatId}:`, err);
  }
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

/** Evaluates both systems for one chat in a single tick. */
async function evaluateChat(client: TelegramClient, chatId: number): Promise<void> {
  const now = new Date();
  // Follow-ups run on their own short timer + window, independent of the reach-out window.
  await maybeFollowup(client, chatId, now);
  await evaluateReachout(client, chatId, now);
}

// ---- Public surface ----------------------------------------------------------------------

/**
 * Records that the user was just active in a chat. Resets the reach-out escalation (count → 0)
 * and arms the base daytime gap, cancels any pending good-morning (the user beat the bot to
 * it), starts the follow-up timer, and caches their display name for the {{user}} tag. No-op
 * when proactivity is disabled.
 */
export function onUserActivity(chatId: number, userName: string): void {
  if (!config.proactive.enabled) return;
  upsertProactiveState(chatId, {
    dueAt: nextSilenceDue(0),
    isMorning: false,
    ignoredCount: 0,
    followupDueAt: nextFollowupDue(),
    userName,
  });
}

/** Starts the periodic scheduler. One tick evaluates every whitelisted chat, enqueued. */
export function startProactiveLoop(client: TelegramClient): void {
  const p = config.proactive;
  log.info(
    `Proactive messaging ON — window ${p.windowStartHour}:00–${p.windowEndHour}:00, ` +
      `tick ${Math.round(p.tickMs / 1000)}s, base gap ${p.silenceMinMinutes}-${p.silenceMaxMinutes}m ` +
      `(+${p.escalationStepMinutes}m/ignore, cap ${p.maxIgnored}), ` +
      `follow-ups ${Math.round(p.followupChance * 100)}% in ${p.followupMinMinutes}-${p.followupMaxMinutes}m.`,
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
  const followup = state?.followupDueAt == null ? 'none pending' : fmt(state.followupDueAt);

  return [
    `Window: **${p.windowStartHour}:00–${p.windowEndHour}:00** · tick **${Math.round(p.tickMs / 1000)}s**`,
    `Next reach-out: **${due}**`,
    `Ignored streak: **${ignored}/${p.maxIgnored}**`,
    `Follow-up: **${followup}** (${Math.round(p.followupChance * 100)}% chance)`,
    `Silence since last user msg: **${Math.round(hoursSinceLastUser(chatId))}h**`,
  ].join('\n');
}

/**
 * Forces an immediate opener for testing (`/proactive test` and `/proactive followup`),
 * bypassing the timers. It does *not* mutate the schedule or the ignored-count — it's a
 * preview of how the cue reads — so it's safe to run repeatedly. Returns a short status string.
 */
export async function runProactiveNow(
  client: TelegramClient,
  chatId: number,
  userName: string,
  kind: 'reachout' | 'followup' = 'reachout',
): Promise<string> {
  if (!config.proactive.enabled) return 'Proactive messaging is off — enable it first.';

  try {
    if (kind === 'followup') {
      await sendOpener(client, chatId, buildFollowupCue(userName), userName, `Followup test chat ${chatId}`);
      return 'Follow-up sent (preview — schedule unchanged).';
    }
    const attempt = (getProactiveState(chatId)?.ignoredCount ?? 0) + 1;
    await sendReachout(client, chatId, 'daytime', attempt, userName);
    return `Reach-out sent (preview of attempt #${attempt} — schedule unchanged).`;
  } catch (err) {
    log.error('Forced proactive send failed:', err);
    return '⚠️ Send failed (see logs).';
  }
}
