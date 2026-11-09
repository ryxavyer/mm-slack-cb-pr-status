import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client.js';
import { Store } from '../src/db/store.js';

const MIGRATIONS = resolve(import.meta.dirname, '../drizzle');

/**
 * The upgrade a deploy performs: a database already at an earlier migration,
 * holding rows, opened by the current build. Fresh databases are covered by
 * every other test; this is the path production takes.
 */
describe('database upgrade', () => {
  let dir: string;
  let path: string;

  /** Brings a new database at `path` up to and including migration `lastIdx`, as an older build would. */
  const migrateTo = (lastIdx: number) => {
    const folder = join(dir, 'migrations');
    cpSync(MIGRATIONS, folder, { recursive: true });
    const journalPath = join(folder, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= lastIdx);
    writeFileSync(journalPath, JSON.stringify(journal));

    const sqlite = new Database(path);
    migrate(drizzle(sqlite), { migrationsFolder: folder });
    return sqlite;
  };

  const columns = (sqlite: Database.Database, table: string) =>
    (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cb-pr-status-'));
    path = join(dir, 'bot.db');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('upgrades a database from before channel teams without losing tracked PRs', () => {
    const old = migrateTo(4);
    old
      .prepare(
        `INSERT INTO tracked_prs (owner, repo, number, state, approvals, required_approvals, codeowner_status)
         VALUES ('acme', 'monolith', 42, 'partial', 1, 2, '{"allSatisfied":false}')`,
      )
      .run();
    old
      .prepare(`INSERT INTO pr_messages (pr_id, channel_id, message_ts, current_reaction) VALUES (1, 'G1', '111.1', '1of2')`)
      .run();
    old.prepare(`INSERT INTO slack_channels (channel_id, is_private) VALUES ('G1', 1), ('C1', 0)`).run();
    old.close();

    const handle = openDatabase(path);
    const store = new Store(handle.db);

    expect(store.findPr({ owner: 'acme', repo: 'monolith', number: 42 })).toMatchObject({
      state: 'partial',
      codeownerStatus: '{"allSatisfied":false}',
    });
    expect(store.messageReaction('G1', '111.1')).toBe('1of2');

    // Channels come through with no team, and can then be set up.
    expect(store.channelTeam('G1')).toBeNull();
    store.setChannelTeam('G1', 'creator-team');
    expect(store.channelTeam('G1')).toBe('creator-team');
    handle.close();

    const sqlite = new Database(path);
    expect(columns(sqlite, 'tracked_prs')).not.toContain('approvals');
    expect(columns(sqlite, 'tracked_prs')).not.toContain('required_approvals');
    expect(columns(sqlite, 'slack_channels')).toContain('team');
    sqlite.close();
  });

  it('upgrades a database with private-only channel teams, keeping every team set', () => {
    // Migration 5 recorded every channel's privacy and allowed teams only in private ones.
    const old = migrateTo(5);
    old
      .prepare(
        `INSERT INTO slack_channels (channel_id, is_private, team)
         VALUES ('G1', 1, 'monetization-team'), ('G2', 1, NULL), ('C1', 0, NULL)`,
      )
      .run();
    old.close();

    const handle = openDatabase(path);
    const store = new Store(handle.db);
    expect(store.channelTeam('G1')).toBe('monetization-team');

    // A public channel can now be set up too.
    store.setChannelTeam('C1', 'creator-team');
    expect(store.channelTeam('C1')).toBe('creator-team');
    handle.close();

    const sqlite = new Database(path);
    expect(columns(sqlite, 'slack_channels').sort()).toEqual(['channel_id', 'team', 'updated_at']);
    // Channels only ever seen, never set up, are gone; set-up ones remain.
    const ids = sqlite.prepare('SELECT channel_id FROM slack_channels ORDER BY channel_id').all();
    expect(ids).toEqual([{ channel_id: 'C1' }, { channel_id: 'G1' }]);
    sqlite.close();
  });

  it('opens an up-to-date database again without re-running anything', () => {
    openDatabase(path).close();
    const handle = openDatabase(path);
    const store = new Store(handle.db);
    store.setChannelTeam('G1', 'creator-team');
    handle.close();

    const reopened = openDatabase(path);
    expect(new Store(reopened.db).channelTeam('G1')).toBe('creator-team');
    reopened.close();
  });
});
