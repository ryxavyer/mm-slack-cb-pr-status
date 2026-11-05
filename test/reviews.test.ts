import { describe, expect, it } from 'vitest';
import {
  countChangesRequested,
  latestReviewByReviewer,
  type ReviewLike,
} from '../src/github/reviews.js';

const review = (id: number, state: string, submitted_at: string): ReviewLike => ({
  user: { id, login: `user${id}` },
  state,
  submitted_at,
});

describe('countChangesRequested', () => {
  it('counts one block per blocking reviewer, ignoring approvals', () => {
    expect(
      countChangesRequested([
        review(1, 'APPROVED', '2026-08-01T10:00:00Z'),
        review(2, 'CHANGES_REQUESTED', '2026-08-01T11:00:00Z'),
        review(3, 'CHANGES_REQUESTED', '2026-08-01T12:00:00Z'),
      ]),
    ).toBe(2);
  });

  it('counts only the latest review per reviewer', () => {
    // Request changes, then approve: no longer blocking.
    expect(
      countChangesRequested([
        review(1, 'CHANGES_REQUESTED', '2026-08-01T10:00:00Z'),
        review(1, 'APPROVED', '2026-08-01T12:00:00Z'),
      ]),
    ).toBe(0);

    // ...and the other direction.
    expect(
      countChangesRequested([
        review(1, 'APPROVED', '2026-08-01T10:00:00Z'),
        review(1, 'CHANGES_REQUESTED', '2026-08-01T12:00:00Z'),
      ]),
    ).toBe(1);
  });

  it('does not let a later comment clear a blocking review', () => {
    expect(
      countChangesRequested([
        review(1, 'CHANGES_REQUESTED', '2026-08-01T10:00:00Z'),
        review(1, 'COMMENTED', '2026-08-01T12:00:00Z'),
      ]),
    ).toBe(1);
  });

  it('clears a blocking review that was dismissed', () => {
    expect(
      countChangesRequested([
        review(1, 'CHANGES_REQUESTED', '2026-08-01T10:00:00Z'),
        review(1, 'DISMISSED', '2026-08-01T12:00:00Z'),
      ]),
    ).toBe(0);
  });

  it('ignores PENDING (unsubmitted) reviews', () => {
    expect(
      countChangesRequested([{ user: { id: 1 }, state: 'PENDING', submitted_at: null }]),
    ).toBe(0);
  });

  it('is not fooled by out-of-order results', () => {
    expect(
      countChangesRequested([
        review(1, 'APPROVED', '2026-08-01T12:00:00Z'),
        review(1, 'CHANGES_REQUESTED', '2026-08-01T10:00:00Z'),
      ]),
    ).toBe(0);
  });

  it('breaks timestamp ties with API order', () => {
    expect(
      countChangesRequested([
        review(1, 'APPROVED', '2026-08-01T10:00:00Z'),
        review(1, 'CHANGES_REQUESTED', '2026-08-01T10:00:00Z'),
      ]),
    ).toBe(1);
  });

  it('falls back to login when the user id is missing', () => {
    expect(
      countChangesRequested([
        { user: { login: 'Ada' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-08-01T10:00:00Z' },
        { user: { login: 'ada' }, state: 'APPROVED', submitted_at: '2026-08-01T11:00:00Z' },
      ]),
    ).toBe(0);
  });

  it('skips reviews from a deleted (null) user', () => {
    expect(
      countChangesRequested([
        { user: null, state: 'CHANGES_REQUESTED', submitted_at: '2026-08-01T10:00:00Z' },
      ]),
    ).toBe(0);
  });

  it('handles lowercase states and an empty list', () => {
    expect(countChangesRequested([review(1, 'changes_requested', '2026-08-01T10:00:00Z')])).toBe(1);
    expect(countChangesRequested([])).toBe(0);
  });
});

describe('latestReviewByReviewer', () => {
  it('reduces to one current position per reviewer', () => {
    const latest = latestReviewByReviewer([
      review(1, 'APPROVED', '2026-08-01T10:00:00Z'),
      review(1, 'CHANGES_REQUESTED', '2026-08-01T12:00:00Z'),
      review(2, 'APPROVED', '2026-08-01T11:00:00Z'),
      review(2, 'COMMENTED', '2026-08-01T13:00:00Z'),
    ]);
    expect(latest.size).toBe(2);
    expect(latest.get('id:1')).toBe('CHANGES_REQUESTED');
    expect(latest.get('id:2')).toBe('APPROVED');
  });
});

describe('re-requested reviews', () => {
  // GitHub does not touch a review when its author is asked to look again: the
  // review keeps its CHANGES_REQUESTED state and the reviewer is simply added
  // back to the PR's requested_reviewers. Without reading that list, a single
  // changes-requested review blocks a PR permanently.
  const user = (id: number) => ({ id, login: `user${id}` });

  it('stops a re-requested changes-requested review from blocking', () => {
    const reviews = [review(1, 'CHANGES_REQUESTED', '2026-08-01T10:00:00Z')];

    expect(countChangesRequested(reviews)).toBe(1);
    expect(countChangesRequested(reviews, [user(1)])).toBe(0);
  });

  it('leaves other reviewers untouched', () => {
    const reviews = [
      review(1, 'CHANGES_REQUESTED', '2026-08-01T10:00:00Z'),
      review(2, 'CHANGES_REQUESTED', '2026-08-01T11:00:00Z'),
      review(3, 'APPROVED', '2026-08-01T12:00:00Z'),
    ];

    expect(countChangesRequested(reviews, [user(1)])).toBe(1);
  });

  it('matches by login when the reviewer has no id', () => {
    const byLogin = [
      { user: { login: 'Octocat' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-08-01T10:00:00Z' },
    ];

    expect(countChangesRequested(byLogin)).toBe(1);
    // Case-insensitive, as reviewerKey lower-cases both sides.
    expect(countChangesRequested(byLogin, [{ login: 'octocat' }])).toBe(0);
  });

  it('ignores a request for a reviewer who has never reviewed', () => {
    const reviews = [review(1, 'CHANGES_REQUESTED', '2026-08-01T10:00:00Z')];

    // A first-time reviewer sits in requested_reviewers too; they have no
    // position to supersede.
    expect(countChangesRequested(reviews, [user(9)])).toBe(1);
  });

  it('re-blocks once the reviewer submits changes-requested again', () => {
    // The author pushed a fix and re-requested; the reviewer looked and is still
    // unhappy. Submitting a review clears them from requested_reviewers.
    const reviews = [
      review(1, 'CHANGES_REQUESTED', '2026-08-01T10:00:00Z'),
      review(1, 'CHANGES_REQUESTED', '2026-08-02T10:00:00Z'),
    ];

    expect(countChangesRequested(reviews, [])).toBe(1);
  });
});
