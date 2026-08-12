import { isWatchedChannel, type Config } from './config.js';
import type { TrackedPr } from './db/schema.js';
import type { Store } from './db/store.js';
import { PrUnreachableError, type GitHubClient } from './github/client.js';
import type { Logger } from './logger.js';
import type { Reconciler } from './reconciler.js';
import { computeState } from './state.js';
import { prRefKey, type PrRef, type PrState } from './types.js';

export interface CycleSummary {
  polled: number;
  changed: number;
  failed: number;
  /** PRs forgotten because they were merged/closed past the TTL. */
  cleaned: number;
  /** PRs given up on because they stayed unreachable past the TTL. */
  retired: number;
}

/**
 * The core use cases: start tracking links found in a message, poll a PR and
 * reconcile its reactions, and run the periodic sweep.
 */
export class PrService {
  constructor(
    private readonly store: Store,
    private readonly github: GitHubClient,
    private readonly reconciler: Reconciler,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  /**
   * Records the PRs linked by a Slack message and polls each one straight away,
   * so the emoji lands within seconds of posting instead of at the next cycle.
   *
   * Idempotent: re-delivered events, message edits and duplicate links all
   * converge on the same rows.
   */
  async trackLinks(channelId: string, messageTs: string, refs: PrRef[]): Promise<void> {
    if (!isWatchedChannel(this.config, channelId)) {
      this.logger.debug({ channel: channelId }, 'ignoring links from unwatched channel');
      return;
    }

    // Link every PR before polling any of them. The reaction is an aggregate
    // over all the PRs on a message, so polling as we go would reconcile against
    // a half-built set — briefly showing (and paying Slack for) an emoji that the
    // next link immediately overrides.
    const tracked: TrackedPr[] = [];
    for (const ref of refs) {
      const log = this.logger.child({ pr: prRefKey(ref), channel: channelId, messageTs });

      if (!this.isWatchedRepo(ref)) {
        // Never tracked at all, so the message simply gets no reaction. Without
        // this, a link to a repo the token can't see would 404 and show up as
        // `unknown` — "I lost access" when the truth is "not my repo".
        log.debug('ignoring pr link outside the repo allowlist');
        continue;
      }

      try {
        const pr = this.store.upsertPr(ref, this.config.requiredApprovals);
        const message = this.store.linkMessage(pr.id, channelId, messageTs);
        log.info({ prId: pr.id, messageId: message.id, state: pr.state }, 'tracking pr link');
        tracked.push(pr);
      } catch (error) {
        log.error({ err: error }, 'failed to track pr link');
      }
    }

    for (const pr of tracked) {
      try {
        await this.pollPr(pr);
      } catch (error) {
        this.logger
          .child({ pr: `${pr.owner}/${pr.repo}#${pr.number}`, channel: channelId, messageTs })
          .error({ err: error }, 'failed to poll newly tracked pr');
      }
    }
  }

  /** An empty `WATCHED_REPOS` allows every repo the GitHub token can see. */
  private isWatchedRepo(ref: PrRef): boolean {
    const allowed = this.config.watchedRepos;
    return allowed.size === 0 || allowed.has(`${ref.owner}/${ref.repo}`);
  }

  /**
   * Fetches one PR, persists any state change, then reconciles reactions.
   *
   * Reconciliation runs on every poll, not only on change: it is a no-op when the
   * messages already carry the right emoji, and it is what repairs reactions
   * after a failed Slack call or a restart.
   */
  async pollPr(pr: TrackedPr): Promise<{ changed: boolean }> {
    const ref: PrRef = { owner: pr.owner, repo: pr.repo, number: pr.number };
    const log = this.logger.child({ pr: prRefKey(ref), prId: pr.id });

    const requiredApprovals = this.config.requiredApprovals;
    let state: PrState;
    let approvals: number;

    try {
      const status = await this.github.fetchPrStatus(ref);
      state = computeState({
        merged: status.merged,
        closed: status.closed,
        approvals: status.approvals,
        changesRequested: status.changesRequested,
        requiredApprovals,
      });
      approvals = status.approvals;
    } catch (error) {
      if (!(error instanceof PrUnreachableError)) throw error;

      // GitHub will not tell us anything: an expired or unauthorised token, a
      // repo we lost access to, or one that is gone. We can't distinguish those,
      // and we must not claim the PR is closed — so say "unknown" out loud and
      // keep polling, which restores the real state as soon as access returns.
      state = 'unknown';
      approvals = pr.approvals;
      if (pr.state !== 'unknown') {
        log.warn(
          { reason: error.reason, status: error.status, previousState: pr.state },
          'pr unreachable on github; showing unknown until access is restored',
        );
      }
    }

    const changed = state !== pr.state || approvals !== pr.approvals;
    const updated = this.store.recordPoll(pr.id, {
      state,
      approvals,
      requiredApprovals,
    }) ?? { ...pr, state, approvals };

    if (state !== pr.state) {
      log.info(
        { from: pr.state, to: state, approvals, requiredApprovals },
        'pr state transition',
      );
    } else if (changed) {
      log.debug({ state, approvals }, 'approval count changed');
    }

    const summary = await this.reconciler.reconcilePr(updated);
    if (summary.added || summary.removed || summary.droppedMessages || summary.failed) {
      log.info({ state, ...summary }, 'reactions reconciled');
    }

    return { changed };
  }

  /**
   * One full sweep: poll every non-terminal PR, then expire long-closed rows.
   * A failure on one PR is logged and skipped — it must not abort the cycle.
   */
  async runCycle(): Promise<CycleSummary> {
    const prs = this.store.listActivePrs();
    const summary: CycleSummary = { polled: 0, changed: 0, failed: 0, cleaned: 0, retired: 0 };

    for (const pr of prs) {
      try {
        const { changed } = await this.pollPr(pr);
        summary.polled += 1;
        if (changed) summary.changed += 1;
      } catch (error) {
        summary.failed += 1;
        this.store.touchPolledAt(pr.id);
        this.logger.error(
          { pr: `${pr.owner}/${pr.repo}#${pr.number}`, err: error },
          'poll failed for pr',
        );
      }
    }

    const { expired, retired } = await this.cleanup();
    summary.cleaned = expired;
    summary.retired = retired;
    return summary;
  }

  /**
   * Two housekeeping passes:
   * - PRs merged/closed longer ago than `CLEANUP_TTL_DAYS` are forgotten.
   * - PRs unreachable for longer than `UNREACHABLE_TTL_DAYS` are given up on. We
   *   strip our reaction first, so a message we no longer maintain isn't left
   *   wearing a permanent :sleeping:.
   */
  async cleanup(now = Date.now()): Promise<{ expired: number; retired: number }> {
    const expired = this.store.deleteClosedBefore(now - this.config.cleanupTtlMs);
    if (expired > 0) {
      this.logger.info({ expired }, 'cleaned up expired tracked prs');
    }

    let retired = 0;
    for (const pr of this.store.listUnreachableBefore(now - this.config.unreachableTtlMs)) {
      const log = this.logger.child({ pr: `${pr.owner}/${pr.repo}#${pr.number}`, prId: pr.id });
      try {
        // Drop the PR first, then recompute each message it was on: any other PR
        // still linked there takes over the reaction, and a message left with no
        // PRs simply loses it.
        const messages = this.store.messagesForPr(pr.id).map((message) => ({
          channelId: message.channelId,
          messageTs: message.messageTs,
          // Read before the delete removes the rows that hold it.
          current: this.store.messageReaction(message.channelId, message.messageTs),
        }));
        this.store.deletePr(pr.id);
        for (const message of messages) {
          await this.reconciler.reconcileMessage(
            message.channelId,
            message.messageTs,
            message.current,
          );
        }
        retired += 1;
        log.warn(
          { unreachableSince: pr.unreachableSince },
          'giving up on unreachable pr; reaction removed and untracked',
        );
      } catch (error) {
        log.error({ err: error }, 'failed to retire unreachable pr');
      }
    }

    return { expired, retired };
  }
}
