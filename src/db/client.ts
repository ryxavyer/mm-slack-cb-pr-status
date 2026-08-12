import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  db: Db;
  close: () => void;
}

/** Migrations live next to the compiled output as well as the sources. */
function migrationsFolder(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
}

/**
 * Opens (creating if needed) the SQLite database at `path` and brings it up to
 * the latest schema. `DATABASE_PATH` is the process's only filesystem
 * touchpoint — on Railway a volume mount, anywhere else a plain path.
 */
export function openDatabase(path: string): DbHandle {
  if (path !== ':memory:') {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }

  const sqlite = new Database(path);
  // WAL keeps the single writer from blocking readers; NORMAL is the standard
  // durability trade-off for WAL and survives process crashes (not OS crashes).
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsFolder() });

  return {
    db,
    close: () => sqlite.close(),
  };
}
