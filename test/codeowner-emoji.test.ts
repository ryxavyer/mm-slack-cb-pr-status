import { describe, expect, it } from 'vitest';
import type { EmojiConfig } from '../src/config.js';
import type { TrackedPr } from '../src/db/schema.js';
import { parseCodeownerComment } from '../src/github/codeowner-comment.js';
import { computeState, emojiForState, messageState } from '../src/state.js';

/**
 * End to end over the two halves that decide a reaction: what the codeowner
 * bot's comment says, and what that means for a message in a given channel.
 *
 * The comment bodies here are the real shapes mmllc-gh posts. `team` is null
 * for a public channel (or a private one with no team set), and the team slug
 * for a private channel set to that team.
 */

const emoji: EmojiConfig = {
  changesRequested: 'request-changes',
  noReviews: 'please',
  partial: '1of2',
  teamDone: 'blue_check_mark',
  approved: 'white_check_mark',
  merged: 'merged',
  closed: 'x',
  unknown: 'sleeping',
};

interface GitHubFacts {
  merged?: boolean;
  closed?: boolean;
  changesRequested?: number;
  /** Whether anyone has reviewed yet. Defaults to true: most cases are mid-review. */
  reviewed?: boolean;
}

function reactionFor(body: string | null, team: string | null = null, facts: GitHubFacts = {}): string | null {
  const codeowners = body === null ? null : parseCodeownerComment(body);
  const pr = {
    id: 1,
    owner: 'multimediallc',
    repo: 'monolith',
    number: 1,
    state: computeState({
      merged: facts.merged ?? false,
      closed: facts.closed ?? false,
      changesRequested: facts.changesRequested ?? 0,
      codeowners,
      reviewed: facts.reviewed ?? true,
    }),
    lastPolledAt: null,
    createdAt: 0,
    closedAt: null,
    unreachableSince: null,
    codeownerStatus: codeowners === null ? null : JSON.stringify(codeowners),
  } satisfies TrackedPr;

  return emojiForState(messageState(pr, team), emoji);
}

const NONE = null;

describe('codeowner comment -> Slack reaction', () => {
  describe('a group still owes a review', () => {
    const body = [
      'Codeowners approval required for this PR:',
      '- @multimediallc/media-library-experts',
      '<details><summary>Show detailed file reviewers</summary></details>',
    ].join('\n');

    it('asks for a reviewer while nobody has reviewed, in any channel', () => {
      expect(reactionFor(body, null, { reviewed: false })).toBe('please');
      expect(reactionFor(body, 'media-library-experts', { reviewed: false })).toBe('please');
    });

    it('goes quiet once someone has reviewed, in any channel', () => {
      expect(reactionFor(body)).toBeNull();
      expect(reactionFor(body, 'media-library-experts')).toBeNull();
    });

    it('still defers to merged, closed and blocking states', () => {
      expect(reactionFor(body, null, { merged: true, closed: true })).toBe('merged');
      expect(reactionFor(body, null, { closed: true })).toBe('x');
      expect(reactionFor(body, null, { changesRequested: 1 })).toBe('request-changes');
    });
  });

  describe('one group outstanding among several', () => {
    const body = [
      'Codeowners approval required for this PR:',
      '- @multimediallc/creator-team',
      '- ✅ @multimediallc/messaging-pod',
      '<details><summary>Show detailed file reviewers</summary></details>',
    ].join('\n');

    it('holds a public channel back until every group has signed off', () => {
      expect(reactionFor(body)).toBeNull();
    });

    it('tells the team that signed off it is done', () => {
      expect(reactionFor(body, 'messaging-pod')).toBe('blue_check_mark');
      expect(reactionFor(body, 'creator-team')).toBeNull();
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

    it('is approved everywhere: the bot being satisfied is the whole answer', () => {
      expect(reactionFor(body)).toBe('white_check_mark');
      expect(reactionFor(body, 'media-library-experts')).toBe('white_check_mark');
    });
  });

  describe('the terminal all-clear comment', () => {
    it('is approved everywhere', () => {
      expect(reactionFor('Codeowners reviews satisfied')).toBe('white_check_mark');
      expect(reactionFor('Codeowners reviews satisfied', 'creator-team')).toBe('white_check_mark');
    });

    it('still shows a blocking review over it', () => {
      expect(reactionFor('Codeowners reviews satisfied', null, { changesRequested: 1 })).toBe(
        'request-changes',
      );
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

    it('still counts the outstanding AND rules in public', () => {
      expect(reactionFor(body)).toBeNull();
    });

    it('credits the OR group’s other team, but not a team with its own rule pending', () => {
      expect(reactionFor(body, 'creator-team')).toBe('blue_check_mark');
      expect(reactionFor(body, 'viewer-team')).toBeNull();
    });
  });

  describe('the bot review minimum', () => {
    const body = [
      'Codeowners approval required for this PR:',
      '- ✅ @multimediallc/viewer-team',
      '- Minimum review requirement not met. Need 2 reviews, found 1.',
    ].join('\n');

    it('holds a public channel back until the minimum is met', () => {
      expect(reactionFor(body)).toBeNull();
    });

    it('shows one of two in the team’s own channel', () => {
      expect(reactionFor(body, 'viewer-team')).toBe('1of2');
    });
  });

  describe('a comment the parser does not recognise', () => {
    it('never approves', () => {
      expect(reactionFor('LGTM!')).toBeNull();
      expect(reactionFor('LGTM!', 'creator-team')).toBeNull();
    });

    it('never approves when the bot has not commented', () => {
      expect(reactionFor(NONE)).toBeNull();
      expect(reactionFor(NONE, 'creator-team')).toBeNull();
      expect(reactionFor(NONE, null, { reviewed: false })).toBe('please');
    });
  });
});
