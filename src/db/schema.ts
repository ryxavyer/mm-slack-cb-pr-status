import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { PrState } from '../types.js';

/** Every PR the bot is aware of. Rows are removed by the cleanup TTL pass. */
export const trackedPrs = sqliteTable(
  'tracked_prs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    owner: text('owner').notNull(),
    repo: text('repo').notNull(),
    number: integer('number').notNull(),
    state: text('state').$type<PrState>().notNull().default('no_reviews'),
    approvals: integer('approvals').notNull().default(0),
    requiredApprovals: integer('required_approvals').notNull(),
    lastPolledAt: integer('last_polled_at'),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    /** Set when the PR reaches merged/closed; drives the cleanup TTL. */
    closedAt: integer('closed_at'),
    /**
     * When GitHub first stopped reporting on this PR. Cleared as soon as it
     * becomes visible again; drives the give-up TTL if it never does.
     */
    unreachableSince: integer('unreachable_since'),
    /** JSON-serialized CodeownerStatus from the codeowner bot's comment, if present. */
    codeownerStatus: text('codeowner_status'),
  },
  (t) => [
    uniqueIndex('tracked_prs_owner_repo_number_idx').on(t.owner, t.repo, t.number),
    index('tracked_prs_state_idx').on(t.state),
  ],
);

/** One PR maps to many Slack messages — the same link can be posted repeatedly. */
export const prMessages = sqliteTable(
  'pr_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    prId: integer('pr_id')
      .notNull()
      .references(() => trackedPrs.id, { onDelete: 'cascade' }),
    channelId: text('channel_id').notNull(),
    /** A Slack message's timestamp is its identity within a channel. */
    messageTs: text('message_ts').notNull(),
    /** Which managed emoji we last successfully applied, if any. */
    currentReaction: text('current_reaction'),
    /** GitHub team slug the channel/mention context resolved to, if any. */
    requiredTeam: text('required_team'),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex('pr_messages_pr_channel_ts_idx').on(t.prId, t.channelId, t.messageTs),
    index('pr_messages_pr_id_idx').on(t.prId),
  ],
);

export type TrackedPr = typeof trackedPrs.$inferSelect;
export type PrMessage = typeof prMessages.$inferSelect;
