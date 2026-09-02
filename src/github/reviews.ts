/**
 * Approval counting, isolated from any HTTP concern so it can be unit tested
 * against fixtures.
 */

/** Reviewer identity. `id` is preferred; `login` is the fallback. */
export interface ReviewerRef {
  id?: number | null;
  login?: string | null;
}

export interface ReviewLike {
  user?: ReviewerRef | null;
  state?: string | null;
  submitted_at?: string | null;
}

/** Review states that express a reviewer's current position on the PR. */
const DECISIVE_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

function reviewerKey(user: ReviewerRef | null | undefined): string | null {
  const id = user?.id;
  if (typeof id === 'number') return `id:${id}`;
  const login = user?.login;
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

    const key = reviewerKey(review.user);
    if (!key) continue;

    const at = submittedAtMs(review);
    const previous = latest.get(key);
    // `>=` so that, among reviews sharing a timestamp, API order (chronological)
    // decides — the later entry wins.
    if (!previous || at >= previous.at) latest.set(key, { state, at });
  }

  return new Map([...latest].map(([key, value]) => [key, value.state]));
}

export interface ReviewSummary {
  /** Reviewers whose current position is "approved". */
  approvals: number;
  /** Reviewers currently blocking the PR with a changes-requested review. */
  changesRequested: number;
}

/**
 * Tallies the reviewers currently for and against the PR.
 *
 * `requestedReviewers` is the PR's live review-request list. A reviewer on it
 * has had their review re-requested, which GitHub does not record on the review
 * itself — the old review keeps its `CHANGES_REQUESTED` (or `APPROVED`) state
 * forever. Left alone, a reviewer who requested changes would block the PR for
 * good, however many times the author pushed a fix and asked them to look again.
 *
 * So a re-requested reviewer has no current position: GitHub moves them back to
 * "awaiting review", and so do we. That cuts both ways — re-requesting from
 * someone who had approved drops their approval too, because their sign-off was
 * for a version of the PR the author has since replaced.
 *
 * A review that was formally *dismissed* needs none of this: GitHub rewrites the
 * review's own state to `DISMISSED`, which already counts for neither side.
 */
export function summariseReviews(
  reviews: readonly ReviewLike[],
  requestedReviewers: readonly ReviewerRef[] = [],
): ReviewSummary {
  const reRequested = new Set(
    requestedReviewers.map((user) => reviewerKey(user)).filter((key): key is string => key !== null),
  );

  const summary: ReviewSummary = { approvals: 0, changesRequested: 0 };
  for (const [key, state] of latestReviewByReviewer(reviews)) {
    if (reRequested.has(key)) continue;
    if (state === 'APPROVED') summary.approvals += 1;
    else if (state === 'CHANGES_REQUESTED') summary.changesRequested += 1;
  }
  return summary;
}

/** Number of reviewers whose current position is "approved". */
export function countApprovals(
  reviews: readonly ReviewLike[],
  requestedReviewers: readonly ReviewerRef[] = [],
): number {
  return summariseReviews(reviews, requestedReviewers).approvals;
}
