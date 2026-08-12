import { describe, expect, it } from 'vitest';
import {
  countApprovals,
  latestReviewByReviewer,
  summariseReviews,
  type ReviewLike,
} from '../src/github/reviews.js';

const review = (id: number, state: string, submitted_at: string): ReviewLike => ({
  user: { id, login: `user${id}` },
  state,
  submitted_at,
});

describe('countApprovals', () => {
  it('counts one approval per approving reviewer', () => {
    expect(
      countApprovals([
        review(1, 'APPROVED', '2026-08-01T10:00:00Z'),
        review(2, 'APPROVED', '2026-08-01T11:00:00Z'),
      ]),
    ).toBe(2);
  });

  it('counts only the latest review per reviewer', () => {
    // Approve, then change your mind: no longer an approval.
    expect(
      countApprovals([
        review(1, 'APPROVED', '2026-08-01T10:00:00Z'),
        review(1, 'CHANGES_REQUESTED', '2026-08-01T12:00:00Z'),
      ]),
    ).toBe(0);

    // ...and the other direction.
    expect(
      countApprovals([
        review(1, 'CHANGES_REQUESTED', '2026-08-01T10:00:00Z'),
        review(1, 'APPROVED', '2026-08-01T12:00:00Z'),
      ]),
    ).toBe(1);
  });

  it('does not let a later COMMENTED review cancel an approval', () => {
    expect(
      countApprovals([
        review(1, 'APPROVED', '2026-08-01T10:00:00Z'),
        review(1, 'COMMENTED', '2026-08-01T12:00:00Z'),
      ]),
    ).toBe(1);
  });

  it('ignores PENDING (unsubmitted) reviews', () => {
    expect(countApprovals([{ user: { id: 1 }, state: 'PENDING', submitted_at: null }])).toBe(0);
  });

  it('does not count a dismissed approval', () => {
    expect(
      countApprovals([
        review(1, 'APPROVED', '2026-08-01T10:00:00Z'),
        review(1, 'DISMISSED', '2026-08-01T12:00:00Z'),
      ]),
    ).toBe(0);
  });

  it('is not fooled by out-of-order results', () => {
    expect(
      countApprovals([
        review(1, 'CHANGES_REQUESTED', '2026-08-01T12:00:00Z'),
        review(1, 'APPROVED', '2026-08-01T10:00:00Z'),
      ]),
    ).toBe(0);
  });

  it('breaks timestamp ties with API order', () => {
    expect(
      countApprovals([
        review(1, 'APPROVED', '2026-08-01T10:00:00Z'),
        review(1, 'CHANGES_REQUESTED', '2026-08-01T10:00:00Z'),
      ]),
    ).toBe(0);
  });

  it('falls back to login when the user id is missing', () => {
    expect(
      countApprovals([
        { user: { login: 'Ada' }, state: 'APPROVED', submitted_at: '2026-08-01T10:00:00Z' },
        { user: { login: 'ada' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-08-01T11:00:00Z' },
      ]),
    ).toBe(0);
  });

  it('skips reviews from a deleted (null) user', () => {
    expect(
      countApprovals([{ user: null, state: 'APPROVED', submitted_at: '2026-08-01T10:00:00Z' }]),
    ).toBe(0);
  });

  it('handles lowercase states and an empty list', () => {
    expect(countApprovals([review(1, 'approved', '2026-08-01T10:00:00Z')])).toBe(1);
    expect(countApprovals([])).toBe(0);
  });
});

describe('summariseReviews', () => {
  it('counts approvals and blocking reviews side by side', () => {
    // One reviewer approved, another wants changes — the case that drives the
    // changes_requested state.
    expect(
      summariseReviews([
        review(1, 'APPROVED', '2026-08-01T10:00:00Z'),
        review(2, 'CHANGES_REQUESTED', '2026-08-01T11:00:00Z'),
      ]),
    ).toEqual({ approvals: 1, changesRequested: 1 });
  });

  it('counts only each reviewer’s latest position', () => {
    expect(
      summariseReviews([
        review(1, 'CHANGES_REQUESTED', '2026-08-01T10:00:00Z'),
        review(1, 'APPROVED', '2026-08-01T12:00:00Z'),
      ]),
    ).toEqual({ approvals: 1, changesRequested: 0 });
  });

  it('does not let a later comment clear a blocking review', () => {
    expect(
      summariseReviews([
        review(1, 'CHANGES_REQUESTED', '2026-08-01T10:00:00Z'),
        review(1, 'COMMENTED', '2026-08-01T12:00:00Z'),
      ]),
    ).toEqual({ approvals: 0, changesRequested: 1 });
  });

  it('clears a blocking review that was dismissed', () => {
    expect(
      summariseReviews([
        review(1, 'CHANGES_REQUESTED', '2026-08-01T10:00:00Z'),
        review(1, 'DISMISSED', '2026-08-01T12:00:00Z'),
      ]),
    ).toEqual({ approvals: 0, changesRequested: 0 });
  });

  it('is all zeros for no reviews', () => {
    expect(summariseReviews([])).toEqual({ approvals: 0, changesRequested: 0 });
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
