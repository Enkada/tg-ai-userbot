import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { renderToolsBlock } from './tools.js';

const log = createLogger('prompt');

/** Raw template loaded once at startup; tags are substituted per message. */
const template = readFileSync(resolve(process.cwd(), config.llm.systemPromptPath), 'utf8').trim();
log.info(`Loaded system prompt template from ${config.llm.systemPromptPath} (${template.length} chars)`);

export interface PromptContext {
  /** Display name of the Telegram user the bot is talking to (for {{user}}). */
  userName: string;
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
 */
export function renderSystemPrompt(ctx: PromptContext, now: Date = new Date()): string {
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

  // Append the tool protocol + registry when any tool is available (search configured).
  // Rendered per message so /prompt and /context reflect the exact prompt the LLM sees.
  const tools = renderToolsBlock();
  return tools ? `${rendered}\n\n${tools}` : rendered;
}
