import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { desc } from 'drizzle-orm';
import { db } from './db/index.js';
import { personaVersions, type PersonaVersionRow } from './db/schema.js';
import { config } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('persona');

/**
 * The active persona text (raw, `{{tag}}` placeholders intact), mirrored from the newest
 * `persona_versions` row. The DB is the source of truth; this cache exists so prompt
 * assembly never touches the DB. NULL until {@link initPersona} runs.
 */
let persona: string | null = null;

/** Reads the shipped default persona (`prompts/persona.default.txt`, tracked in git). */
export function readDefaultPersona(): string {
  return readFileSync(resolve(process.cwd(), config.llm.personaDefaultPath), 'utf8').trim();
}

/** Appends a version row and points the in-memory cache at it. Every change goes through here. */
function appendVersion(content: string, source: PersonaVersionRow['source']): void {
  db.insert(personaVersions).values({ content, source }).run();
  persona = content;
}

/** The `n` newest versions, newest first. */
function newestVersions(n: number): PersonaVersionRow[] {
  return db.select().from(personaVersions).orderBy(desc(personaVersions.id)).limit(n).all();
}

/**
 * Loads the active persona from the DB, seeding the table on first run. Must be called once
 * at startup, after migrations. Seeding prefers the legacy `prompts/persona.txt` (so an
 * existing tweaked persona migrates losslessly — the file is only read, never touched) and
 * falls back to the shipped default for fresh installs.
 */
export function initPersona(): void {
  const newest = newestVersions(1)[0];
  if (newest) {
    persona = newest.content;
    log.info(`Loaded persona v${newest.id} (${persona.length} chars, source: ${newest.source})`);
    return;
  }

  const legacyPath = resolve(process.cwd(), config.llm.personaPromptPath);
  const fromLegacy = existsSync(legacyPath);
  const seed = fromLegacy ? readFileSync(legacyPath, 'utf8').trim() : readDefaultPersona();
  appendVersion(seed, 'migrated');
  log.info(
    `Seeded persona_versions from ${fromLegacy ? config.llm.personaPromptPath : config.llm.personaDefaultPath} (${seed.length} chars)`,
  );
}

/** The active raw persona (tags intact). Throws if {@link initPersona} hasn't run. */
export function getPersona(): string {
  if (persona === null) throw new Error('Persona not initialized — call initPersona() after migrations');
  return persona;
}

/**
 * Replaces the persona (`/persona set`). Returns the previous text, or null when the new
 * text is identical to the current one — a no-op `set` is skipped so `/persona undo`
 * doesn't degrade into toggling between two equal versions.
 */
export function setPersona(content: string): string | null {
  const prev = getPersona();
  if (content === prev) return null;
  appendVersion(content, 'set');
  return prev;
}

/**
 * Swaps the persona with the previous version (`/persona undo`) by appending a copy of the
 * second-newest row. With versions `[…, A, B]` this yields `[…, A, B, A]` — so a second
 * undo brings `B` back, giving redo (and A/B comparison) for free. Returns the previous
 * text, or null when there's no earlier version to swap with.
 */
export function undoPersona(): string | null {
  const [current, previous] = newestVersions(2);
  if (!previous || previous.content === current.content) return null;
  appendVersion(previous.content, 'undo');
  return current.content;
}

/**
 * Resets the persona to the shipped default (`/persona default`). Returns the previous
 * text, or null when the persona already is the default.
 */
export function resetPersona(): string | null {
  const prev = getPersona();
  const def = readDefaultPersona();
  if (def === prev) return null;
  appendVersion(def, 'default');
  return prev;
}
