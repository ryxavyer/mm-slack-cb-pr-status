/**
 * Approval counting, isolated from any HTTP concern so it can be unit tested
 * against fixtures.
 */

export interface ReviewLike {
  /** Reviewer identity. `id` is preferred; `login` is the fallback. */
  user?: { id?: number | null; login?: string | null } | null;
  state?: string | null;
  submitted_at?: string | null;
}

/** Review states that express a reviewer's current position on the PR. */
const DECISIVE_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

function reviewerKey(review: ReviewLike): string | null {
  const id = review.user?.id;
  if (typeof id === 'number') return `id:${id}`;
  const login = review.user?.login;
  if (login) return `login:${login.toLowerCase()}`;
  return null;
}

function submittedAtMs(review: ReviewLike): number {
  const ts = review.submitted_at ? Date.parse(review.submitted_at) : Number.NaN;
  return Number.isNaN(ts) ? 0 : ts;
}

/**
 * Reduces a PR's review list to each reviewer's *current* position.
 *
 * Two subtleties, both matching GitHub's own behaviour:
 * - Only the latest review per reviewer counts — approve-then-request-changes
 *   must not still read as an approval.
 * - `COMMENTED` and `PENDING` reviews are not positions, so they cannot
 *   supersede an earlier approval. They are dropped before grouping.
 *
 * Reviews arrive in chronological order from the API, but we compare
 * `submitted_at` explicitly rather than trusting order.
 */
export function latestReviewByReviewer(reviews: readonly ReviewLike[]): Map<string, string> {
  const latest = new Map<string, { state: string; at: number }>();

  for (const review of reviews) {
    const state = review.state?.toUpperCase();
    if (!state || !DECISIVE_STATES.has(state)) continue;

    const key = reviewerKey(review);
    if (!key) continue;

    const at = submittedAtMs(review);
    const previous = latest.get(key);
    // `>=` so that, among reviews sharing a timestamp, API order (chronological)
    // decides — the later entry wins.
    if (!previous || at >= previous.at) latest.set(key, { state, at });
  }

  return new Map([...latest].map(([key, value]) => [key, value.state]));
}

/** Number of reviewers whose current position is "approved". */
export function countApprovals(reviews: readonly ReviewLike[]): number {
  let approvals = 0;
  for (const state of latestReviewByReviewer(reviews).values()) {
    if (state === 'APPROVED') approvals += 1;
  }
  return approvals;
}
