import { readFileSync, existsSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { getRecentSummaries } from './memory.js';
import { renderToolsBlock } from './tools.js';

const log = createLogger('prompt');

/**
 * Loads the user-owned persona layer, creating it from the shipped default on first run.
 * The persona is the only user-editable layer (so it never receives later app changes —
 * by design); the technical and tools layers stay app-owned and evolve with features.
 */
function loadPersona(): string {
  const userPath = resolve(process.cwd(), config.llm.personaPromptPath);
  if (!existsSync(userPath)) {
    copyFileSync(resolve(process.cwd(), config.llm.personaDefaultPath), userPath);
    log.info(`No persona file at ${config.llm.personaPromptPath}; created it from the default`);
  }
  return readFileSync(userPath, 'utf8').trim();
}

/**
 * The two static layers, loaded once at startup; `{{tag}}` placeholders are substituted per
 * message. Persona (user-owned) and technical (app-owned) are kept separate so `/prompt` can
 * show either one alone — `renderSystemPrompt` rejoins them in the original order.
 */
const persona = loadPersona();
const technical = readFileSync(resolve(process.cwd(), config.llm.technicalPromptPath), 'utf8').trim();
log.info(`Loaded system prompt layers (persona ${persona.length} + technical ${technical.length} chars)`);

export interface PromptContext {
  /** Display name of the Telegram user the bot is talking to (for {{user}}). */
  userName: string;
  /** Chat (peer) id — the key for this conversation's long-term memory summaries. */
  chatId: number;
}

/**
 * Builds the `# Memory` block: the newest daily summaries for a chat, oldest first, under a
 * short framing line that tells the model these are its own recollections (not instructions,
 * and never to be quoted). Returns '' when the chat has no summaries yet, so nothing is added.
 */
export function renderMemoryBlock(chatId: number, userName: string): string {
  const entries = getRecentSummaries(chatId, config.summary.maxKept);
  if (entries.length === 0) return '';
  const body = entries
    .map((e) => {
      const label = new Date(e.periodStart).toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      });
      return `[${label}]\n${e.content}`;
    })
    .join('\n\n');
  return (
    `# Memory\n` +
    `These are your own diary notes from earlier days with ${userName}, oldest first. ` +
    `Recall them naturally as your own memories — never quote them, list them, or mention having notes.\n\n` +
    body
  );
}

/** Maps an hour (0-23) to a coarse day period. */
export function dayPeriod(hour: number): string {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}

/**
 * Renders the system prompt by substituting `{{tag}}` placeholders. Supported tags:
 * - `{{char}}`   — character name (from config)
 * - `{{user}}`   — Telegram user's display name
 * - `{{date}}`   — e.g. "June 10, 2026"
 * - `{{day}}`    — weekday, e.g. "Monday"
 * - `{{period}}` — day period: morning / afternoon / evening / night
 *
 * Unknown tags are left untouched (so typos stay visible).
 *
 * `opts.includeMemory` (default true) controls the `# Memory` block. Reactive replies want it;
 * **proactive openers turn it off** — an opener has no user message to anchor on, so the model
 * latches onto the single most salient summary and rehashes it almost verbatim every reach-out
 * (observed: 6/6 openers fixated on the same memory). Openers still carry the live recent-message
 * window, so short-term continuity is preserved; only multi-day recall is withheld from them.
 */
/** Substitutes `{{tag}}` placeholders in one layer of text; unknown tags are left untouched. */
function substitute(text: string, ctx: PromptContext, now: Date): string {
  const vars: Record<string, string> = {
    char: config.character.name,
    user: ctx.userName,
    date: now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    day: now.toLocaleDateString('en-US', { weekday: 'long' }),
    period: dayPeriod(now.getHours()),
  };
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) => {
    const key = name.toLowerCase();
    return key in vars ? vars[key] : match;
  });
}

/** The persona layer with tags substituted — the user-owned slice of the system prompt. */
export function renderPersona(ctx: PromptContext, opts: { now?: Date } = {}): string {
  return substitute(persona, ctx, opts.now ?? new Date());
}

/** The technical layer with tags substituted — the app-owned slice of the system prompt. */
export function renderTechnical(ctx: PromptContext, opts: { now?: Date } = {}): string {
  return substitute(technical, ctx, opts.now ?? new Date());
}

export function renderSystemPrompt(
  ctx: PromptContext,
  opts: { now?: Date; includeMemory?: boolean } = {},
): string {
  const { now = new Date(), includeMemory = true } = opts;

  // Persona + technical → memory (recollections) → tools (capabilities/protocol). Both the memory
  // and tools blocks are conditional and rendered per message, so /prompt and /context reflect the
  // exact prompt the LLM sees. The order here is the single source of truth for the live payload,
  // /prompt, and /dump alike — keep it in sync with renderToolsBlock's placement.
  const memory = includeMemory ? renderMemoryBlock(ctx.chatId, ctx.userName) : '';
  const tools = renderToolsBlock();
  return [renderPersona(ctx, { now }), renderTechnical(ctx, { now }), memory, tools]
    .filter(Boolean)
    .join('\n\n');
}
