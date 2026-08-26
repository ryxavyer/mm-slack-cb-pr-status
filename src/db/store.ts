import { and, eq, inArray, isNotNull, isNull, lt, notInArray } from 'drizzle-orm';
import type { PrRef, PrState } from '../types.js';
import type { Db } from './client.js';
import { prMessages, trackedPrs, type PrMessage, type TrackedPr } from './schema.js';

const TERMINAL_STATES: PrState[] = ['merged', 'closed'];

export interface PollResult {
  state: PrState;
  approvals: number;
  requiredApprovals: number;
  /** JSON-serialized CodeownerStatus. Undefined = leave the existing value untouched. */
  codeownerStatus?: string | null;
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

  /**
   * Sets requiredTeams on every row for a message, overwriting any prior value.
   * Stored as a JSON array so multiple teams can be tracked per message.
   * Used when message text is available and group mentions or channel config
   * resolve to teams (highest-priority signal).
   */
  setMessageRequiredTeams(channelId: string, messageTs: string, teams: string[]): void {
    this.db
      .update(prMessages)
      .set({ requiredTeam: JSON.stringify(teams) })
      .where(and(eq(prMessages.channelId, channelId), eq(prMessages.messageTs, messageTs)))
      .run();
  }

  /**
   * Sets requiredTeams only when the rows have no value yet.
   * Used when message text is unavailable (link_shared) so that a subsequent
   * message event carrying explicit mentions can still override.
   */
  initMessageRequiredTeams(channelId: string, messageTs: string, teams: string[]): void {
    this.db
      .update(prMessages)
      .set({ requiredTeam: JSON.stringify(teams) })
      .where(
        and(
          eq(prMessages.channelId, channelId),
          eq(prMessages.messageTs, messageTs),
          isNull(prMessages.requiredTeam),
        ),
      )
      .run();
  }

  /** The resolved GitHub team slugs for a message. Empty array if none set. */
  messageRequiredTeams(channelId: string, messageTs: string): string[] {
    const row = this.db
      .select({ requiredTeam: prMessages.requiredTeam })
      .from(prMessages)
      .where(and(eq(prMessages.channelId, channelId), eq(prMessages.messageTs, messageTs)))
      .limit(1)
      .get();
    if (!row?.requiredTeam) return [];
    try {
      const parsed = JSON.parse(row.requiredTeam);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [row.requiredTeam];
    }
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

    const set: Parameters<ReturnType<typeof this.db.update>['set']>[0] = {
      state: result.state,
      approvals: result.approvals,
      requiredApprovals: result.requiredApprovals,
      lastPolledAt: now,
      closedAt,
      unreachableSince,
    };
    if ('codeownerStatus' in result) set.codeownerStatus = result.codeownerStatus ?? null;

    return this.db
      .update(trackedPrs)
      .set(set)
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

  /** Every PR linked in one Slack message — usually one, sometimes several. */
  prsForMessage(channelId: string, messageTs: string): TrackedPr[] {
    return this.db
      .select({ pr: trackedPrs })
      .from(prMessages)
      .innerJoin(trackedPrs, eq(prMessages.prId, trackedPrs.id))
      .where(and(eq(prMessages.channelId, channelId), eq(prMessages.messageTs, messageTs)))
      .all()
      .map((row) => row.pr);
  }

  /**
   * The managed reaction currently on a Slack message.
   *
   * `current_reaction` is stored on every row for the message and written to all
   * of them at once, so they agree. The one exception is a row inserted when a
   * new PR link is added to a message that already carries a reaction — that row
   * starts null, hence taking the first non-null value rather than the first row.
   */
  messageReaction(channelId: string, messageTs: string): string | null {
    const rows = this.db
      .select({ currentReaction: prMessages.currentReaction })
      .from(prMessages)
      .where(and(eq(prMessages.channelId, channelId), eq(prMessages.messageTs, messageTs)))
      .all();
    return rows.find((r) => r.currentReaction !== null)?.currentReaction ?? null;
  }

  /** Records the reaction now on a message, across all of its PR links. */
  setMessageReaction(channelId: string, messageTs: string, reaction: string | null): void {
    this.db
      .update(prMessages)
      .set({ currentReaction: reaction })
      .where(and(eq(prMessages.channelId, channelId), eq(prMessages.messageTs, messageTs)))
      .run();
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
