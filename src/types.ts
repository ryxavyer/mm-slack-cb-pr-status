/**
 * The states a PR can show. `unknown` is orthogonal to the rest — it means
 * GitHub stopped telling us anything about this PR (expired token, revoked
 * access, repo gone), so the last state we computed can no longer be trusted.
 *
 * `no_reviews` is a PR nobody has reviewed yet; `in_review` is one somebody
 * has, that the codeowner bot isn't satisfied with yet. In a channel set to a
 * team, a message also shows `no_reviews` while that team is still needed.
 *
 * `partial` and `team_done` only ever describe a PR as seen from a channel set
 * to a team; they are never stored on the PR itself. Everywhere else a PR is
 * either unreviewed, in review, blocked, approved by the codeowner bot, or
 * finished.
 */
export const PR_STATES = [
  'no_reviews',
  'in_review',
  'changes_requested',
  'partial',
  'team_done',
  'approved',
  'merged',
  'closed',
  'unknown',
] as const;

export type PrState = (typeof PR_STATES)[number];

export function isPrState(value: unknown): value is PrState {
  return typeof value === 'string' && (PR_STATES as readonly string[]).includes(value);
}

export interface CodeownerRequirement {
  /** Slugs of the teams in this requirement (no org prefix). Length > 1 = OR group. */
  teams: string[];
  satisfied: boolean;
}

export interface CodeownerStatus {
  requirements: CodeownerRequirement[];
  minimum: { required: number; found: number; met: boolean } | null;
  allSatisfied: boolean;
}

/** A PR reference parsed out of a Slack message. */
export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

export function prRefKey(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}
