import { eq } from 'drizzle-orm';
import { db } from './db/index.js';
import { settings } from './db/schema.js';
import { createLogger } from './logger.js';

const log = createLogger('settings');

/** The character name a fresh install starts with, seeded into the settings row on first run. */
export const DEFAULT_CHAR_NAME = 'Sara';

/** Longest accepted character name — it's spliced into every system-prompt render, so keep it short. */
export const MAX_CHAR_NAME_LENGTH = 40;

/** The singleton settings row id — there is exactly one global settings row. */
const ROW_ID = 1;

/**
 * In-memory mirror of the character name, from the newest {@link settings} row. The DB is the
 * source of truth; this cache exists so prompt assembly never touches the DB. NULL until
 * {@link initSettings} runs.
 */
let charName: string | null = null;

/** In-memory mirror of the selfie-upscale toggle, same lifecycle as {@link charName}. */
let imgUpscale = true;

/**
 * Loads the global settings row, seeding it with column defaults on first run. Must be called
 * once at startup, after migrations. From then on the name is DB-owned — changed only via
 * `/name`, never re-read from the environment — so a deploy/restart never resets it.
 */
export function initSettings(): void {
  // Insert the singleton row if it doesn't exist yet; the `char_name` default ('Sara') applies.
  db.insert(settings).values({ id: ROW_ID }).onConflictDoNothing().run();
  const row = db.select().from(settings).where(eq(settings.id, ROW_ID)).get();
  charName = row?.charName ?? DEFAULT_CHAR_NAME;
  imgUpscale = row?.imgUpscale ?? true;
  log.info(`Loaded settings (character name: "${charName}", selfie upscale: ${imgUpscale ? 'on' : 'off'})`);
}

/** Whether selfie generations run the 2× upscale pass. Changed via `/img upscale on|off`. */
export function getImgUpscale(): boolean {
  return imgUpscale;
}

/**
 * Flips the selfie-upscale toggle. Returns the previous value, or null when it's already
 * the requested one — a no-op the caller reports without writing.
 */
export function setImgUpscale(value: boolean): boolean | null {
  if (value === imgUpscale) return null;
  const prev = imgUpscale;
  db.update(settings).set({ imgUpscale: value, updatedAt: Date.now() }).where(eq(settings.id, ROW_ID)).run();
  imgUpscale = value;
  return prev;
}

/** The active character name — the `{{char}}` tag value. Throws if {@link initSettings} hasn't run. */
export function getCharName(): string {
  if (charName === null) {
    throw new Error('Settings not initialized — call initSettings() after migrations');
  }
  return charName;
}

/**
 * Normalizes a proposed character name: trims, keeps only the first line (the value is injected
 * inline into every prompt, so newlines can't be allowed), and caps the length. Returns null
 * when nothing usable remains, so the caller can reject the input.
 */
export function normalizeCharName(raw: string): string | null {
  const name = raw.trim().split('\n')[0].trim().slice(0, MAX_CHAR_NAME_LENGTH).trim();
  return name.length > 0 ? name : null;
}

/**
 * Changes the character name (`/name`). Expects an already-normalized name (see
 * {@link normalizeCharName}). Returns the previous name, or null when it's identical to the
 * current one — a no-op the caller reports without writing.
 */
export function setCharName(name: string): string | null {
  const prev = getCharName();
  if (name === prev) return null;
  db.update(settings).set({ charName: name, updatedAt: Date.now() }).where(eq(settings.id, ROW_ID)).run();
  charName = name;
  return prev;
}
