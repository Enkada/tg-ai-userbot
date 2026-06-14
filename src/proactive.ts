/**
 * Proactive messaging — the bot initiating a conversation on its own, instead of only
 * replying. A periodic tick evaluates each chat's schedule (kept in the DB so it survives
 * restarts) and, when a check comes due, asks the model a conservative yes/no "should I
 * reach out now?" gate. On yes it generates an opener through the normal persona path and
 * sends it. Guardrails keep it from being clingy: an active window (waking hours), one
 * outstanding proactive message at a time, and a silence/morning cadence.
 *
 * See the design notes in the project memory; the two LLM calls have deliberately different
 * shapes — the gate is a neutral control-flow classification (flattened transcript, tiny
 * token budget), the opener is the full in-character generation.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { InputPeerLike, TelegramClient } from '@mtcute/node';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { enqueue } from './queue.js';
import { renderSystemPrompt, dayPeriod } from './prompt.js';
import { activeProviderId, complete, type ChatMessage } from './llm.js';
import { ephemeralSearchStrategy, generateReply } from './generate.js';
import {
  getLastMessageMeta,
  getLastUserMessageAt,
  getProactiveState,
  getWindow,
  saveMessage,
  upsertProactiveState,
} from './memory.js';
import { finalizeReply } from './tools.js';
import { renderMarkdown } from './format.js';
import { withTyping } from './typing.js';

const log = createLogger('proactive');

type Framing = 'morning' | 'daytime';

// ---- Scheduling helpers ------------------------------------------------------------------

/** A random epoch-ms due time `silenceMin`..`silenceMax` minutes from now. */
function nextSilenceDue(): number {
  const { silenceMinMinutes, silenceMaxMinutes } = config.proactive;
  const minutes = silenceMinMinutes + Math.random() * (silenceMaxMinutes - silenceMinMinutes);
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

// ---- The yes/no gate ---------------------------------------------------------------------

/** The neutral evaluator prompt, loaded once (lazily) and cached. */
let gateTemplate: string | null = null;

function getGateTemplate(): string {
  if (gateTemplate !== null) return gateTemplate;
  try {
    gateTemplate = readFileSync(resolve(process.cwd(), config.proactive.gatePromptPath), 'utf8').trim();
  } catch (err) {
    log.error(`Could not read gate prompt at ${config.proactive.gatePromptPath}; using a built-in default.`, err);
    gateTemplate =
      'Decide whether {{char}} should message {{user}} right now, unprompted. It is {{period}}, ' +
      'about {{hours}}h since {{user}} last messaged.{{framing_note}} Be conservative. ' +
      'Answer with exactly one word, lowercase: yes or no.';
  }
  return gateTemplate;
}

/** Renders the gate system prompt for the current context. */
function renderGatePrompt(period: string, hours: number, framing: Framing, userName: string): string {
  const framingNote =
    framing === 'morning' ? ' This would be a good-morning greeting to start the day.' : '';
  const vars: Record<string, string> = {
    char: config.character.name,
    user: userName,
    period,
    hours: String(Math.round(hours)),
    framing_note: framingNote,
  };
  return getGateTemplate().replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name: string) => {
    const key = name.toLowerCase();
    return key in vars ? vars[key] : m;
  });
}

/** Flattens the recent window into plain `Name: text` lines so the gate reads it as a task, not a turn to continue. */
function flattenTranscript(window: ChatMessage[], depth: number): string {
  if (window.length === 0) return '(no prior messages)';
  const char = config.character.name;
  return window
    .slice(-depth)
    .map((m) => `${m.role === 'user' ? 'User' : char}: ${m.content}`)
    .join('\n');
}

interface GateResult {
  yes: boolean;
  /** Raw model output, kept for logging/tuning. */
  raw: string;
}

/**
 * Asks the active provider whether to reach out now. Neutral system prompt + the flattened
 * transcript as a user turn, constrained to a one-word answer and parsed on the first word
 * (so "no, i wouldn't" reads as no). Any failure or ambiguity defaults to no.
 */
