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
import type { MessageKind } from './db/schema.js';
import { createLogger } from './logger.js';
import { enqueue } from './queue.js';
import {
  OPENER_SHAPES,
  continueCue,
  continueDirectiveCue,
  ignoredReachoutCue,
  lullReachoutCue,
  morningReachoutCue,
  recentOpenersClause,
  scheduleClause,
} from './prompts/index.js';
import { scheduleNow } from './schedule.js';
import { renderSystemPrompt } from './prompts/render.js';
import { activeProviderId, type ChatResult } from './llm.js';
import { ephemeralSearchStrategy, generateReply } from './generate.js';
import {
  getLastUserMessageAt,
  getProactiveState,
  getRecentOpeners,
  saveMessage,
  upsertProactiveState,
} from './memory.js';
import { finalizeReply, parseToolCall, stripToolCalls } from './tools.js';
import { ackLine, isSelfieAvailable, runSelfieFlow } from './selfie.js';
import { clearInFlight, registerInFlight } from './inflight.js';
import { formatDateTime } from './format.js';
import { ReplyStreamer } from './send.js';
import { withTyping } from './typing.js';

const log = createLogger('proactive');

/**
 * The three reach-out flavours, named as the {@link MessageKind}s they are stored under so the
 * cue that produced a row and the row's recorded kind are literally the same value — which is
 * what lets `/reroll` rebuild the cue from the DB (see {@link buildReachoutCue}).
 */
export type ReachoutKind = Extract<MessageKind, `reachout_${string}`>;

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
 * window, never stored). The `reachout_lull` kind is the first since the user last replied and
 * is time-agnostic — it never mentions the silence; `reachout_ignored` (a prior one went
 * unanswered) lets her notice she's been left on read, lightly. The exact hour-count and
 * attempt number are deliberately *not* fed in — only that on/off distinction — to keep tone
 * from fixating on time (a dedicated time-sense system can do that later).
 *
 * Exported because `/reroll` rebuilds the cue for a stored reach-out row from its recorded
 * {@link MessageKind}. Everything else it needs — the recent openers, the schedule slot, the
 * lull shape — is recomputed here at call time rather than stored, which is what makes a
 * rerolled opener diverge from the one it replaces instead of repeating it.
 */
export function buildReachoutCue(chatId: number, kind: ReachoutKind, userName: string): string {
  // The openers she has already sent, soft-deleted ones included, so she can avoid repeating
  // herself — the window alone can't tell her, because a deleted opener leaves it entirely.
  // On a `/reroll` this list also contains the opener being replaced (its row is not rewritten
  // until the new text lands), so the reroll is pushed off the text it is rerolling for free.
  const openers = recentOpenersClause(getRecentOpeners(chatId, config.proactive.recentOpenersShown));
  // What his routine says he's doing right now — morning greets stop guessing "still in bed"
  // at a desk hour, lull openers gain lunch/office texture (see prompts/index.ts:scheduleClause).
  const slot = scheduleNow();
  const sched = slot ? scheduleClause(userName, slot) : '';
  if (kind === 'reachout_morning') return morningReachoutCue(userName, openers, sched);
  // First opener since they last replied just starts a thread; from the 2nd unanswered one on,
  // she may notice she's been left on read. Both texts live in prompts/index.ts. The ignored
  // cue deliberately does NOT carry the schedule yet: that pairing (noticing being left on
  // read + knowing he's at work) is untested, and this codebase doesn't ship untested cue text.
  //
  // The lull shape is rolled per call, so a reroll of a lull opener draws a fresh one rather
  // than re-sampling the shape that just got rejected.
  return kind === 'reachout_lull'
    ? lullReachoutCue(userName, rollOpenerShape(userName), openers, sched)
    : ignoredReachoutCue(userName, openers);
}

/**
 * The reach-out kind a stored assistant row should be regenerated as, or null when the row is
 * an ordinary reply and `/reroll` should take its normal reactive path.
 *
 * Normally this is just the row's recorded `kind`. The fallback exists for rows written before
 * that column did: they carry only the `proactive` boolean, so the framing they were generated
 * with is genuinely unrecoverable and is re-derived here from the clock and the current ignored
 * streak — best effort, and only ever reachable for openers already sitting in the chat at
 * deploy time. Nothing is back-filled into the DB, because a guess written to a column stops
 * looking like a guess.
 */
