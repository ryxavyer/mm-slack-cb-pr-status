import { and, eq, inArray, isNotNull, lt, notInArray } from 'drizzle-orm';
import type { PrRef, PrState } from '../types.js';
import type { Db } from './client.js';
import { prMessages, trackedPrs, type PrMessage, type TrackedPr } from './schema.js';

const TERMINAL_STATES: PrState[] = ['merged', 'closed'];

export interface PollResult {
  state: PrState;
  approvals: number;
  requiredApprovals: number;
}

/**
 * All database access lives here so the rest of the app never touches Drizzle
 * directly. Every method is synchronous — better-sqlite3 is a sync driver.
 */
export class Store {
  constructor(private readonly db: Db) {}

  /**
   * Inserts the PR if it is new, otherwise returns the existing row (refreshing
   * `requiredApprovals` so a config change takes effect on the next poll).
   */
  upsertPr(ref: PrRef, requiredApprovals: number): TrackedPr {
    const row = this.db
      .insert(trackedPrs)
      .values({
        owner: ref.owner,
        repo: ref.repo,
        number: ref.number,
        state: 'no_reviews',
        approvals: 0,
        requiredApprovals,
        createdAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: [trackedPrs.owner, trackedPrs.repo, trackedPrs.number],
        set: { requiredApprovals },
      })
      .returning()
      .get();
    return row;
  }

  /** Links a Slack message to a PR. Idempotent — re-posting or editing is safe. */
  linkMessage(prId: number, channelId: string, messageTs: string): PrMessage {
    const inserted = this.db
      .insert(prMessages)
      .values({ prId, channelId, messageTs, currentReaction: null, createdAt: Date.now() })
      .onConflictDoNothing({
        target: [prMessages.prId, prMessages.channelId, prMessages.messageTs],
      })
      .returning()
      .get();

    if (inserted) return inserted;

    const existing = this.db
      .select()
      .from(prMessages)
      .where(
        and(
          eq(prMessages.prId, prId),
          eq(prMessages.channelId, channelId),
          eq(prMessages.messageTs, messageTs),
        ),
      )
      .get();
    if (!existing) {
      throw new Error(`pr_messages row vanished for pr=${prId} ${channelId}/${messageTs}`);
    }
    return existing;
  }

  getPr(id: number): TrackedPr | undefined {
    return this.db.select().from(trackedPrs).where(eq(trackedPrs.id, id)).get();
  }

  findPr(ref: PrRef): TrackedPr | undefined {
    return this.db
      .select()
      .from(trackedPrs)
      .where(
        and(
          eq(trackedPrs.owner, ref.owner),
          eq(trackedPrs.repo, ref.repo),
          eq(trackedPrs.number, ref.number),
        ),
      )
      .get();
  }

  /** PRs still worth polling: anything not yet merged or closed. */
  listActivePrs(): TrackedPr[] {
    return this.db
      .select()
      .from(trackedPrs)
      .where(notInArray(trackedPrs.state, TERMINAL_STATES))
      .all();
  }

  listPrsByState(states: PrState[]): TrackedPr[] {
    if (states.length === 0) return [];
    return this.db.select().from(trackedPrs).where(inArray(trackedPrs.state, states)).all();
  }

  /**
   * Records a poll's outcome.
   *
   * `closedAt` is stamped the first time a PR reaches a terminal state and
   * cleared if it somehow reopens; `unreachableSince` works the same way for the
   * `unknown` state, so recovering access resets the give-up clock.
   */
  recordPoll(id: number, result: PollResult, now = Date.now()): TrackedPr | undefined {
    const terminal = TERMINAL_STATES.includes(result.state);
    const existing = this.getPr(id);
    const closedAt = terminal ? (existing?.closedAt ?? now) : null;
    const unreachableSince =
      result.state === 'unknown' ? (existing?.unreachableSince ?? now) : null;

    return this.db
      .update(trackedPrs)
      .set({
        state: result.state,
        approvals: result.approvals,
        requiredApprovals: result.requiredApprovals,
        lastPolledAt: now,
        closedAt,
        unreachableSince,
      })
      .where(eq(trackedPrs.id, id))
      .returning()
      .get();
  }

  /** Bumps only `lastPolledAt` — used when a poll failed and state is unknown. */
  touchPolledAt(id: number, now = Date.now()): void {
    this.db.update(trackedPrs).set({ lastPolledAt: now }).where(eq(trackedPrs.id, id)).run();
  }

  messagesForPr(prId: number): PrMessage[] {
    return this.db.select().from(prMessages).where(eq(prMessages.prId, prId)).all();
  }

  setCurrentReaction(messageId: number, reaction: string | null): void {
    this.db
      .update(prMessages)
      .set({ currentReaction: reaction })
      .where(eq(prMessages.id, messageId))
      .run();
  }

  /** Called when Slack reports the message no longer exists. */
  deleteMessage(messageId: number): void {
    this.db.delete(prMessages).where(eq(prMessages.id, messageId)).run();
  }

  /**
   * Untracks every PR link carried by one Slack message — used when a
   * `message_deleted` event arrives. Returns the number of rows removed.
   */
  deleteMessagesByTs(channelId: string, messageTs: string): number {
    const result = this.db
      .delete(prMessages)
      .where(and(eq(prMessages.channelId, channelId), eq(prMessages.messageTs, messageTs)))
      .run();
    return result.changes;
  }

  /**
   * Cleanup pass: drops PRs that went terminal before `cutoff` (cascading to
   * their message rows). Returns how many PRs were removed.
   */
  deleteClosedBefore(cutoff: number): number {
    const doomed = this.db
      .select({ id: trackedPrs.id })
      .from(trackedPrs)
      .where(and(isNotNull(trackedPrs.closedAt), lt(trackedPrs.closedAt, cutoff)))
      .all();
    if (doomed.length === 0) return 0;

    const ids = doomed.map((r) => r.id);
    // Explicit child delete: ON DELETE CASCADE only fires when foreign keys are
    // enabled, and we would rather not depend on the pragma for correctness.
    this.db.delete(prMessages).where(inArray(prMessages.prId, ids)).run();
    this.db.delete(trackedPrs).where(inArray(trackedPrs.id, ids)).run();
    return ids.length;
  }

  /**
   * PRs that have been unreachable since before `cutoff`. The caller strips their
   * reactions before deleting them, so this returns rows rather than deleting.
   */
  listUnreachableBefore(cutoff: number): TrackedPr[] {
    return this.db
      .select()
      .from(trackedPrs)
      .where(
        and(
          eq(trackedPrs.state, 'unknown'),
          isNotNull(trackedPrs.unreachableSince),
          lt(trackedPrs.unreachableSince, cutoff),
        ),
      )
      .all();
  }

  /** Removes one PR and every message linked to it. */
  deletePr(id: number): void {
    this.db.delete(prMessages).where(eq(prMessages.prId, id)).run();
    this.db.delete(trackedPrs).where(eq(trackedPrs.id, id)).run();
  }

  counts(): { prs: number; messages: number; active: number } {
    const all = this.db.select().from(trackedPrs).all();
    const messages = this.db.select().from(prMessages).all();
    return {
      prs: all.length,
      messages: messages.length,
      active: all.filter((p) => !TERMINAL_STATES.includes(p.state)).length,
    };
  }
}
