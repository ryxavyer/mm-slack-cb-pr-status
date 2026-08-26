import { describe, expect, it } from 'vitest';
import type { EmojiConfig } from '../src/config.js';
import type { TrackedPr } from '../src/db/schema.js';
import type { CodeownerStatus } from '../src/types.js';
import {
  aggregateState,
  computeCodeownerState,
  computeState,
  emojiForState,
  isTerminal,
  managedEmojis,
} from '../src/state.js';

const emoji: EmojiConfig = {
  changesRequested: 'request-changes',
  partial: '1of2',
  approved: 'white_check_mark',
  merged: 'merged',
  closed: 'x',
  unknown: 'sleeping',
};

describe('computeState', () => {
  const base = {
    merged: false,
    closed: false,
    approvals: 0,
    changesRequested: 0,
    requiredApprovals: 2,
  };

  it('reports no_reviews with zero approvals', () => {
    expect(computeState(base)).toBe('no_reviews');
  });

  it('reports partial below the required count', () => {
    expect(computeState({ ...base, approvals: 1 })).toBe('partial');
  });

  it('reports approved at or above the required count', () => {
    expect(computeState({ ...base, approvals: 2 })).toBe('approved');
    expect(computeState({ ...base, approvals: 5 })).toBe('approved');
  });

  it('honours a required count of one', () => {
    expect(computeState({ ...base, approvals: 1, requiredApprovals: 1 })).toBe('approved');
  });

  it('lets merged win over every review state', () => {
    expect(computeState({ ...base, merged: true, closed: true, approvals: 0 })).toBe('merged');
    expect(computeState({ ...base, merged: true, approvals: 2 })).toBe('merged');
  });

  it('lets closed win over review state but not over merged', () => {
    expect(computeState({ ...base, closed: true, approvals: 2 })).toBe('closed');
  });

  it('reports changes_requested when a reviewer is blocking', () => {
    expect(computeState({ ...base, changesRequested: 1 })).toBe('changes_requested');
    // The case that motivated this state: one approval, one reviewer blocking.
    expect(computeState({ ...base, approvals: 1, changesRequested: 1 })).toBe('changes_requested');
  });

  it('lets a blocking review outrank a full set of approvals', () => {
    // Enough approvals to merge, but someone is still blocking — reporting this
    // as approved would be actively misleading.
    expect(computeState({ ...base, approvals: 2, changesRequested: 1 })).toBe('changes_requested');
    expect(computeState({ ...base, approvals: 9, changesRequested: 1 })).toBe('changes_requested');
  });

  it('still lets merged and closed outrank a blocking review', () => {
    expect(computeState({ ...base, merged: true, changesRequested: 1 })).toBe('merged');
    expect(computeState({ ...base, closed: true, changesRequested: 1 })).toBe('closed');
  });

  it('recovers once the blocking review is resolved', () => {
    expect(computeState({ ...base, approvals: 2, changesRequested: 1 })).toBe('changes_requested');
    expect(computeState({ ...base, approvals: 2, changesRequested: 0 })).toBe('approved');
  });

  it('moves backwards when an approval is revoked', () => {
    expect(computeState({ ...base, approvals: 2 })).toBe('approved');
    expect(computeState({ ...base, approvals: 1 })).toBe('partial');
    expect(computeState({ ...base, approvals: 0 })).toBe('no_reviews');
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
      'changes_requested',
      'partial',
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
    expect(aggregateState(['merged', 'partial'])).toBe('partial');
    expect(aggregateState(['approved', 'partial'])).toBe('partial');
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
    expect(emojiForState('no_reviews', emoji)).toBeNull();
    expect(emojiForState('changes_requested', emoji)).toBe('request-changes');
    expect(emojiForState('partial', emoji)).toBe('1of2');
    expect(emojiForState('approved', emoji)).toBe('white_check_mark');
    expect(emojiForState('merged', emoji)).toBe('merged');
    expect(emojiForState('closed', emoji)).toBe('x');
    expect(emojiForState('unknown', emoji)).toBe('sleeping');
  });

  it('treats an unset emoji as "no reaction for this state"', () => {
    expect(emojiForState('closed', { ...emoji, closed: null })).toBeNull();
  });
});

