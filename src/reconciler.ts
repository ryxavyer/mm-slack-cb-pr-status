import type { EmojiConfig } from './config.js';
import type { PrMessage, TrackedPr } from './db/schema.js';
import type { Store } from './db/store.js';
import type { Logger } from './logger.js';
import { slackErrorCode, type ReactionClient } from './slack/reactions.js';
import { emojiForState } from './state.js';

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

  /** Brings every message linked to `pr` in line with the PR's current state. */
  async reconcilePr(pr: TrackedPr): Promise<ReconcileSummary> {
    return this.applyTarget(pr, emojiForState(pr.state, this.emoji));
  }

  /**
   * Removes our managed reaction from every message linking `pr`, leaving none.
   * Used when giving up on a PR, so we don't leave a stale emoji behind on a
   * message we have stopped maintaining.
   */
  async clearPr(pr: TrackedPr): Promise<ReconcileSummary> {
    return this.applyTarget(pr, null);
  }

  private async applyTarget(pr: TrackedPr, target: string | null): Promise<ReconcileSummary> {
    const messages = this.store.messagesForPr(pr.id);
    const summary = emptySummary();

    for (const message of messages) {
      const result = await this.reconcileMessage(message, target, pr);
      summary.added += result.added;
      summary.removed += result.removed;
      summary.unchanged += result.unchanged;
      summary.droppedMessages += result.droppedMessages;
      summary.failed += result.failed;
    }

    return summary;
  }

  /**
   * Transition one message: remove the stale reaction, add the new one, persist.
   *
   * The DB write happens immediately after each successful Slack call so that a
   * failure mid-transition leaves an accurate record of what is actually on the
   * message — the next cycle then retries from there instead of trying to remove
   * an emoji that is no longer present.
   */
  private async reconcileMessage(
    message: PrMessage,
    target: string | null,
    pr: TrackedPr,
  ): Promise<ReconcileSummary> {
    const summary = emptySummary();
    const log = this.logger.child({
      pr: `${pr.owner}/${pr.repo}#${pr.number}`,
      state: pr.state,
      channel: message.channelId,
      messageTs: message.messageTs,
    });

    if (message.currentReaction === target) {
      summary.unchanged += 1;
      return summary;
    }

    if (message.currentReaction) {
      const outcome = await this.call('remove', message, message.currentReaction, log);
      if (outcome === 'message_gone') {
        this.store.deleteMessage(message.id);
        summary.droppedMessages += 1;
        return summary;
      }
      if (outcome === 'failed') {
        summary.failed += 1;
        return summary;
      }
      this.store.setCurrentReaction(message.id, null);
      summary.removed += 1;
    }

    if (target) {
      const outcome = await this.call('add', message, target, log);
      if (outcome === 'message_gone') {
        this.store.deleteMessage(message.id);
        summary.droppedMessages += 1;
        return summary;
      }
      if (outcome === 'failed') {
        summary.failed += 1;
        return summary;
      }
      this.store.setCurrentReaction(message.id, target);
      summary.added += 1;
    }

    log.info({ target, previous: message.currentReaction }, 'reaction reconciled');
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
    message: PrMessage,
    name: string,
    log: Logger,
  ): Promise<'ok' | 'message_gone' | 'failed'> {
    const input = { channel: message.channelId, timestamp: message.messageTs, name };
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
