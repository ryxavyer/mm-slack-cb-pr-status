import { describe, expect, it } from 'vitest';
import { parseCodeownerComment } from '../src/github/codeowner-comment.js';

describe('parseCodeownerComment', () => {
  it('returns null for an unrelated comment', () => {
    expect(parseCodeownerComment('LGTM!')).toBeNull();
    expect(parseCodeownerComment('')).toBeNull();
    expect(parseCodeownerComment('Please add tests')).toBeNull();
  });

  it('parses the all-satisfied terminal comment', () => {
    const result = parseCodeownerComment('Codeowners reviews satisfied');
    expect(result).toEqual({ requirements: [], minimum: null, allSatisfied: true });
  });

  it('handles surrounding whitespace on the terminal comment', () => {
    expect(parseCodeownerComment('  Codeowners reviews satisfied  ')).toEqual({
      requirements: [],
      minimum: null,
      allSatisfied: true,
    });
  });

  it('parses a single satisfied AND requirement (example 2 — messaging-pod)', () => {
    const body = `Codeowners approval required for this PR:

@multimediallc/creator-team
✅ @multimediallc/messaging-pod
Show detailed file reviewers`;

    const result = parseCodeownerComment(body);
    expect(result).not.toBeNull();
    expect(result!.requirements).toHaveLength(2);
    expect(result!.requirements).toContainEqual({ teams: ['creator-team'], satisfied: false });
    expect(result!.requirements).toContainEqual({ teams: ['messaging-pod'], satisfied: true });
    expect(result!.minimum).toBeNull();
    expect(result!.allSatisfied).toBe(false);
  });

  it('parses the minimum-not-met case with one satisfied team (example 1)', () => {
    const body = `Codeowners approval required for this PR:

✅ @multimediallc/viewer-team
Minimum review requirement not met. Need 2 reviews, found 1. Reviews have been re-requested from owning teams, but any additional approval can satisfy minimum.`;

    const result = parseCodeownerComment(body);
    expect(result).not.toBeNull();
    expect(result!.requirements).toHaveLength(1);
    expect(result!.requirements[0]).toEqual({ teams: ['viewer-team'], satisfied: true });
    expect(result!.minimum).toEqual({ required: 2, found: 1, met: false });
    expect(result!.allSatisfied).toBe(false);
  });

  it('parses a satisfied OR group (example 3)', () => {
    const body = `Codeowners approval required for this PR:

@multimediallc/design-system-stewards
@multimediallc/viewer-team
✅ @multimediallc/viewer-team or @multimediallc/creator-team
Show detailed file reviewers`;

    const result = parseCodeownerComment(body);
    expect(result).not.toBeNull();
    expect(result!.requirements).toHaveLength(3);
    expect(result!.requirements).toContainEqual({ teams: ['design-system-stewards'], satisfied: false });
    expect(result!.requirements).toContainEqual({ teams: ['viewer-team'], satisfied: false });
    expect(result!.requirements).toContainEqual({
      teams: ['viewer-team', 'creator-team'],
      satisfied: true,
    });
    expect(result!.allSatisfied).toBe(false);
  });

  it('marks allSatisfied true only when every requirement is satisfied and minimum is met', () => {
    const body = `Codeowners approval required for this PR:

✅ @multimediallc/creator-team
✅ @multimediallc/platform-team`;

    const result = parseCodeownerComment(body);
    expect(result!.allSatisfied).toBe(true);
  });

  it('does not mark allSatisfied when minimum is outstanding', () => {
    const body = `Codeowners approval required for this PR:

✅ @multimediallc/viewer-team
Minimum review requirement not met. Need 2 reviews, found 1.`;

    const result = parseCodeownerComment(body);
    expect(result!.allSatisfied).toBe(false);
  });

  it('returns allSatisfied false when any requirement is unsatisfied', () => {
    const body = `Codeowners approval required for this PR:

✅ @multimediallc/creator-team
@multimediallc/platform-team`;

    const result = parseCodeownerComment(body);
    expect(result!.allSatisfied).toBe(false);
  });

  it('ignores "Show detailed file reviewers" lines', () => {
    const body = `Codeowners approval required for this PR:

✅ @multimediallc/creator-team
Show detailed file reviewers`;

    const result = parseCodeownerComment(body);
    expect(result!.requirements).toHaveLength(1);
  });
});