export function reachoutKindOf(
  chatId: number,
  row: { kind: MessageKind; proactive: boolean; createdAt: number },
): ReachoutKind | null {
  if (row.kind !== 'reply') return row.kind;
  if (!row.proactive) return null;
  // Dated from when the row was sent, not from now: an unanswered evening opener rerolled the
  // next morning would otherwise come back rebuilt as a good-morning greeting.
  if (new Date(row.createdAt).getHours() < config.proactive.morningEndHour) return 'reachout_morning';
  // ignoredCount was bumped to the attempt number when the opener was sent, so 1 is still the
  // first (time-agnostic) one.
  return (getProactiveState(chatId)?.ignoredCount ?? 0) <= 1 ? 'reachout_lull' : 'reachout_ignored';
}

/**
 * Picks one weighted opener shape for a lull reach-out. Rolled here, in code, rather than offered
 * to the model as a list of options — see {@link OPENER_SHAPES} for the measurement, and
 * {@link diaryCue} for the same pattern: given a menu, the model picks the same item every time.
 */
function rollOpenerShape(userName: string): string {
  const total = OPENER_SHAPES.reduce((n, s) => n + s.weight, 0);
  let roll = Math.random() * total;
  for (const entry of OPENER_SHAPES) {
    roll -= entry.weight;
    if (roll < 0) return entry.shape(userName);
  }
  return OPENER_SHAPES[0].shape(userName);
}

/**
 * Generates an in-character turn against an ephemeral director `cue` and sends it, persisting the
 * result as an assistant message. The cue is injected only into the in-memory generation array —
 * never stored — so it can't pollute the user-activity timer or future context; the turn may still
 * run the `web_search` tool, with the search held in memory only (see {@link ephemeralSearchStrategy}).
 * Throws on failure (the caller decides how to recover).
 *
 * `opts.includeMemory` drops the long-term-memory block for cold openers (see {@link sendReachout});
 * `opts.kind` is the generation path recorded on the stored row, which also derives the legacy
 * proactive flag ({@link saveMessage}) — `reply` for the user-triggered {@link runContinue};
 * `opts.interruptible` registers the generation so `/stop` can abort it (only `/continue` —
 * automated openers are short and their abort would tangle with the reschedule state machine).
 */
async function sendCued(
  client: TelegramClient,
  chatId: number,
  cue: string,
  userName: string,
  label: string,
  opts: { includeMemory: boolean; kind: MessageKind; interruptible: boolean },
): Promise<void> {
  const systemPrompt = renderSystemPrompt({ userName, chatId }, { includeMemory: opts.includeMemory });
  const peer: InputPeerLike = chatId;
  const streamer = new ReplyStreamer(client, peer);
  // When interruptible, make this generation stoppable: /stop aborts the model call and the stream.
  const controller = opts.interruptible ? new AbortController() : undefined;
  const inflight = controller ? registerInFlight(chatId, { controller, stop: () => streamer.stop() }) : undefined;
  try {
    let reply: ChatResult;
    try {
      reply = await withTyping(client, peer, () =>
        generateReply(systemPrompt, ephemeralSearchStrategy(chatId, cue), label, streamer, controller?.signal),
      );
    } catch (err) {
      // If bubbles already streamed, persist them so memory (and the "one outstanding proactive
      // message" guard, for openers) stays consistent with the chat, then rethrow for the caller.
      const partialText = finalizeReply(streamer.streamedText);
      if (streamer.ids.length > 0 && partialText) {
        saveMessage(chatId, 'assistant', partialText, streamer.ids, { provider: activeProviderId(), model: null }, opts.kind);
      }
      throw err;
    }
    // A send_selfie call is executed here too — she can open (or continue) with a picture.
    // Only the parsed call opens the image path; finalizeReply strips the raw tag from the
    // sent/persisted text either way.
    const call = parseToolCall(reply.content);
    const selfieProse =
      isSelfieAvailable() && call?.name === 'send_selfie'
        ? String(call.arguments.prompt ?? '').trim()
        : '';
    let text = finalizeReply(reply.content);
    if (selfieProse && !stripToolCalls(reply.content).trim()) {
      // A bare call leaves no prose to show — generate the "hang on" line instead.
      text = await ackLine(systemPrompt, chatId, userName, selfieProse);
    }
    const sentIds = await streamer.finalize(text);
    saveMessage(chatId, 'assistant', text, sentIds, { provider: activeProviderId(), model: reply.model }, opts.kind);
    log.info(`${label} sent: ${text.slice(0, 80)}`);
    if (selfieProse) {
      await runSelfieFlow({
        client,
        peer,
        chatId,
        userName,
        systemPrompt,
        prose: selfieProse,
        signal: controller?.signal,
      });
    }
  } finally {
    if (inflight) clearInFlight(chatId, inflight);
  }
}

