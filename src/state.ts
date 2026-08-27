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
 * Determines the emoji state for a PR from the perspective of a specific Slack
 * message, incorporating codeowner status when available.
 *
 * Codeowner data only applies when the message resolved to a team — a channel in
 * the team map, or a group mention. The whole point of the check is to answer
 * "does *this* team still owe a review?", and a message with no team context is
 * not asking that question, so there the plain approval count stands.
 *
 * With a `teamSlug`:
 *   - Team's requirements satisfied + minimum met → approved
 *   - Team's requirements satisfied + minimum outstanding → partial
 *   - Team still owes a review → whatever the approval count earned, capped
 *     below approved (an otherwise-approved PR shows partial)
 *   - Team in no requirement (PR doesn't touch their files) → pr.state
 *
 * Codeowner status can only ever hold back the approved emoji; it must never
 * take a message from an emoji down to none. "No codeowner sign-off yet" and
 * "nobody has looked at this at all" are different things, and collapsing the
 * first into the second silently strips the reaction off the message.
 *
 * Terminal and blocking states (merged, closed, unknown, changes_requested)
 * always pass through unchanged regardless of codeowner context.
 */
export function computeCodeownerState(pr: TrackedPr, teamSlug?: string): PrState {
  if (
    pr.state === 'merged' ||
    pr.state === 'closed' ||
    pr.state === 'unknown' ||
    pr.state === 'changes_requested'
  ) {
    return pr.state;
  }

  if (!teamSlug || !pr.codeownerStatus) return pr.state;

  let status: CodeownerStatus;
  try {
    status = JSON.parse(pr.codeownerStatus) as CodeownerStatus;
  } catch {
    return pr.state;
  }

  if (status.allSatisfied) return 'approved';

  // The PR does not touch this team's files, so their codeowner status says
  // nothing about it either way.
  const teamReqs = status.requirements.filter((r) => r.teams.includes(teamSlug));
  if (teamReqs.length === 0) return pr.state;

  // Still waiting on this team: hold back the green check, but keep whatever the
  // approval count already earned rather than going bare.
  if (!teamReqs.every((r) => r.satisfied)) {
    return pr.state === 'approved' ? 'partial' : pr.state;
  }

  // The team has signed off. A minimum the codeowner bot still reports
  // outstanding keeps this at partial — GitHub will not let the PR merge yet.
  return status.minimum === null || status.minimum.met ? 'approved' : 'partial';
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
 * The single managed emoji for a state, or null when the state should carry no
 * reaction ('no_reviews', or a state whose emoji has been configured empty).
 */
export function emojiForState(state: PrState, emoji: EmojiConfig): string | null {
  switch (state) {
    case 'no_reviews':
      return null;
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
