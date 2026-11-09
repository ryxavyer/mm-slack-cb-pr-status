import type { EmojiConfig } from './config.js';
import type { TrackedPr } from './db/schema.js';
import type { CodeownerRequirement, CodeownerStatus, PrState } from './types.js';

export interface StateInput {
  merged: boolean;
  closed: boolean;
  /** Reviewers currently blocking with a changes-requested review. */
  changesRequested: number;
  /** The codeowner bot's latest verdict, or null when it hasn't commented. */
  codeowners: CodeownerStatus | null;
  /** Whether anyone (other than the author or a bot) has reviewed the PR at all. */
  reviewed: boolean;
}

/**
 * The state machine for a PR as a whole. Order matters:
 * - A merged PR is merged regardless of its reviews, and a closed PR outranks
 *   its review state too.
 * - An outstanding changes-requested review outranks the codeowner bot's
 *   verdict. A blocked PR is not ready to merge, whatever else it collected.
 * - Approval is the codeowner bot's call alone. We never count approvals
 *   ourselves: we can't tell which team an approval came from, or how many a
 *   PR needs. No comment from the bot means no approval.
 * - Short of that, the only thing reviews decide is whether anyone has looked
 *   yet: `no_reviews` asks for a first reviewer, `in_review` is in between.
 */
export function computeState({
  merged,
  closed,
  changesRequested,
  codeowners,
  reviewed,
}: StateInput): PrState {
  if (merged) return 'merged';
  if (closed) return 'closed';
  if (changesRequested > 0) return 'changes_requested';
  if (codeowners?.allSatisfied) return 'approved';
  return reviewed ? 'in_review' : 'no_reviews';
}

/**
 * The state a PR shows on one message, given the GitHub team of the channel it
 * was posted in (null for a channel with no team set).
 *
 * Without a team this is just the PR's own state: "unreviewed", "in review",
 * "blocked", "approved by the codeowner bot" or "finished".
 *
 * With a team, a PR still waiting on reviews shows that team's part in it, as
 * the codeowner bot reports it:
 *   - `no_reviews` while any requirement naming the team is unsatisfied, even
 *     after other people have reviewed: the team is still needed.
 *   - `team_done` once the team's requirements are satisfied and another
 *     requirement is still open. Those other code owners' reviews will also
 *     cover the bot's review minimum, so nothing more is needed from the team.
 *   - `partial` once the team's requirements are satisfied, nothing else is
 *     open, and the bot reports exactly one of two required reviews: the one
 *     review still missing naturally falls to the team.
 *
 * A team the bot doesn't name gets the plain view. The bot says nothing about
 * that team, and we don't guess.
 */
export function messageState(pr: TrackedPr, team: string | null): PrState {
  const waiting = pr.state === 'no_reviews' || pr.state === 'in_review';
  if (!waiting || team === null || !pr.codeownerStatus) return pr.state;

  let status: CodeownerStatus;
  try {
    status = JSON.parse(pr.codeownerStatus) as CodeownerStatus;
  } catch {
    return pr.state;
  }

  const slug = team.toLowerCase();
  const names = (r: CodeownerRequirement) => r.teams.some((t) => t.toLowerCase() === slug);
  const teamReqs = status.requirements.filter(names);
  if (teamReqs.length === 0) return pr.state;
  if (teamReqs.some((r) => !r.satisfied)) return 'no_reviews';

  // Every requirement naming the team is satisfied, so any open one is someone else's.
  if (status.requirements.some((r) => !r.satisfied)) return 'team_done';
  const { minimum } = status;
  if (minimum?.required === 2 && minimum.found === 1) return 'partial';
  return 'in_review';
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
 * either PR is unreviewed, it needs eyes — so `no_reviews` beats `approved`. In a
 * channel set to a team, `no_reviews` also means "the team is still needed".
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
  'in_review',
  'partial',
  'team_done',
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
    case 'in_review':
      // Deliberately silent: somebody has looked, and only the codeowner bot
      // can say the PR is done.
      return null;
    case 'changes_requested':
      return emoji.changesRequested;
    case 'partial':
      return emoji.partial;
    case 'team_done':
      return emoji.teamDone;
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
    emoji.teamDone,
    emoji.approved,
    emoji.merged,
    emoji.closed,
    emoji.unknown,
  ].filter(
    (e): e is string => e !== null,
  );
}