async function runGate(chatId: number, framing: Framing, userName: string): Promise<GateResult> {
  const window = getWindow(chatId);
  const transcript = flattenTranscript(window, config.proactive.gateTranscriptDepth);
  const system = renderGatePrompt(dayPeriod(new Date().getHours()), hoursSinceLastUser(chatId), framing, userName);
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: `Recent conversation:\n${transcript}\n\nDecision:` },
  ];

  let raw = '';
  try {
    const res = await complete(messages, { maxTokens: config.proactive.gateMaxTokens, temperature: 0 });
    raw = res.content.trim();
  } catch (err) {
    log.error(`Gate call failed for chat ${chatId}:`, err);
    return { yes: false, raw: 'error' };
  }
  // First alphabetic word, lowercased — robust to punctuation and trailing prose.
  const firstWord = raw.toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ')[0] ?? '';
  return { yes: firstWord === 'yes', raw };
}

// ---- Generating & sending the opener -----------------------------------------------------

/** Builds the ephemeral director cue appended (as a user turn) to the generation window. */
function buildCue(framing: Framing, hours: number, userName: string): string {
  const head = `[System note: ${userName} hasn't messaged in about ${Math.round(hours)}h and did NOT just message you — you're choosing to reach out first.`;
  return framing === 'morning'
    ? `${head} It's morning — greet them warmly and gently start a conversation. Keep it short and natural.]`
    : `${head} Start a light, natural conversation — say whatever's on your mind. Keep it short.]`;
}

/**
 * Generates an opener in-character and sends it, persisting it as a proactive assistant
 * message. The cue is injected only into the in-memory generation array — never stored —
 * so it can't pollute the user-activity timer or future context; the opener may still run
 * the `web_search` tool (e.g. a deferred "look this up when I wake" request), with the
 * search held in memory only (see {@link ephemeralSearchStrategy}). Throws on failure (the
 * caller reschedules), and only the successful send marks the row proactive (so a failed
 * send never trips the "one outstanding" guard).
 */
async function sendProactive(
  client: TelegramClient,
  chatId: number,
  framing: Framing,
  userName: string,
): Promise<void> {
  const hours = hoursSinceLastUser(chatId);
  const systemPrompt = renderSystemPrompt({ userName });
  const cue = buildCue(framing, hours, userName);

  const peer: InputPeerLike = chatId;
  const reply = await withTyping(client, peer, () =>
    generateReply(systemPrompt, ephemeralSearchStrategy(chatId, cue), `proactive chat ${chatId}`),
  );
  const text = finalizeReply(reply.content);
  const sent = await client.sendText(peer, renderMarkdown(text));
  saveMessage(chatId, 'assistant', text, sent.id, { provider: activeProviderId(), model: reply.model }, true);
  log.info(`Proactive [${framing}] sent to chat ${chatId}: ${text.slice(0, 80)}`);
}

// ---- The per-chat state machine ----------------------------------------------------------

/**
 * Evaluates one chat's schedule and, when due, runs the gate and maybe sends an opener.
 * Must run inside the chat's queue (see {@link enqueue}) so it never races a user reply.
 */
