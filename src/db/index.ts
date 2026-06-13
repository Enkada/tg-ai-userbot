import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import * as schema from './schema.js';

const log = createLogger('db');

mkdirSync(dirname(config.dbPath), { recursive: true });

const sqlite = new Database(config.dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });

/** Applies any pending migrations from the ./drizzle folder. Called at startup. */
export function runMigrations(): void {
  migrate(db, { migrationsFolder: 'drizzle' });
  log.info(`Database ready at ${config.dbPath}`);
}

export { schema };
