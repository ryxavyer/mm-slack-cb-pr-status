import { describe, expect, it } from 'vitest';
import type { EmojiConfig } from '../src/config.js';
import type { TrackedPr } from '../src/db/schema.js';
import type { CodeownerStatus, PrState } from '../src/types.js';
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
  noReviews: 'please',
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
    expect(emojiForState('no_reviews', emoji)).toBe('please');
    expect(emojiForState('changes_requested', emoji)).toBe('request-changes');
    expect(emojiForState('partial', emoji)).toBe('1of2');
    expect(emojiForState('approved', emoji)).toBe('white_check_mark');
    expect(emojiForState('merged', emoji)).toBe('merged');
    expect(emojiForState('closed', emoji)).toBe('x');
    expect(emojiForState('unknown', emoji)).toBe('sleeping');
  });

  it('treats an unset emoji as "no reaction for this state"', () => {
    expect(emojiForState('closed', { ...emoji, closed: null })).toBeNull();
    // Emptying EMOJI_NO_REVIEWS is how unreviewed PRs go back to bare.
    expect(emojiForState('no_reviews', { ...emoji, noReviews: null })).toBeNull();
  });
});

describe('computeCodeownerState', () => {
  function makePr(state: TrackedPr['state'], codeownerStatus: string | null = null): TrackedPr {
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
      codeownerStatus,
    };
  }

  const serialise = (status: CodeownerStatus | null): string | null =>
    status === null ? null : JSON.stringify(status);

  const req = (teams: string[], satisfied: boolean) => ({ teams, satisfied });

  // ---------------------------------------------------------------------------
  // Every shape the codeowner bot's comment can parse into, split by the only
  // question the logic now asks of it: is any review group still outstanding?
  // ---------------------------------------------------------------------------
  const OUTSTANDING: [string, CodeownerStatus][] = [
    [
      'one group, not signed off',
      { requirements: [req(['creator-team'], false)], minimum: null, allSatisfied: false },
    ],
    [
      'one group done, one not',
      {
        requirements: [req(['creator-team'], true), req(['platform-team'], false)],
        minimum: null,
        allSatisfied: false,
      },
    ],
    [
      'an OR group satisfied but AND rules outstanding',
      {
        requirements: [
          req(['design-system-stewards'], false),
          req(['viewer-team'], false),
          req(['viewer-team', 'creator-team'], true),
        ],
        minimum: null,
        allSatisfied: false,
      },
    ],
  ];

  const SETTLED: [string, CodeownerStatus][] = [
    [
      'the terminal "reviews satisfied" comment',
      { requirements: [], minimum: null, allSatisfied: true },
    ],
    [
      'every group signed off',
      { requirements: [req(['creator-team'], true)], minimum: null, allSatisfied: true },
    ],
    [
      'every group signed off, minimum met',
      {
        requirements: [req(['creator-team'], true)],
        minimum: { required: 2, found: 2, met: true },
        allSatisfied: true,
      },
    ],
    [
      // The bot's own minimum is deliberately not consulted: REQUIRED_APPROVALS
      // is the count that decides, and every group has signed off.
      'every group signed off, but the bot minimum is outstanding',
      {
        requirements: [req(['creator-team'], true)],
        minimum: { required: 2, found: 1, met: false },
        allSatisfied: false,
      },
    ],
    [
      'a header the parser found no groups in',
      { requirements: [], minimum: null, allSatisfied: false },
    ],
  ];

  const REVIEW_STATES = ['no_reviews', 'partial', 'approved'] as const;
  const PASS_THROUGH = ['merged', 'closed', 'unknown', 'changes_requested'] as const;
  const ALL_STATUSES = [...OUTSTANDING, ...SETTLED];

  describe('with a review group still outstanding', () => {
    for (const [name, status] of OUTSTANDING) {
      describe(name, () => {
        it('holds an otherwise-approved PR at partial', () => {
          expect(computeCodeownerState(makePr('approved', serialise(status)))).toBe('partial');
        });

        it('leaves a partial PR at partial', () => {
          expect(computeCodeownerState(makePr('partial', serialise(status)))).toBe('partial');
        });

        it('leaves an unreviewed PR at no_reviews', () => {
          expect(computeCodeownerState(makePr('no_reviews', serialise(status)))).toBe('no_reviews');
        });
      });
    }
  });

  describe('with no review group outstanding', () => {
    for (const [name, status] of SETTLED) {
      it(`leaves the approval count alone for ${name}`, () => {
        for (const state of REVIEW_STATES) {
          expect(computeCodeownerState(makePr(state, serialise(status))), state).toBe(state);
        }
      });
    }

    it('does not promote a PR that has not met REQUIRED_APPROVALS', () => {
      // The bot saying every group is happy is not the same as the repo's own
      // approval count being met, and the count is what decides.
      const settled: CodeownerStatus = {
        requirements: [req(['creator-team'], true)],
        minimum: null,
        allSatisfied: true,
      };
      expect(computeCodeownerState(makePr('partial', serialise(settled)))).toBe('partial');
      expect(computeCodeownerState(makePr('no_reviews', serialise(settled)))).toBe('no_reviews');
    });
  });

  describe('with no usable codeowner data', () => {
    it('falls back to pr.state when the bot has not commented', () => {
      for (const state of REVIEW_STATES) {
        expect(computeCodeownerState(makePr(state, null)), state).toBe(state);
      }
    });

    it('falls back to pr.state when the stored JSON will not parse', () => {
      for (const state of REVIEW_STATES) {
        expect(computeCodeownerState(makePr(state, '{not json')), state).toBe(state);
      }
    });
  });

  describe('terminal and blocking states', () => {
    for (const state of PASS_THROUGH) {
      it(`keeps ${state} for every codeowner status`, () => {
        for (const [name, status] of ALL_STATUSES) {
          expect(computeCodeownerState(makePr(state, serialise(status))), name).toBe(state);
          expect(computeCodeownerState(makePr(state, null)), name).toBe(state);
        }
      });
    }
  });

  describe("a private channel's team view", () => {
    // Only a private channel gets this: one team is in the room, so the reaction
    // answers "do we still owe a review?" rather than "is this PR ready?".
    const TEAM = 'monetization-team';

    const withGroups = (groups: Record<string, boolean>): CodeownerStatus => {
      const requirements = Object.entries(groups).map(([team, satisfied]) =>
        req([team], satisfied),
      );
      return {
        requirements,
        minimum: null,
        allSatisfied: requirements.length > 0 && requirements.every((r) => r.satisfied),
      };
    };

    /** The five cases agreed for the Monetization channel, REQUIRED_APPROVALS=2. */
    it('row 1: nothing reviewed and the team owes a review -> no_reviews', () => {
      const status = withGroups({ [TEAM]: false });
      expect(computeCodeownerState(makePr('no_reviews', serialise(status)), TEAM)).toBe(
        'no_reviews',
      );
    });

    it('row 2: approvals from others while the team still owes one -> partial', () => {
      const status = withGroups({ [TEAM]: false });
      expect(computeCodeownerState(makePr('approved', serialise(status)), TEAM)).toBe('partial');
    });

    it('row 3: team signed off, count short, nobody else to meet it -> partial', () => {
      // The team is the only codeowner, so the second approval has to come from
      // them — they still owe one.
      const status = withGroups({ [TEAM]: true });
      expect(computeCodeownerState(makePr('partial', serialise(status)), TEAM)).toBe('partial');
    });

    it('row 4: team signed off and another group will meet the count -> approved', () => {
      // This is the upgrade: a single approval, but the team owes nothing more
      // and frontend's eventual sign-off meets the count.
      const status = withGroups({ [TEAM]: true, 'frontend-team': false });
      expect(computeCodeownerState(makePr('partial', serialise(status)), TEAM)).toBe('approved');
    });

    it('row 5: team signed off and the count is met -> approved', () => {
      for (const status of [
        withGroups({ [TEAM]: true }),
        withGroups({ [TEAM]: true, 'frontend-team': false }),
        withGroups({ [TEAM]: true, 'frontend-team': true }),
      ]) {
        expect(computeCodeownerState(makePr('approved', serialise(status)), TEAM)).toBe('approved');
      }
    });

    it('reads an OR group the team belongs to as their own', () => {
      const status: CodeownerStatus = {
        requirements: [req([TEAM, 'creator-team'], true)],
        minimum: null,
        allSatisfied: true,
      };
      expect(computeCodeownerState(makePr('approved', serialise(status)), TEAM)).toBe('approved');
    });

    it('counts an unsatisfied AND rule even when the team’s OR group is satisfied', () => {
      const status: CodeownerStatus = {
        requirements: [req([TEAM], false), req([TEAM, 'creator-team'], true)],
        minimum: null,
        allSatisfied: false,
      };
      expect(computeCodeownerState(makePr('approved', serialise(status)), TEAM)).toBe('partial');
    });

    describe('when the team owns none of the changed files', () => {
      // All they can still owe is a +1 towards the count, so the count alone
      // answers it. Another group's outstanding review is not this channel's
      // question: holding at partial over it would ask for an action nobody in
      // the room can take.
      it('reports approved once the count is met, whoever is still outstanding', () => {
        for (const status of [
          withGroups({ 'push-service': true }),
          withGroups({ 'push-service': false }),
          withGroups({ 'push-service': false, 'frontend-team': false }),
        ]) {
          expect(computeCodeownerState(makePr('approved', serialise(status)), TEAM)).toBe(
            'approved',
          );
        }
      });

      it('asks for the +1 while the count is short', () => {
        for (const status of [
          withGroups({ 'push-service': true }),
          withGroups({ 'push-service': false }),
        ]) {
          expect(computeCodeownerState(makePr('partial', serialise(status)), TEAM)).toBe('partial');
          expect(computeCodeownerState(makePr('no_reviews', serialise(status)), TEAM)).toBe(
            'no_reviews',
          );
        }
      });

      it('is exactly the approval count, with no codeowner influence at all', () => {
        const status = withGroups({ 'push-service': false });
        for (const state of REVIEW_STATES) {
          expect(computeCodeownerState(makePr(state, serialise(status)), TEAM), state).toBe(state);
        }
      });
    });

    it('leaves the public rule alone for the same statuses', () => {
      // The private relaxation must not leak: with no team view, an outstanding
      // group still holds an approved PR back.
      const status = withGroups({ 'push-service': false });
      expect(computeCodeownerState(makePr('approved', serialise(status)))).toBe('partial');
      expect(computeCodeownerState(makePr('partial', serialise(status)))).toBe('partial');
    });

    it('falls back to the approval count with no codeowner data', () => {
      for (const state of REVIEW_STATES) {
        expect(computeCodeownerState(makePr(state, null), TEAM), state).toBe(state);
        expect(computeCodeownerState(makePr(state, '{not json'), TEAM), state).toBe(state);
      }
    });

    it('still defers to terminal and blocking states', () => {
      const status = withGroups({ [TEAM]: true, 'frontend-team': false });
      for (const state of PASS_THROUGH) {
        expect(computeCodeownerState(makePr(state, serialise(status)), TEAM), state).toBe(state);
      }
    });

    it('never upgrades without a team view', () => {
      // The same status that reaches approved for the team must not do so in a
      // public channel, where other groups are reading.
      const status = withGroups({ [TEAM]: true, 'frontend-team': false });
      expect(computeCodeownerState(makePr('partial', serialise(status)))).toBe('partial');
      expect(computeCodeownerState(makePr('approved', serialise(status)))).toBe('partial');
    });
  });

  describe('invariants', () => {
    it('never moves a PR that has approvals down to no_reviews', () => {
      // Codeowner status must not strip a reaction off a message that had one.
      for (const [name, status] of ALL_STATUSES) {
        for (const state of ['partial', 'approved'] as const) {
          expect(computeCodeownerState(makePr(state, serialise(status))), `${state} + ${name}`).not.toBe(
            'no_reviews',
          );
        }
      }
    });

    it('never advances a PR beyond the approval count without a team view', () => {
      for (const [name, status] of ALL_STATUSES) {
        for (const state of REVIEW_STATES) {
          const actual = computeCodeownerState(makePr(state, serialise(status)));
          if (state !== 'approved') {
            expect(actual, `${state} + ${name}`).not.toBe('approved');
          }
        }
      }
    });
  });
});

describe('managedEmojis', () => {
  it('lists only the emoji the bot may touch', () => {
    expect(managedEmojis(emoji)).toEqual([
      'please',
      'request-changes',
      '1of2',
      'white_check_mark',
      'merged',
      'x',
      'sleeping',
    ]);
    expect(managedEmojis({ ...emoji, closed: null })).toEqual([
      'please',
      'request-changes',
      '1of2',
      'white_check_mark',
      'merged',
      'sleeping',
    ]);
  });
});