/**
 * Builds the ephemeral director cue for `/continue` — the user, stuck for what to say, asks the
 * bot to move the thread along. Empty directive: open on its own initiative. With a directive: a
 * stage direction, never reported as the user's own words — "<user> said …" makes the model break
 * character to point out it can't pretend the user said that (measured on prod), whereas the raw
 * "keep the conversation going: <directive>" stays in-character. Brevity is baked in, so unlike a
 * reactive reply this cue does NOT stack the separate reply-length cue.
 */
export function buildContinueCue(userName: string, directive: string): string {
  const d = directive.trim();
  return d ? continueDirectiveCue(d) : continueCue(userName);
}

/**
 * `/continue [directive]` — generates and sends the next turn on the user's command, so they can
 * nudge a stalled conversation along. Unlike a reach-out this is user-triggered: it keeps the
 * memory block and is stored as a normal (non-proactive) reply, and it doesn't touch the reach-out
 * schedule (commands never do). Throws on failure for the command dispatcher to surface.
 */
export async function runContinue(
  client: TelegramClient,
  chatId: number,
  userName: string,
  directive: string,
): Promise<void> {
  const cue = buildContinueCue(userName, directive);
  await sendCued(client, chatId, cue, userName, `Continue chat ${chatId}`, {
    includeMemory: true,
    kind: 'reply',
    interruptible: true,
  });
}

/**
 * Sends a reach-out of the given kind. `attempt` is which one this is since the user last
 * replied — it only labels the log line; the cue itself is chosen by `kind` (see
 * {@link buildReachoutCue}), and the row is stored under that same kind so `/reroll` can
 * rebuild this exact context later.
 */
async function sendReachout(
  client: TelegramClient,
  chatId: number,
  kind: ReachoutKind,
  attempt: number,
  userName: string,
): Promise<void> {
  const cue = buildReachoutCue(chatId, kind, userName);
  // Openers omit the long-term-memory block: with no user message to anchor on, the model fixates
  // on the most salient summary and rehashes it every reach-out (see renderSystemPrompt). The live
  // recent-message window still grounds short-term continuity. Stored proactive (the reach-out guard).
  await sendCued(client, chatId, cue, userName, `Proactive [${kind} #${attempt}] chat ${chatId}`, {
    includeMemory: false,
    kind,
    interruptible: false,
  });
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

  // Due: send (no gate). This is the (ignored+1)-th reach-out since the user last replied —
  // the first just opens a thread, later ones may notice they went unanswered.
  const kind: ReachoutKind = state.isMorning
    ? 'reachout_morning'
    : ignored < 1
      ? 'reachout_lull'
      : 'reachout_ignored';
  const userName = state.userName ?? 'there';
  const attempt = ignored + 1;
  try {
    await sendReachout(client, chatId, kind, attempt, userName);
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

  const due =
    ignored >= p.maxIgnored
      ? `blocked — ${ignored}/${p.maxIgnored} ignored (waiting for your reply)`
      : state?.dueAt == null
        ? 'unarmed (re-arms at morning)'
        : `${formatDateTime(state.dueAt)}${state.isMorning ? ' (morning)' : ''}`;

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
    const ignored = getProactiveState(chatId)?.ignoredCount ?? 0;
    const attempt = ignored + 1;
    await sendReachout(client, chatId, ignored < 1 ? 'reachout_lull' : 'reachout_ignored', attempt, userName);
    return `Reach-out sent (preview of attempt #${attempt} — schedule unchanged).`;
  } catch (err) {
    log.error('Forced proactive send failed:', err);
    return '⚠️ Send failed (see logs).';
  }
}
