import { describe, expect, it } from 'vitest';
import type { EmojiConfig } from '../src/config.js';
import type { TrackedPr } from '../src/db/schema.js';
import { parseCodeownerComment } from '../src/github/codeowner-comment.js';
import { computeCodeownerState, emojiForState } from '../src/state.js';
import type { PrState } from '../src/types.js';

/**
 * End to end over the two halves that decide a reaction: what the codeowner
 * bot's comment says, and what that means on top of the approval count.
 *
 * The comment bodies here are the real shapes mmllc-gh posts. The channel a
 * message is in makes no difference — the count decides, and an outstanding
 * review group is the one thing that can hold a PR back.
 */

const emoji: EmojiConfig = {
  changesRequested: 'request-changes',
  noReviews: 'please',
  partial: '1of2',
  approved: 'white_check_mark',
  merged: 'merged',
  closed: 'x',
  unknown: 'sleeping',
};

function reactionFor(body: string | null, state: PrState): string | null {
  const parsed = body === null ? null : parseCodeownerComment(body);
  const pr = {
    id: 1,
    owner: 'multimediallc',
    repo: 'monolith',
    number: 1,
    state,
    approvals: 0,
    requiredApprovals: 2,
    lastPolledAt: null,
    createdAt: 0,
    closedAt: null,
    unreachableSince: null,
    codeownerStatus: parsed === null ? null : JSON.stringify(parsed),
  } satisfies TrackedPr;

  return emojiForState(computeCodeownerState(pr), emoji);
}

const NONE = null;

describe('codeowner comment -> Slack reaction', () => {
  describe('a group still owes a review', () => {
    const body = [
      'Codeowners approval required for this PR:',
      '- @multimediallc/media-library-experts',
      '<details><summary>Show detailed file reviewers</summary></details>',
    ].join('\n');

    it('holds a PR with enough approvals at partial', () => {
      expect(reactionFor(body, 'approved')).toBe('1of2');
    });

    it('leaves a partly reviewed PR at partial', () => {
      expect(reactionFor(body, 'partial')).toBe('1of2');
    });

    it('marks an unreviewed PR as needing a reviewer', () => {
      expect(reactionFor(body, 'no_reviews')).toBe('please');
    });

    it('still defers to merged, closed and blocking states', () => {
      expect(reactionFor(body, 'merged')).toBe('merged');
      expect(reactionFor(body, 'closed')).toBe('x');
      expect(reactionFor(body, 'changes_requested')).toBe('request-changes');
      expect(reactionFor(body, 'unknown')).toBe('sleeping');
    });
  });

  describe('one group outstanding among several', () => {
    const body = [
      'Codeowners approval required for this PR:',
      '- @multimediallc/creator-team',
      '- ✅ @multimediallc/messaging-pod',
      '<details><summary>Show detailed file reviewers</summary></details>',
    ].join('\n');

    it('holds the PR back until every group has signed off', () => {
      expect(reactionFor(body, 'approved')).toBe('1of2');
      expect(reactionFor(body, 'partial')).toBe('1of2');
      expect(reactionFor(body, 'no_reviews')).toBe('please');
    });
  });

  describe('every group has signed off', () => {
    const body = [
      'Codeowners approval required for this PR:',
      '- ✅ @multimediallc/media-library-experts',
      '',
      '<details><summary>Show detailed file reviewers</summary>',
      '',
      '</details>',
    ].join('\n');

    it('lets the approval count through untouched', () => {
      expect(reactionFor(body, 'approved')).toBe('white_check_mark');
      expect(reactionFor(body, 'partial')).toBe('1of2');
      expect(reactionFor(body, 'no_reviews')).toBe('please');
    });

    it('does not promote a PR that has not met REQUIRED_APPROVALS', () => {
      // The bot being happy is not the repo's approval count being met.
      expect(reactionFor(body, 'partial')).not.toBe('white_check_mark');
    });
  });

  describe('the terminal all-clear comment', () => {
    const body = 'Codeowners reviews satisfied';

    it('lets the approval count through untouched', () => {
      expect(reactionFor(body, 'approved')).toBe('white_check_mark');
      expect(reactionFor(body, 'partial')).toBe('1of2');
      expect(reactionFor(body, 'no_reviews')).toBe('please');
    });
  });

  describe('a satisfied OR group alongside outstanding AND rules', () => {
    const body = [
      'Codeowners approval required for this PR:',
      '- @multimediallc/design-system-stewards',
      '- @multimediallc/viewer-team',
      '- ✅ @multimediallc/viewer-team or @multimediallc/creator-team',
      '<details><summary>Show detailed file reviewers</summary></details>',
    ].join('\n');

    it('still counts the outstanding AND rules', () => {
      expect(reactionFor(body, 'approved')).toBe('1of2');
      expect(reactionFor(body, 'no_reviews')).toBe('please');
    });
  });

  describe('the bot review minimum', () => {
    // REQUIRED_APPROVALS is the count that decides; the bot's own minimum is
    // deliberately not consulted.
    const body = [
      'Codeowners approval required for this PR:',
      '- ✅ @multimediallc/viewer-team',
      '- Minimum review requirement not met. Need 2 reviews, found 1.',
    ].join('\n');

    it('does not hold back a PR whose groups have all signed off', () => {
      expect(reactionFor(body, 'approved')).toBe('white_check_mark');
      expect(reactionFor(body, 'partial')).toBe('1of2');
    });
  });

  describe('a comment the parser does not recognise', () => {
    it('leaves the approval count untouched', () => {
      expect(reactionFor('LGTM!', 'partial')).toBe('1of2');
      expect(reactionFor('LGTM!', 'approved')).toBe('white_check_mark');
      expect(reactionFor('LGTM!', 'no_reviews')).toBe('please');
    });

    it('leaves the approval count untouched when the bot has not commented', () => {
      expect(reactionFor(NONE, 'partial')).toBe('1of2');
      expect(reactionFor(NONE, 'approved')).toBe('white_check_mark');
      expect(reactionFor(NONE, 'no_reviews')).toBe('please');
    });
  });
});