async function evaluateChat(client: TelegramClient, chatId: number): Promise<void> {
  const now = new Date();
  const hour = now.getHours();
  const p = config.proactive;

  // Outside the active window (night): unarm so the morning opener re-arms tomorrow.
  if (hour < p.windowStartHour || hour >= p.windowEndHour) {
    const state = getProactiveState(chatId);
    if (state?.dueAt != null) upsertProactiveState(chatId, { dueAt: null, isMorning: false });
    return;
  }

  // Guard: never stack proactive messages. If the last message is an unanswered proactive
  // reply, stay silent until the user replies (this persists across days, by design).
  const lastMeta = getLastMessageMeta(chatId);
  if (lastMeta?.role === 'assistant' && lastMeta.proactive) return;

  const state = getProactiveState(chatId);

  // Unarmed (fresh, or just reset by night): arm the next check.
  if (!state || state.dueAt == null) {
    if (hour < p.morningEndHour) {
      // Still within/before the morning window — arm the good-morning opener.
      upsertProactiveState(chatId, { dueAt: morningDueAt(now), isMorning: true });
    } else {
      // Past the morning window (e.g. an afternoon restart) — no greeting today; begin
      // the daytime silence cadence instead.
      upsertProactiveState(chatId, { dueAt: nextSilenceDue(), isMorning: false });
    }
    return;
  }

  // Armed but not yet due.
  if (Date.now() < state.dueAt) return;

  // Due: decide, then maybe send. `isMorning` is consumed either way.
  const framing: Framing = state.isMorning ? 'morning' : 'daytime';
  const userName = state.userName ?? 'there';
  const decision = await runGate(chatId, framing, userName);
  log.info(`Gate [chat ${chatId}, ${framing}, ~${Math.round(hoursSinceLastUser(chatId))}h]: ${decision.yes ? 'YES' : 'NO'} (raw: ${JSON.stringify(decision.raw)})`);

  if (!decision.yes) {
    upsertProactiveState(chatId, { isMorning: false, dueAt: nextSilenceDue() });
    return;
  }

  upsertProactiveState(chatId, { isMorning: false });
  try {
    await sendProactive(client, chatId, framing, userName);
    // Success: the new proactive row now trips the guard until the user replies — no reschedule.
  } catch (err) {
    log.error(`Proactive send failed for chat ${chatId}; rescheduling.`, err);
    upsertProactiveState(chatId, { dueAt: nextSilenceDue() });
  }
}

// ---- Public surface ----------------------------------------------------------------------

/**
 * Records that the user was just active in a chat: resets the silence timer and cancels any
 * pending good-morning (the user beat the bot to it), and caches their display name for the
 * {{user}} tag when the bot later initiates. No-op when proactivity is disabled.
 */
export function onUserActivity(chatId: number, userName: string): void {
  if (!config.proactive.enabled) return;
  upsertProactiveState(chatId, { dueAt: nextSilenceDue(), isMorning: false, userName });
}

/** Starts the periodic scheduler. One tick evaluates every whitelisted chat, enqueued. */
export function startProactiveLoop(client: TelegramClient): void {
  const p = config.proactive;
  log.info(
    `Proactive messaging ON — window ${p.windowStartHour}:00–${p.windowEndHour}:00, ` +
      `tick ${Math.round(p.tickMs / 1000)}s, silence ${p.silenceMinMinutes}-${p.silenceMaxMinutes}m.`,
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
  const lastMeta = getLastMessageMeta(chatId);
  const blocked = lastMeta?.role === 'assistant' && lastMeta.proactive;
  const due =
    state?.dueAt == null
      ? 'unarmed (re-arms at morning)'
      : new Date(state.dueAt).toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });

  return [
    `Window: **${p.windowStartHour}:00–${p.windowEndHour}:00** · tick **${Math.round(p.tickMs / 1000)}s**`,
    `Next check: **${due}**${state?.isMorning ? ' (morning)' : ''}`,
    `Silence since last user msg: **${Math.round(hoursSinceLastUser(chatId))}h**`,
    blocked ? 'Status: **paused** — an unanswered proactive message is outstanding.' : 'Status: **armed**',
  ].join('\n');
}

/**
 * Forces an immediate gate + send for testing (`/proactive test`), bypassing the timer but
 * still respecting the "one outstanding message" guard. Returns a short status string.
 */
export async function runProactiveNow(
  client: TelegramClient,
  chatId: number,
  userName: string,
): Promise<string> {
  if (!config.proactive.enabled) return 'Proactive messaging is off — enable it first.';

  const lastMeta = getLastMessageMeta(chatId);
  if (lastMeta?.role === 'assistant' && lastMeta.proactive) {
    return 'Blocked — an unanswered proactive message is already outstanding.';
  }

  const decision = await runGate(chatId, 'daytime', userName);
  if (!decision.yes) return `Gate said **no** (raw: ${JSON.stringify(decision.raw)}).`;
  try {
    await sendProactive(client, chatId, 'daytime', userName);
    return `Gate said **yes** — opener sent.`;
  } catch (err) {
    log.error('Forced proactive send failed:', err);
    return '⚠️ Gate said yes but the send failed (see logs).';
  }
}
