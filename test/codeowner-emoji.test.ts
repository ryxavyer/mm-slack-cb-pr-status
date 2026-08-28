import { describe, expect, it } from 'vitest';
import type { EmojiConfig } from '../src/config.js';
import type { TrackedPr } from '../src/db/schema.js';
import { parseCodeownerComment } from '../src/github/codeowner-comment.js';
import { computeCodeownerState, emojiForState } from '../src/state.js';
import type { PrState } from '../src/types.js';

/**
 * End to end over the two halves that decide a reaction: what the codeowner
 * bot's comment says, and what that means for the emoji on a given message.
 *
 * The comment bodies here are the real shapes mmllc-gh posts. Each case states
 * the emoji for both channel contexts, because the same PR reads differently in
 * a team's own channel than in a general one.
 */

const emoji: EmojiConfig = {
  changesRequested: 'request-changes',
  partial: '1of2',
  approved: 'white_check_mark',
  merged: 'merged',
  closed: 'x',
  unknown: 'sleeping',
};

function reactionFor(body: string | null, state: PrState, teamSlug?: string): string | null {
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

  return emojiForState(computeCodeownerState(pr, teamSlug), emoji);
}

const NONE = null;

describe('codeowner comment → Slack reaction', () => {
  describe('“Codeowners reviews satisfied”', () => {
    const body = 'Codeowners reviews satisfied';

    it('shows the green check even when the approval count says partial', () => {
      // The reported bug: an unmapped channel fell back to the raw count and
      // left :1of2: on a PR the bot had already declared done.
      expect(reactionFor(body, 'partial')).toBe('white_check_mark');
      expect(reactionFor(body, 'partial', 'creator-team')).toBe('white_check_mark');
    });

    it('shows the green check when the approval count agrees', () => {
      expect(reactionFor(body, 'approved')).toBe('white_check_mark');
      expect(reactionFor(body, 'approved', 'creator-team')).toBe('white_check_mark');
    });

    it('still defers to merged, closed and blocking states', () => {
      expect(reactionFor(body, 'merged')).toBe('merged');
      expect(reactionFor(body, 'closed')).toBe('x');
      expect(reactionFor(body, 'changes_requested')).toBe('request-changes');
      expect(reactionFor(body, 'unknown')).toBe('sleeping');
    });
  });

  describe('one team outstanding, one approved', () => {
    const body = `Codeowners approval required for this PR:

@multimediallc/creator-team
✅ @multimediallc/messaging-pod
Show detailed file reviewers`;

    it('keeps the approval count in a channel with no team', () => {
      expect(reactionFor(body, 'approved')).toBe('white_check_mark');
      expect(reactionFor(body, 'partial')).toBe('1of2');
      expect(reactionFor(body, 'no_reviews')).toBe(NONE);
    });

    it('holds back the green check in the outstanding team’s channel', () => {
      expect(reactionFor(body, 'approved', 'creator-team')).toBe('1of2');
      expect(reactionFor(body, 'partial', 'creator-team')).toBe('1of2');
      expect(reactionFor(body, 'no_reviews', 'creator-team')).toBe(NONE);
    });

    it('shows the green check in the approved team’s channel', () => {
      expect(reactionFor(body, 'approved', 'messaging-pod')).toBe('white_check_mark');
      expect(reactionFor(body, 'partial', 'messaging-pod')).toBe('white_check_mark');
    });

    it('keeps the approval count for a team the PR does not involve', () => {
      expect(reactionFor(body, 'approved', 'viewer-team')).toBe('white_check_mark');
      expect(reactionFor(body, 'partial', 'viewer-team')).toBe('1of2');
    });
  });

  describe('team approved but the review minimum is not met', () => {
    const body = `Codeowners approval required for this PR:

✅ @multimediallc/viewer-team
Minimum review requirement not met. Need 2 reviews, found 1. Reviews have been re-requested from owning teams, but any additional approval can satisfy minimum.`;

    it('keeps the approval count in a channel with no team', () => {
      expect(reactionFor(body, 'partial')).toBe('1of2');
      expect(reactionFor(body, 'approved')).toBe('white_check_mark');
    });

    it('holds at partial in the team’s channel — the PR still cannot merge', () => {
      expect(reactionFor(body, 'partial', 'viewer-team')).toBe('1of2');
      expect(reactionFor(body, 'approved', 'viewer-team')).toBe('1of2');
    });
  });

  describe('a satisfied OR group alongside outstanding AND rules', () => {
    const body = `Codeowners approval required for this PR:

@multimediallc/design-system-stewards
@multimediallc/viewer-team
✅ @multimediallc/viewer-team or @multimediallc/creator-team
Show detailed file reviewers`;

    it('shows the green check for the team whose OR group is satisfied', () => {
      expect(reactionFor(body, 'partial', 'creator-team')).toBe('white_check_mark');
    });

    it('holds back viewer-team, which also has an unsatisfied AND rule', () => {
      expect(reactionFor(body, 'approved', 'viewer-team')).toBe('1of2');
    });

    it('holds back design-system-stewards, which has not approved', () => {
      expect(reactionFor(body, 'approved', 'design-system-stewards')).toBe('1of2');
    });

    it('keeps the approval count in a channel with no team', () => {
      expect(reactionFor(body, 'approved')).toBe('white_check_mark');
      expect(reactionFor(body, 'partial')).toBe('1of2');
    });
  });

  describe('every requirement approved', () => {
    const body = `Codeowners approval required for this PR:

✅ @multimediallc/creator-team
✅ @multimediallc/platform-team`;

    it('shows the green check in every context', () => {
      for (const teamSlug of [undefined, 'creator-team', 'platform-team', 'messaging-pod']) {
        expect(reactionFor(body, 'partial', teamSlug), `team=${teamSlug}`).toBe('white_check_mark');
        expect(reactionFor(body, 'no_reviews', teamSlug), `team=${teamSlug}`).toBe(
          'white_check_mark',
        );
      }
    });
  });

  describe('a comment the parser does not recognise', () => {
    it('leaves the approval count untouched', () => {
      expect(reactionFor('LGTM!', 'partial')).toBe('1of2');
      expect(reactionFor('LGTM!', 'partial', 'creator-team')).toBe('1of2');
      expect(reactionFor('LGTM!', 'approved', 'creator-team')).toBe('white_check_mark');
    });

    it('leaves the approval count untouched when the bot has not commented', () => {
      expect(reactionFor(NONE, 'partial', 'creator-team')).toBe('1of2');
      expect(reactionFor(NONE, 'approved')).toBe('white_check_mark');
    });
  });
});
