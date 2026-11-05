/**
 * Review tallying, isolated from any HTTP concern so it can be unit tested
 * against fixtures.
 */

/** Reviewer identity. `id` is preferred; `login` is the fallback. */
export interface ReviewerRef {
  id?: number | null;
  login?: string | null;
  /** GitHub's account type: 'User', or 'Bot' for apps. */
  type?: string | null;
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

/**
 * Reviewers currently blocking the PR with a changes-requested review. Approval
 * is not tallied: it is the codeowner bot's call, not a count.
 *
 * `requestedReviewers` is the PR's live review-request list. A reviewer on it
 * has had their review re-requested, which GitHub does not record on the review
 * itself — the old review keeps its `CHANGES_REQUESTED` state forever. Left
 * alone, a reviewer who requested changes would block the PR for good, however
 * many times the author pushed a fix and asked them to look again. So a
 * re-requested reviewer has no current position: GitHub moves them back to
 * "awaiting review", and so do we.
 *
 * A review that was formally *dismissed* needs none of this: GitHub rewrites the
 * review's own state to `DISMISSED`, which does not block.
 */
export function countChangesRequested(
  reviews: readonly ReviewLike[],
  requestedReviewers: readonly ReviewerRef[] = [],
): number {
  const reRequested = new Set(
    requestedReviewers.map((user) => reviewerKey(user)).filter((key): key is string => key !== null),
  );

  let blocking = 0;
  for (const [key, state] of latestReviewByReviewer(reviews)) {
    if (reRequested.has(key)) continue;
    if (state === 'CHANGES_REQUESTED') blocking += 1;
  }
  return blocking;
}

/** Review states that mean someone submitted a review, whatever its verdict. */
const SUBMITTED_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED']);

/**
 * Whether anyone has reviewed the PR at all — the line between "needs a first
 * reviewer" and "in review". Any submitted review counts, including a
 * comment-only one, one later dismissed and one since re-requested: each means
 * someone has looked. The PR's author, bot accounts and the logins in `ignore`
 * (the codeowner bot) don't count.
 */
export function hasHumanReview(
  reviews: readonly ReviewLike[],
  author: ReviewerRef | null | undefined,
  ignore: readonly string[] = [],
): boolean {
  const authorKey = reviewerKey(author);
  const ignored = new Set(ignore.map((login) => login.toLowerCase()));

  return reviews.some((review) => {
    const state = review.state?.toUpperCase();
    if (!state || !SUBMITTED_STATES.has(state)) return false;
    const user = review.user;
    if (!user || user.type === 'Bot') return false;
    if (user.login && ignored.has(user.login.toLowerCase())) return false;
    const key = reviewerKey(user);
    return key !== null && key !== authorKey;
  });
}
