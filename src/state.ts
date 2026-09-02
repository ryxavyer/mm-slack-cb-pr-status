import type { EmojiConfig } from './config.js';
import type { TrackedPr } from './db/schema.js';
import type { CodeownerStatus, PrState } from './types.js';

export interface StateInput {
  merged: boolean;
  closed: boolean;
  approvals: number;
  /** Reviewers currently blocking with a changes-requested review. */
  changesRequested: number;
  requiredApprovals: number;
}

/**
 * The state machine. Order matters:
 * - A merged PR is merged regardless of how many approvals it collected, and a
 *   closed PR outranks its review state too.
 * - An outstanding changes-requested review outranks *any* approval count. Two
 *   approvals plus one reviewer blocking is not ready to merge, and showing it
 *   as approved would be actively misleading.
 */
export function computeState({
  merged,
  closed,
  approvals,
  changesRequested,
  requiredApprovals,
}: StateInput): PrState {
  if (merged) return 'merged';
  if (closed) return 'closed';
  if (changesRequested > 0) return 'changes_requested';
  if (approvals >= requiredApprovals) return 'approved';
  if (approvals > 0) return 'partial';
  return 'no_reviews';
}

/**
 * Applies the codeowner bot's view on top of the approval count.
 *
 * The approval count decides the state. Codeowner data contributes exactly one
 * thing: while any review group is still outstanding the PR is not finished, so
 * it may not show as approved.
 *
 *   - approved + a group outstanding -> partial
 *   - anything else                  -> the count's own answer
 *
 * It only ever holds a PR back, never advances one: a bot reporting every group
 * satisfied does not by itself make a PR approved, because `REQUIRED_APPROVALS`
 * still has to be met.
 *
 * Which channel the message is in makes no difference, and the bot's own
 * "Need N reviews, found M" minimum is deliberately not consulted —
 * `REQUIRED_APPROVALS` is the only count that decides.
 *
 * Terminal and blocking states (merged, closed, unknown, changes_requested)
 * always pass through unchanged.
 */
export function computeCodeownerState(pr: TrackedPr): PrState {
  if (
    pr.state === 'merged' ||
    pr.state === 'closed' ||
    pr.state === 'unknown' ||
    pr.state === 'changes_requested'
  ) {
    return pr.state;
  }

  if (!pr.codeownerStatus) return pr.state;

  let status: CodeownerStatus;
  try {
    status = JSON.parse(pr.codeownerStatus) as CodeownerStatus;
  } catch {
    return pr.state;
  }

  if (!status.requirements.some((r) => !r.satisfied)) return pr.state;

  // A group still owes a review, so the PR is not finished no matter what the
  // count says. Nothing below approved needs adjusting: it already reads as
  // unfinished.
  return pr.state === 'approved' ? 'partial' : pr.state;
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
 * Precedence for a message linking several PRs: whichever state most deserves
 * attention wins.
 *
 * A Slack reaction belongs to the message, not to any one PR, so a message with
 * two PR links gets one emoji answering "what does this message need?". If
 * either PR is unreviewed, it needs eyes — so `no_reviews` beats `approved`.
 *
 * `unknown` outranks everything: if we can't see one of the PRs, we must not
 * claim the message as a whole is approved or merged. `changes_requested` comes
 * next, ahead of `no_reviews`, because a blocked PR is worth showing rather than
 * hiding behind the no-emoji state.
 */
const AGGREGATE_PRECEDENCE: readonly PrState[] = [
  'unknown',
  'changes_requested',
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
 * The single managed emoji for a state, or null when that state's emoji has been
 * configured empty — which is how a state is opted out of carrying a reaction.
 */
export function emojiForState(state: PrState, emoji: EmojiConfig): string | null {
  switch (state) {
    case 'no_reviews':
      return emoji.noReviews;
    case 'changes_requested':
      return emoji.changesRequested;
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
  return [
    emoji.noReviews,
    emoji.changesRequested,
    emoji.partial,
    emoji.approved,
    emoji.merged,
    emoji.closed,
    emoji.unknown,
  ].filter(
    (e): e is string => e !== null,
  );
}
