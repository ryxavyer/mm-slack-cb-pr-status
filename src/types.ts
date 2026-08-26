/**
 * The states a tracked PR can be in. The first five follow the PR's lifecycle;
 * `unknown` is orthogonal — it means GitHub stopped telling us anything about
 * this PR (expired token, revoked access, repo gone), so the last state we
 * computed can no longer be trusted.
 */
export const PR_STATES = [
  'no_reviews',
  'changes_requested',
  'partial',
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
