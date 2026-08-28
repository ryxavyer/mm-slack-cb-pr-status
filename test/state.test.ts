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

  // ---------------------------------------------------------------------------
  // Every shape the codeowner bot's comment can parse into. Named for the
  // situation on the PR, not the JSON.
  // ---------------------------------------------------------------------------
  const req = (teams: string[], satisfied: boolean) => ({ teams, satisfied });

  /** "Codeowners reviews satisfied" — the bot's terminal comment. */
  const DONE_NO_REQS: CodeownerStatus = { requirements: [], minimum: null, allSatisfied: true };
  /** One team owns the files and has approved. */
  const DONE_ONE_REQ: CodeownerStatus = {
    requirements: [req(['creator-team'], true)],
    minimum: null,
    allSatisfied: true,
  };
  /** Team approved and the bot's own review minimum is met. */
  const DONE_MIN_MET: CodeownerStatus = {
    requirements: [req(['creator-team'], true)],
    minimum: { required: 2, found: 2, met: true },
    allSatisfied: true,
  };
  /** Team approved, but "Need 2 reviews, found 1" is still outstanding. */
  const DONE_MIN_UNMET: CodeownerStatus = {
    requirements: [req(['creator-team'], true)],
    minimum: { required: 2, found: 1, met: false },
    allSatisfied: false,
  };
  /** One team owns the files and has not approved. */
  const PENDING_ONE: CodeownerStatus = {
    requirements: [req(['creator-team'], false)],
    minimum: null,
    allSatisfied: false,
  };
  /** Two owning teams, one done and one not. */
  const MIXED: CodeownerStatus = {
    requirements: [req(['creator-team'], true), req(['platform-team'], false)],
    minimum: null,
    allSatisfied: false,
  };
  /** An OR group satisfied by creator-team, alongside unsatisfied AND rules. */
  const OR_GROUP: CodeownerStatus = {
    requirements: [
      req(['design-system-stewards'], false),
      req(['viewer-team'], false),
      req(['viewer-team', 'creator-team'], true),
    ],
    minimum: null,
    allSatisfied: false,
  };
  /** Header recognised but no requirement line parsed out of it. */
  const NO_REQS_PENDING: CodeownerStatus = {
    requirements: [],
    minimum: null,
    allSatisfied: false,
  };

  const ALL_STATUSES: [string, CodeownerStatus][] = [
    ['DONE_NO_REQS', DONE_NO_REQS],
    ['DONE_ONE_REQ', DONE_ONE_REQ],
    ['DONE_MIN_MET', DONE_MIN_MET],
    ['DONE_MIN_UNMET', DONE_MIN_UNMET],
    ['PENDING_ONE', PENDING_ONE],
    ['MIXED', MIXED],
    ['OR_GROUP', OR_GROUP],
    ['NO_REQS_PENDING', NO_REQS_PENDING],
  ];

  // ---------------------------------------------------------------------------
  // The three states codeowner data is allowed to act on. Every case below says
  // what each of them maps to, so no combination is left unasserted.
  // ---------------------------------------------------------------------------
  const REVIEW_STATES = ['no_reviews', 'partial', 'approved'] as const;
  type ReviewState = (typeof REVIEW_STATES)[number];
  type Expected = Record<ReviewState, PrState>;

  /** Codeowner data changed nothing — the approval count stands. */
  const UNCHANGED: Expected = {
    no_reviews: 'no_reviews',
    partial: 'partial',
    approved: 'approved',
  };
  /** The bot declared it done; that outranks the approval count either way. */
  const ALWAYS_APPROVED: Expected = {
    no_reviews: 'approved',
    partial: 'approved',
    approved: 'approved',
  };
  /** Held back from the green check, but never stripped down to no emoji. */
  const CAPPED_AT_PARTIAL: Expected = {
    no_reviews: 'no_reviews',
    partial: 'partial',
    approved: 'partial',
  };
  /** The team is done but a review minimum is not: partial regardless. */
  const ALWAYS_PARTIAL: Expected = {
    no_reviews: 'partial',
    partial: 'partial',
    approved: 'partial',
  };

  function expectAcrossStates(
    status: CodeownerStatus | null,
    teamSlug: string | undefined,
    expected: Expected,
  ): void {
    for (const state of REVIEW_STATES) {
      const actual = computeCodeownerState(makePr(state, serialise(status)), teamSlug);
      expect(actual, `pr.state=${state} team=${teamSlug ?? '(none)'} → ${expected[state]}`).toBe(
        expected[state],
      );
    }
  }

  describe('terminal and blocking states pass through untouched', () => {
    const PASS_THROUGH = ['merged', 'closed', 'unknown', 'changes_requested'] as const;

    for (const state of PASS_THROUGH) {
      it(`keeps ${state} for every codeowner status, with and without a team`, () => {
        for (const [name, status] of ALL_STATUSES) {
          for (const teamSlug of [undefined, 'creator-team', 'messaging-pod']) {
            const actual = computeCodeownerState(makePr(state, serialise(status)), teamSlug);
            expect(actual, `${state} + ${name} + team=${teamSlug ?? '(none)'}`).toBe(state);
          }
        }
      });
    }
  });

  describe('with no usable codeowner data', () => {
    it('falls back to pr.state when the bot has not commented', () => {
      expectAcrossStates(null, undefined, UNCHANGED);
      expectAcrossStates(null, 'creator-team', UNCHANGED);
    });

    it('falls back to pr.state when the stored JSON will not parse', () => {
      for (const state of REVIEW_STATES) {
        expect(computeCodeownerState(makePr(state, '{not json'), undefined)).toBe(state);
        expect(computeCodeownerState(makePr(state, '{not json'), 'creator-team')).toBe(state);
      }
    });
  });

  describe('when the bot reports every requirement satisfied', () => {
    // This is the one signal that applies with or without a team: the bot knows
    // the repo's real rule, so a single approval from the owning team can settle
    // a PR that REQUIRED_APPROVALS alone would still call partial.
    for (const [name, status] of [
      ['the terminal "reviews satisfied" comment', DONE_NO_REQS],
      ['an approved single requirement', DONE_ONE_REQ],
      ['an approved requirement with the minimum met', DONE_MIN_MET],
    ] as [string, CodeownerStatus][]) {
      it(`reports approved for ${name}, in any channel context`, () => {
        expectAcrossStates(status, undefined, ALWAYS_APPROVED);
        expectAcrossStates(status, 'creator-team', ALWAYS_APPROVED);
        expectAcrossStates(status, 'messaging-pod', ALWAYS_APPROVED);
      });
    }
  });

  describe('without a teamSlug and with work outstanding', () => {
    // Nothing here can raise the state, and with no team in the picture there is
    // nobody whose outstanding review would justify lowering it.
    for (const [name, status] of [
      ['DONE_MIN_UNMET', DONE_MIN_UNMET],
      ['PENDING_ONE', PENDING_ONE],
      ['MIXED', MIXED],
      ['OR_GROUP', OR_GROUP],
      ['NO_REQS_PENDING', NO_REQS_PENDING],
    ] as [string, CodeownerStatus][]) {
      it(`leaves the approval count alone for ${name}`, () => {
        expectAcrossStates(status, undefined, UNCHANGED);
      });
    }
  });

  describe('with a teamSlug the PR does not involve', () => {
    // messaging-pod owns none of the changed files, so another team's
    // outstanding requirement says nothing about what this channel is waiting on.
    for (const [name, status] of [
      ['DONE_MIN_UNMET', DONE_MIN_UNMET],
      ['PENDING_ONE', PENDING_ONE],
      ['MIXED', MIXED],
      ['OR_GROUP', OR_GROUP],
      ['NO_REQS_PENDING', NO_REQS_PENDING],
    ] as [string, CodeownerStatus][]) {
      it(`falls back to the approval count for ${name}`, () => {
        expectAcrossStates(status, 'messaging-pod', UNCHANGED);
      });
    }
  });

  describe('with a teamSlug that still owes a review', () => {
    it('caps a single unsatisfied requirement at partial', () => {
      expectAcrossStates(PENDING_ONE, 'creator-team', CAPPED_AT_PARTIAL);
    });

    it('caps the team that has not approved in a mixed status', () => {
      expectAcrossStates(MIXED, 'platform-team', CAPPED_AT_PARTIAL);
    });

    it('counts an unsatisfied AND requirement even when an OR group is satisfied', () => {
      expectAcrossStates(OR_GROUP, 'viewer-team', CAPPED_AT_PARTIAL);
    });

    it('caps a team whose only requirement is unsatisfied in an OR-group status', () => {
      expectAcrossStates(OR_GROUP, 'design-system-stewards', CAPPED_AT_PARTIAL);
    });
  });

  describe('with a teamSlug that has signed off', () => {
    it('reports approved when the team is done and others are not', () => {
      expectAcrossStates(MIXED, 'creator-team', ALWAYS_APPROVED);
    });

    it('reports approved when only the team’s OR group is satisfied', () => {
      expectAcrossStates(OR_GROUP, 'creator-team', ALWAYS_APPROVED);
    });

    it('holds at partial when the bot’s review minimum is still outstanding', () => {
      expectAcrossStates(DONE_MIN_UNMET, 'creator-team', ALWAYS_PARTIAL);
    });
  });

  describe('the regression this logic caused once', () => {
    // Codeowner status must never take a message from an emoji down to none:
    // "no codeowner sign-off yet" and "nobody has looked at this" are different
    // things, and collapsing them strips the reaction off the message.
    it('never maps a reviewed PR to no_reviews', () => {
      for (const [name, status] of ALL_STATUSES) {
        for (const teamSlug of [
          undefined,
          'creator-team',
          'platform-team',
          'viewer-team',
          'design-system-stewards',
          'messaging-pod',
        ]) {
          for (const state of ['partial', 'approved'] as const) {
            const actual = computeCodeownerState(makePr(state, serialise(status)), teamSlug);
            expect(actual, `${state} + ${name} + team=${teamSlug ?? '(none)'}`).not.toBe(
              'no_reviews',
            );
          }
        }
      }
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
