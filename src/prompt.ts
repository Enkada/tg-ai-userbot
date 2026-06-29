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
 * Raw template loaded once at startup; tags are substituted per message. Persona (user) +
 * technical (app) are joined here; the tools block is appended per-render (it's conditional).
 */
const technical = readFileSync(resolve(process.cwd(), config.llm.technicalPromptPath), 'utf8').trim();
const template = `${loadPersona()}\n\n${technical}`;
log.info(`Loaded system prompt template (${template.length} chars)`);

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
function renderMemoryBlock(chatId: number, userName: string): string {
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
export function renderSystemPrompt(
  ctx: PromptContext,
  opts: { now?: Date; includeMemory?: boolean } = {},
): string {
  const { now = new Date(), includeMemory = true } = opts;
  const vars: Record<string, string> = {
    char: config.character.name,
    user: ctx.userName,
    date: now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    day: now.toLocaleDateString('en-US', { weekday: 'long' }),
    period: dayPeriod(now.getHours()),
  };

  const rendered = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) => {
    const key = name.toLowerCase();
    return key in vars ? vars[key] : match;
  });

  // Persona + technical → memory (recollections) → tools (capabilities/protocol). Both the memory
  // and tools blocks are conditional and rendered per message, so /prompt and /context reflect the
  // exact prompt the LLM sees.
  const memory = includeMemory ? renderMemoryBlock(ctx.chatId, ctx.userName) : '';
  const tools = renderToolsBlock();
  return [rendered, memory, tools].filter(Boolean).join('\n\n');
}
