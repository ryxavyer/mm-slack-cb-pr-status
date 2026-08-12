import type { EmojiConfig } from './config.js';
import type { PrState } from './types.js';

export interface StateInput {
  merged: boolean;
  closed: boolean;
  approvals: number;
  requiredApprovals: number;
}

/**
 * The state machine. Order matters: a merged PR is merged regardless of how many
 * approvals it collected, and a closed PR outranks its review state too.
 */
export function computeState({
  merged,
  closed,
  approvals,
  requiredApprovals,
}: StateInput): PrState {
  if (merged) return 'merged';
  if (closed) return 'closed';
  if (approvals >= requiredApprovals) return 'approved';
  if (approvals > 0) return 'partial';
  return 'no_reviews';
}

/**
 * A PR in one of these states is finished; we stop polling it.
 *
 * `unknown` is deliberately not terminal: we keep polling an unreachable PR so
 * that fixing the token silently restores the right emoji.
 */
export function isTerminal(state: PrState): boolean {
  return state === 'merged' || state === 'closed';
}

/**
 * Precedence for a message linking several PRs: the *least settled* state wins.
 *
 * A Slack reaction belongs to the message, not to any one PR, so a message with
 * two PR links gets one emoji answering "does this message still need eyes?".
 * If either PR is unreviewed, it does — so `no_reviews` beats `approved`.
 *
 * `unknown` outranks everything: if we can't see one of the PRs, we must not
 * claim the message as a whole is approved or merged.
 */
const AGGREGATE_PRECEDENCE: readonly PrState[] = [
  'unknown',
  'no_reviews',
  'partial',
  'approved',
  'closed',
  'merged',
];

/**
 * The single state a message reports for all the PRs linked in it. For one PR
 * this is just that PR's state.
 */
export function aggregateState(states: readonly PrState[]): PrState | null {
  if (states.length === 0) return null;
  const present = new Set(states);
  for (const state of AGGREGATE_PRECEDENCE) {
    if (present.has(state)) return state;
  }
  return null;
}

/**
 * The single managed emoji for a state, or null when the state should carry no
 * reaction ('no_reviews', or a state whose emoji has been configured empty).
 */
export function emojiForState(state: PrState, emoji: EmojiConfig): string | null {
  switch (state) {
    case 'no_reviews':
      return null;
    case 'partial':
      return emoji.partial;
    case 'approved':
      return emoji.approved;
    case 'merged':
      return emoji.merged;
    case 'closed':
      return emoji.closed;
    case 'unknown':
      return emoji.unknown;
  }
}

/**
 * Every emoji the bot is allowed to touch. Used to reason about (and log) the
 * managed set; the bot never adds or removes anything outside it.
 */
export function managedEmojis(emoji: EmojiConfig): string[] {
  return [emoji.partial, emoji.approved, emoji.merged, emoji.closed, emoji.unknown].filter(
    (e): e is string => e !== null,
  );
}
