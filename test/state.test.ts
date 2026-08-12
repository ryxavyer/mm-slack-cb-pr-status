import { describe, expect, it } from 'vitest';
import type { EmojiConfig } from '../src/config.js';
import { computeState, emojiForState, isTerminal, managedEmojis } from '../src/state.js';

const emoji: EmojiConfig = {
  partial: '1of2',
  approved: 'white_check_mark',
  merged: 'merged',
  closed: 'x',
  unknown: 'sleeping',
};

describe('computeState', () => {
  const base = { merged: false, closed: false, approvals: 0, requiredApprovals: 2 };

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
  });

  it('keeps polling an unknown PR so restored access self-heals it', () => {
    expect(isTerminal('unknown')).toBe(false);
  });
});

describe('emojiForState', () => {
  it('maps each state to its configured emoji', () => {
    expect(emojiForState('no_reviews', emoji)).toBeNull();
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

describe('managedEmojis', () => {
  it('lists only the emoji the bot may touch', () => {
    expect(managedEmojis(emoji)).toEqual([
      '1of2',
      'white_check_mark',
      'merged',
      'x',
      'sleeping',
    ]);
    expect(managedEmojis({ ...emoji, closed: null })).toEqual([
      '1of2',
      'white_check_mark',
      'merged',
      'sleeping',
    ]);
  });
});
