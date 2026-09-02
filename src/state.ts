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
 * There are two questions a reaction can answer, and which one is right depends
 * on who is reading it.
 *
 * **Public channels, and anywhere without a team (the default).** Several teams
 * watch these, so the reaction has to mean "is this PR ready?". The count
 * decides, and codeowner data does exactly one thing: while any review group is
 * outstanding the PR is not finished, so it may not show as approved. It can
 * only ever hold a PR back — one team's sign-off must never advance the emoji,
 * because it would be claiming something on behalf of the other groups reading.
 *
 * **A private channel mapped to a team.** Only that team is in the room, so the
 * reaction answers the narrower and more useful "do we still owe a review?":
 *
 *   - Team's group outstanding      -> held below approved
 *   - Team's group signed off       -> approved, even on a single approval,
 *                                      provided somebody is going to meet the
 *                                      approval count
 *   - Team's group signed off, count short, and no other group left to meet it
 *                                   -> held at partial: the next approval has to
 *                                      come from this team
 *   - Team owns none of the changed files -> the approval count alone; the only
 *                                      thing they can still owe is a +1 towards
 *                                      it, and another group's outstanding
 *                                      review is not this channel's question
 *
 * Terminal and blocking states (merged, closed, unknown, changes_requested)
 * always pass through unchanged.
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

  if (!pr.codeownerStatus) return pr.state;

  let status: CodeownerStatus;
  try {
    status = JSON.parse(pr.codeownerStatus) as CodeownerStatus;
  } catch {
    return pr.state;
  }

  const outstanding = status.requirements.filter((r) => !r.satisfied);

  if (teamSlug) {
    const teamReqs = status.requirements.filter((r) => r.teams.includes(teamSlug));

    // The team owns none of the changed files. Nothing is owed of them beyond
    // an approval towards the count, so the count alone answers it — another
    // group's outstanding review is not this channel's question, and holding
    // the message at partial over it would be asking for an action nobody here
    // can take.
    if (teamReqs.length === 0) return pr.state;

    if (!teamReqs.every((r) => r.satisfied)) {
      return pr.state === 'approved' ? 'partial' : pr.state;
    }

    // This team is done. The only thing that can still be owed of them is
    // another approval to meet the count, and only when no other group is left
    // whose sign-off would meet it instead.
    if (pr.state === 'approved' || outstanding.length > 0) return 'approved';
    return pr.state;
  }

  if (outstanding.length === 0) return pr.state;
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
