import { describe, expect, it } from 'vitest';
import type { EmojiConfig } from '../src/config.js';
import type { TrackedPr } from '../src/db/schema.js';
import type { CodeownerStatus } from '../src/types.js';
import {
  aggregateState,
  computeState,
  emojiForState,
  isTerminal,
  managedEmojis,
  messageState,
} from '../src/state.js';

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

const SATISFIED: CodeownerStatus = { requirements: [], minimum: null, allSatisfied: true };
const PENDING: CodeownerStatus = {
  requirements: [{ teams: ['creator-team'], satisfied: true }],
  minimum: { required: 2, found: 1, met: false },
  allSatisfied: false,
};

describe('computeState', () => {
  const base = { merged: false, closed: false, changesRequested: 0, codeowners: null, reviewed: false };

  it('reports no_reviews until anyone has reviewed', () => {
    expect(computeState(base)).toBe('no_reviews');
    expect(computeState({ ...base, codeowners: PENDING })).toBe('no_reviews');
  });

  it('reports in_review once someone has, until the codeowner bot is satisfied', () => {
    expect(computeState({ ...base, reviewed: true })).toBe('in_review');
    expect(computeState({ ...base, reviewed: true, codeowners: PENDING })).toBe('in_review');
    expect(computeState({ ...base, reviewed: true, codeowners: SATISFIED })).toBe('approved');
  });

  it('reports approved only on the codeowner bot’s say-so', () => {
    expect(computeState({ ...base, codeowners: SATISFIED })).toBe('approved');
  });

  it('lets merged win over every review state', () => {
    expect(computeState({ ...base, merged: true, closed: true })).toBe('merged');
    expect(computeState({ ...base, merged: true, codeowners: SATISFIED })).toBe('merged');
  });

  it('lets closed win over review state but not over merged', () => {
    expect(computeState({ ...base, closed: true, codeowners: SATISFIED })).toBe('closed');
  });

  it('lets a blocking review outrank the codeowner bot’s approval', () => {
    expect(computeState({ ...base, changesRequested: 1 })).toBe('changes_requested');
    expect(computeState({ ...base, changesRequested: 1, codeowners: SATISFIED })).toBe(
      'changes_requested',
    );
  });

  it('still lets merged and closed outrank a blocking review', () => {
    expect(computeState({ ...base, merged: true, changesRequested: 1 })).toBe('merged');
    expect(computeState({ ...base, closed: true, changesRequested: 1 })).toBe('closed');
  });

  it('recovers once the blocking review is resolved', () => {
    expect(computeState({ ...base, changesRequested: 0, codeowners: SATISFIED })).toBe('approved');
  });
});

describe('isTerminal', () => {
  it('is true only for merged and closed', () => {
    expect(isTerminal('merged')).toBe(true);
    expect(isTerminal('closed')).toBe(true);
    expect(isTerminal('approved')).toBe(false);
    expect(isTerminal('partial')).toBe(false);
    expect(isTerminal('no_reviews')).toBe(false);
    expect(isTerminal('changes_requested')).toBe(false);
  });

  it('keeps polling an unknown PR so restored access self-heals it', () => {
    expect(isTerminal('unknown')).toBe(false);
  });
});

