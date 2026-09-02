import type { EmojiConfig } from './config.js';
import type { TrackedPr } from './db/schema.js';
import type { Store } from './db/store.js';
import type { Logger } from './logger.js';
import { slackErrorCode, type ReactionClient } from './slack/reactions.js';
import { aggregateState, computeCodeownerState, emojiForState } from './state.js';

export interface ReconcileSummary {
  added: number;
  removed: number;
  unchanged: number;
  droppedMessages: number;
  failed: number;
}

const emptySummary = (): ReconcileSummary => ({
  added: 0,
  removed: 0,
  unchanged: 0,
  droppedMessages: 0,
  failed: 0,
});

/**
 * Keeps exactly one managed reaction on each message that links a PR.
 *
 * Only emoji from the configured managed set are ever added, and removals only
 * target the emoji this bot recorded applying — human reactions are untouched
 * (Slack's `reactions.remove` enforces the other half of that for us).
 */
export class Reconciler {
  constructor(
    private readonly store: Store,
    private readonly reactions: ReactionClient,
    private readonly emoji: EmojiConfig,
    private readonly logger: Logger,
  ) {}

  /**
   * Reconciles every Slack message that links `pr`. Each message is recomputed
   * from *all* the PRs on it, not just this one — see `reconcileMessage`.
   */
  async reconcilePr(pr: TrackedPr): Promise<ReconcileSummary> {
    const summary = emptySummary();
    const seen = new Set<string>();

    for (const message of this.store.messagesForPr(pr.id)) {
      const key = `${message.channelId}/${message.messageTs}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const result = await this.reconcileMessage(message.channelId, message.messageTs);
      summary.added += result.added;
      summary.removed += result.removed;
      summary.unchanged += result.unchanged;
      summary.droppedMessages += result.droppedMessages;
      summary.failed += result.failed;
    }

    return summary;
  }

  /**
   * Brings one Slack message to its single correct reaction: remove the stale
   * one, add the new one, persist.
   *
   * The target is the aggregate over every PR linked in the message, because a
   * Slack reaction belongs to the message rather than to any one PR. Two PRs in
   * the same state would otherwise both claim the same physical reaction, and
   * whichever moved on first would remove it out from under the other.
   *
   * The DB write happens immediately after each successful Slack call, so that a
   * failure mid-transition leaves an accurate record of what is actually on the
   * message — the next cycle then retries from there instead of trying to remove
   * an emoji that is no longer present.
   */
  async reconcileMessage(
    channelId: string,
    messageTs: string,
    /**
     * The reaction known to be on the message, for callers that have just
     * deleted the rows recording it (the retire path). Without it those rows are
     * gone, the reaction reads as null, and a stale emoji is left behind.
     */
    knownCurrent?: string | null,
  ): Promise<ReconcileSummary> {
    const summary = emptySummary();
    const prs = this.store.prsForMessage(channelId, messageTs);
    const state = aggregateState(prs.map((p) => computeCodeownerState(p)));
    const target = state ? emojiForState(state, this.emoji) : null;
    const current =
      knownCurrent !== undefined ? knownCurrent : this.store.messageReaction(channelId, messageTs);

    const log = this.logger.child({
      channel: channelId,
      messageTs,
      prs: prs.map((p) => `${p.owner}/${p.repo}#${p.number}`),
      state,
    });

    if (current === target) {
      summary.unchanged += 1;
      return summary;
    }

    const input = { channel: channelId, timestamp: messageTs };

    if (current) {
      const outcome = await this.call('remove', input, current, log);
      if (outcome === 'message_gone') {
        summary.droppedMessages += this.store.deleteMessagesByTs(channelId, messageTs);
        return summary;
      }
      if (outcome === 'failed') {
        summary.failed += 1;
        return summary;
      }
      this.store.setMessageReaction(channelId, messageTs, null);
      summary.removed += 1;
    }

    if (target) {
      const outcome = await this.call('add', input, target, log);
      if (outcome === 'message_gone') {
        summary.droppedMessages += this.store.deleteMessagesByTs(channelId, messageTs);
        return summary;
      }
      if (outcome === 'failed') {
        summary.failed += 1;
        return summary;
      }
      this.store.setMessageReaction(channelId, messageTs, target);
      summary.added += 1;
    }

    log.info({ target, previous: current }, 'reaction reconciled');
    return summary;
  }

  /**
   * A single reactions.add/remove call, with Slack's benign outcomes folded into
   * success:
   * - `already_reacted` — the emoji we wanted to add is already there.
   * - `no_reaction`     — the emoji we wanted to remove is already gone.
   * - `message_not_found` / `channel_not_found` — the message is unreachable, so
   *   the caller drops its row rather than retrying every cycle.
   */
  private async call(
    op: 'add' | 'remove',
    target: { channel: string; timestamp: string },
    name: string,
    log: Logger,
  ): Promise<'ok' | 'message_gone' | 'failed'> {
    const input = { ...target, name };
    try {
      if (op === 'add') await this.reactions.add(input);
      else await this.reactions.remove(input);
      return 'ok';
    } catch (error) {
      const code = slackErrorCode(error);

      if (op === 'add' && code === 'already_reacted') return 'ok';
      if (op === 'remove' && code === 'no_reaction') return 'ok';
      if (code === 'message_not_found' || code === 'channel_not_found') {
        log.info({ op, name, code }, 'message unreachable, untracking it');
        return 'message_gone';
      }

      if (code === 'invalid_name' || code === 'emoji_not_found') {
        // Misconfigured emoji: log loudly, once per attempt, and keep going.
        log.error({ op, name, code }, 'emoji does not exist in this workspace');
        return 'failed';
      }

      log.error({ op, name, code, err: error }, 'slack reaction call failed');
      return 'failed';
    }
  }
}