describe('computeCodeownerState', () => {
  function makePr(state: TrackedPr['state'], codeownerStatus?: CodeownerStatus | null): TrackedPr {
    return {
      id: 1,
      owner: 'acme',
      repo: 'repo',
      number: 1,
      state,
      approvals: 0,
      requiredApprovals: 2,
      lastPolledAt: null,
      createdAt: Date.now(),
      closedAt: null,
      unreachableSince: null,
      codeownerStatus: codeownerStatus !== undefined ? JSON.stringify(codeownerStatus) : null,
    };
  }

  const andStatus = (teams: string[], satisfied: boolean): CodeownerStatus => ({
    requirements: [{ teams, satisfied }],
    minimum: null,
    allSatisfied: satisfied,
  });

  it('passes terminal states through unchanged regardless of codeowner data', () => {
    const status: CodeownerStatus = { requirements: [], minimum: null, allSatisfied: false };
    expect(computeCodeownerState(makePr('merged', status))).toBe('merged');
    expect(computeCodeownerState(makePr('closed', status))).toBe('closed');
    expect(computeCodeownerState(makePr('unknown', status))).toBe('unknown');
    expect(computeCodeownerState(makePr('changes_requested', status))).toBe('changes_requested');
  });

  it('falls back to pr.state when no codeowner data exists', () => {
    expect(computeCodeownerState(makePr('partial'))).toBe('partial');
    expect(computeCodeownerState(makePr('approved'))).toBe('approved');
  });

  it('returns approved when allSatisfied is true', () => {
    const status: CodeownerStatus = { requirements: [], minimum: null, allSatisfied: true };
    expect(computeCodeownerState(makePr('no_reviews', status))).toBe('approved');
  });

  describe('global PR-centric mode (no teamSlug)', () => {
    it('returns no_reviews when any requirement is unsatisfied', () => {
      const status: CodeownerStatus = {
        requirements: [
          { teams: ['creator-team'], satisfied: true },
          { teams: ['platform-team'], satisfied: false },
        ],
        minimum: null,
        allSatisfied: false,
      };
      expect(computeCodeownerState(makePr('approved', status))).toBe('no_reviews');
    });

    it('returns approved when all satisfied and no minimum constraint', () => {
      const status: CodeownerStatus = {
        requirements: [
          { teams: ['creator-team'], satisfied: true },
          { teams: ['platform-team'], satisfied: true },
        ],
        minimum: null,
        allSatisfied: true,
      };
      expect(computeCodeownerState(makePr('no_reviews', status))).toBe('approved');
    });

    it('returns partial when all codeowner requirements met but minimum count not', () => {
      const status: CodeownerStatus = {
        requirements: [{ teams: ['viewer-team'], satisfied: true }],
        minimum: { required: 2, found: 1, met: false },
        allSatisfied: false,
      };
      expect(computeCodeownerState(makePr('partial', status))).toBe('partial');
    });

    it('falls back to pr.state when requirements array is empty', () => {
      const status: CodeownerStatus = { requirements: [], minimum: null, allSatisfied: false };
      expect(computeCodeownerState(makePr('partial', status))).toBe('partial');
    });
  });

  describe('channel-specific mode (with teamSlug)', () => {
    it('returns no_reviews when the team requirement is unsatisfied', () => {
      expect(
        computeCodeownerState(makePr('partial', andStatus(['creator-team'], false)), 'creator-team'),
      ).toBe('no_reviews');
    });

    it('returns approved when the team requirement is satisfied and minimum is met', () => {
      expect(
        computeCodeownerState(makePr('no_reviews', andStatus(['creator-team'], true)), 'creator-team'),
      ).toBe('approved');
    });

    it('returns partial when team is done but minimum count is not met', () => {
      const status: CodeownerStatus = {
        requirements: [{ teams: ['viewer-team'], satisfied: true }],
        minimum: { required: 2, found: 1, met: false },
        allSatisfied: false,
      };
      expect(computeCodeownerState(makePr('partial', status), 'viewer-team')).toBe('partial');
    });

    it('returns approved for creator-team when only its OR group requirement is satisfied', () => {
      // Example 3: creator-team only appears in the OR group, which is satisfied
      const status: CodeownerStatus = {
        requirements: [
          { teams: ['design-system-stewards'], satisfied: false },
          { teams: ['viewer-team'], satisfied: false },
          { teams: ['viewer-team', 'creator-team'], satisfied: true },
        ],
        minimum: null,
        allSatisfied: false,
      };
      expect(computeCodeownerState(makePr('no_reviews', status), 'creator-team')).toBe('approved');
    });

    it('returns no_reviews for viewer-team when it has an unsatisfied AND requirement even if OR group is satisfied', () => {
      const status: CodeownerStatus = {
        requirements: [
          { teams: ['viewer-team'], satisfied: false },
          { teams: ['viewer-team', 'creator-team'], satisfied: true },
        ],
        minimum: null,
        allSatisfied: false,
      };
      expect(computeCodeownerState(makePr('no_reviews', status), 'viewer-team')).toBe('no_reviews');
    });

    it('falls back to global logic when team is not in any requirement', () => {
      // messaging-pod is not a codeowner for this PR — fall back to global state
      const status: CodeownerStatus = {
        requirements: [{ teams: ['creator-team'], satisfied: false }],
        minimum: null,
        allSatisfied: false,
      };
      // Global logic: creator-team unsatisfied → no_reviews
      expect(computeCodeownerState(makePr('partial', status), 'messaging-pod')).toBe('no_reviews');
    });
  });
});

describe('managedEmojis', () => {
  it('lists only the emoji the bot may touch', () => {
    expect(managedEmojis(emoji)).toEqual([
      'request-changes',
      '1of2',
      'white_check_mark',
      'merged',
      'x',
      'sleeping',
    ]);
    expect(managedEmojis({ ...emoji, closed: null })).toEqual([
      'request-changes',
      '1of2',
      'white_check_mark',
      'merged',
      'sleeping',
    ]);
  });
});