describe('aggregateState', () => {
  it('is that PR’s own state when a message links just one', () => {
    const all = [
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
    for (const state of all) {
      expect(aggregateState([state])).toBe(state);
    }
  });

  it('reports the least settled state, so the message still asks for eyes', () => {
    expect(aggregateState(['approved', 'no_reviews'])).toBe('no_reviews');
    expect(aggregateState(['in_review', 'no_reviews'])).toBe('no_reviews');
    expect(aggregateState(['in_review', 'partial'])).toBe('in_review');
    expect(aggregateState(['merged', 'partial'])).toBe('partial');
    expect(aggregateState(['approved', 'partial'])).toBe('partial');
    expect(aggregateState(['team_done', 'partial'])).toBe('partial');
    expect(aggregateState(['approved', 'team_done'])).toBe('team_done');
    expect(aggregateState(['merged', 'closed'])).toBe('closed');
  });

  it('only reports done when every PR is done', () => {
    expect(aggregateState(['approved', 'approved'])).toBe('approved');
    expect(aggregateState(['merged', 'merged'])).toBe('merged');
  });

  it('lets unknown outrank everything, since we cannot vouch for the rest', () => {
    expect(aggregateState(['merged', 'unknown'])).toBe('unknown');
    expect(aggregateState(['approved', 'unknown'])).toBe('unknown');
    expect(aggregateState(['no_reviews', 'unknown'])).toBe('unknown');
  });

  it('surfaces a blocked PR rather than hiding it behind the no-emoji state', () => {
    // `no_reviews` shows nothing, so if it won here a blocked PR would be
    // invisible on a message that also links an unreviewed one.
    expect(aggregateState(['no_reviews', 'changes_requested'])).toBe('changes_requested');
    expect(aggregateState(['approved', 'changes_requested'])).toBe('changes_requested');
    expect(aggregateState(['merged', 'changes_requested'])).toBe('changes_requested');
  });

  it('still lets unknown outrank a blocked PR', () => {
    expect(aggregateState(['changes_requested', 'unknown'])).toBe('unknown');
  });

  it('does not depend on the order the PRs come back in', () => {
    expect(aggregateState(['no_reviews', 'approved'])).toBe(
      aggregateState(['approved', 'no_reviews']),
    );
  });

  it('has no state for a message with no PRs left', () => {
    expect(aggregateState([])).toBeNull();
  });
});

describe('emojiForState', () => {
  it('maps each state to its configured emoji', () => {
    expect(emojiForState('no_reviews', emoji)).toBe('please');
    expect(emojiForState('in_review', emoji)).toBeNull();
    expect(emojiForState('changes_requested', emoji)).toBe('request-changes');
    expect(emojiForState('partial', emoji)).toBe('1of2');
    expect(emojiForState('team_done', emoji)).toBe('blue_check_mark');
    expect(emojiForState('approved', emoji)).toBe('white_check_mark');
    expect(emojiForState('merged', emoji)).toBe('merged');
    expect(emojiForState('closed', emoji)).toBe('x');
    expect(emojiForState('unknown', emoji)).toBe('sleeping');
  });

  it('treats an unset emoji as "no reaction for this state"', () => {
    expect(emojiForState('closed', { ...emoji, closed: null })).toBeNull();
  });
});

describe('messageState', () => {
  function makePr(state: TrackedPr['state'], codeownerStatus?: CodeownerStatus): TrackedPr {
    return {
      id: 1,
      owner: 'acme',
      repo: 'repo',
      number: 1,
      state,
      lastPolledAt: null,
      createdAt: Date.now(),
      closedAt: null,
      unreachableSince: null,
      codeownerStatus: codeownerStatus ? JSON.stringify(codeownerStatus) : null,
    };
  }

  const status = (
    requirements: CodeownerStatus['requirements'],
    minimum: CodeownerStatus['minimum'],
  ): CodeownerStatus => ({ requirements, minimum, allSatisfied: false });

  it('is the PR’s own state without a team', () => {
    const pending = status([{ teams: ['creator-team'], satisfied: true }], null);
    for (const state of ['no_reviews', 'in_review', 'approved', 'merged', 'changes_requested'] as const) {
      expect(messageState(makePr(state, pending), null)).toBe(state);
    }
  });

  it('passes every state but in_review through, even with a team — unreviewed included', () => {
    const done = status([{ teams: ['creator-team'], satisfied: true }], null);
    for (const state of ['no_reviews', 'approved', 'merged', 'closed', 'unknown', 'changes_requested'] as const) {
      expect(messageState(makePr(state, done), 'creator-team')).toBe(state);
    }
  });

  it('shows no team progress without a codeowner comment', () => {
    expect(messageState(makePr('in_review'), 'creator-team')).toBe('in_review');
  });

  it('reports team_done once the team is satisfied and the minimum is met', () => {
    const pr = makePr(
      'in_review',
      status(
        [
          { teams: ['creator-team'], satisfied: true },
          { teams: ['platform-team'], satisfied: false },
        ],
        { required: 2, found: 2, met: true },
      ),
    );
    expect(messageState(pr, 'creator-team')).toBe('team_done');
    expect(messageState(pr, 'platform-team')).toBe('in_review');
  });

  it('reports team_done for a satisfied team when the bot sets no minimum', () => {
    const pr = makePr(
      'in_review',
      status(
        [
          { teams: ['creator-team'], satisfied: true },
          { teams: ['platform-team'], satisfied: false },
        ],
        null,
      ),
    );
    expect(messageState(pr, 'creator-team')).toBe('team_done');
  });

  it('reports partial only when the bot literally reports one of two reviews', () => {
    const reqs = [{ teams: ['creator-team'], satisfied: true }];
    expect(messageState(makePr('in_review', status(reqs, { required: 2, found: 1, met: false })), 'creator-team')).toBe('partial');
    expect(messageState(makePr('in_review', status(reqs, { required: 3, found: 1, met: false })), 'creator-team')).toBe('in_review');
    expect(messageState(makePr('in_review', status(reqs, { required: 3, found: 2, met: false })), 'creator-team')).toBe('in_review');
  });

  it('never shows progress while any requirement naming the team is unsatisfied', () => {
    const pr = makePr(
      'in_review',
      status(
        [
          { teams: ['creator-team'], satisfied: false },
          { teams: ['creator-team', 'platform-team'], satisfied: true },
        ],
        { required: 2, found: 2, met: true },
      ),
    );
    expect(messageState(pr, 'creator-team')).toBe('in_review');
  });

  it('credits a team for an OR requirement another team satisfied', () => {
    // The bot needs one of the two; once it's met, creator-team owes nothing.
    const pr = makePr(
      'in_review',
      status(
        [
          { teams: ['design-system-stewards'], satisfied: false },
          { teams: ['viewer-team', 'creator-team'], satisfied: true },
        ],
        null,
      ),
    );
    expect(messageState(pr, 'creator-team')).toBe('team_done');
  });

  it('credits a team the bot does not name only through the minimum count', () => {
    const reqs = [{ teams: ['platform-team'], satisfied: false }];
    expect(messageState(makePr('in_review', status(reqs, null)), 'creator-team')).toBe('in_review');
    expect(messageState(makePr('in_review', status(reqs, { required: 2, found: 0, met: false })), 'creator-team')).toBe('in_review');
    expect(messageState(makePr('in_review', status(reqs, { required: 2, found: 1, met: false })), 'creator-team')).toBe('partial');
    expect(messageState(makePr('in_review', status(reqs, { required: 2, found: 2, met: true })), 'creator-team')).toBe('team_done');
  });

  it('matches team slugs case-insensitively', () => {
    const pr = makePr('in_review', status([{ teams: ['Creator-Team'], satisfied: true }], null));
    expect(messageState(pr, 'creator-team')).toBe('team_done');
  });
});

describe('managedEmojis', () => {
  it('lists only the emoji the bot may touch', () => {
    expect(managedEmojis(emoji)).toEqual([
      'please',
      'request-changes',
      '1of2',
      'blue_check_mark',
      'white_check_mark',
      'merged',
      'x',
      'sleeping',
    ]);
    expect(managedEmojis({ ...emoji, closed: null })).toEqual([
      'please',
      'request-changes',
      '1of2',
      'blue_check_mark',
      'white_check_mark',
      'merged',
      'sleeping',
    ]);
  });
});
