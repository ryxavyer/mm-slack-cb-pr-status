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

  describe('real comment bodies, verbatim from the API', () => {
    // The bot renders requirements as markdown list items and edits one comment
    // in place. Fixtures written without the "- " marker passed a parser that
    // could not read a single real comment, so these are copied from the wire.

    it('reads a satisfied requirement written as a markdown list item', () => {
      const body = [
        'Codeowners approval required for this PR:',
        '- \u2705 @multimediallc/media-library-experts',
        '',
        '<details><summary>Show detailed file reviewers</summary>',
        '',
        '',
        '</details>',
      ].join('\n');

      const result = parseCodeownerComment(body);
      expect(result).not.toBeNull();
      expect(result!.requirements).toEqual([
        { teams: ['media-library-experts'], satisfied: true },
      ]);
      expect(result!.allSatisfied).toBe(true);
    });

    it('reads an outstanding requirement written as a markdown list item', () => {
      const body = [
        'Codeowners approval required for this PR:',
        '- @multimediallc/media-library-experts',
        '',
        '<details><summary>Show detailed file reviewers</summary>',
        '</details>',
      ].join('\n');

      const result = parseCodeownerComment(body);
      expect(result!.requirements).toEqual([
        { teams: ['media-library-experts'], satisfied: false },
      ]);
      expect(result!.allSatisfied).toBe(false);
    });

    it('reads a mix of satisfied and outstanding list items', () => {
      const body = [
        'Codeowners approval required for this PR:',
        '- \u2705 @multimediallc/media-library-experts',
        '- @multimediallc/creator-team',
        '<details><summary>Show detailed file reviewers</summary></details>',
      ].join('\n');

      const result = parseCodeownerComment(body);
      expect(result!.requirements).toEqual([
        { teams: ['media-library-experts'], satisfied: true },
        { teams: ['creator-team'], satisfied: false },
      ]);
      expect(result!.allSatisfied).toBe(false);
    });

    it('reads a satisfied OR group written as a list item', () => {
      const body = [
        'Codeowners approval required for this PR:',
        '- \u2705 @multimediallc/viewer-team or @multimediallc/creator-team',
      ].join('\n');

      const result = parseCodeownerComment(body);
      expect(result!.requirements).toEqual([
        { teams: ['viewer-team', 'creator-team'], satisfied: true },
      ]);
      expect(result!.allSatisfied).toBe(true);
    });

    it('reads the review minimum from a list item', () => {
      const body = [
        'Codeowners approval required for this PR:',
        '- \u2705 @multimediallc/viewer-team',
        '- Minimum review requirement not met. Need 2 reviews, found 1.',
      ].join('\n');

      const result = parseCodeownerComment(body);
      expect(result!.minimum).toEqual({ required: 2, found: 1, met: false });
      expect(result!.allSatisfied).toBe(false);
    });

    it('accepts the all-clear while the original header is still in place', () => {
      // The bot edits its comment rather than posting a new one, so the all-clear
      // can arrive underneath the header it originally posted.
      const body = ['Codeowners approval required for this PR:', '', 'Codeowners reviews satisfied'].join(
        '\n',
      );

      expect(parseCodeownerComment(body)).toEqual({
        requirements: [],
        minimum: null,
        allSatisfied: true,
      });
    });

    it('accepts the all-clear as a list item', () => {
      expect(parseCodeownerComment('- Codeowners reviews satisfied')).toEqual({
        requirements: [],
        minimum: null,
        allSatisfied: true,
      });
    });

    it('still ignores comments from anything else', () => {
      expect(parseCodeownerComment('- LGTM!')).toBeNull();
      expect(parseCodeownerComment('<h3>Confidence Score: 4/5</h3>')).toBeNull();
      expect(parseCodeownerComment('<!-- qodo:trial-expiring -->')).toBeNull();
      expect(parseCodeownerComment('## Summary of Changes')).toBeNull();
    });

  });

  describe('layout independence', () => {
    // The bot owns its own formatting and may change it. None of these are
    // layouts it is known to emit; they are here so that if it starts, the
    // meaning still comes through.
    const HEADER = 'Codeowners approval required for this PR:';

    const SATISFIED_LAYOUTS: [string, string][] = [
      ['bare', '\u2705 @multimediallc/creator-team'],
      ['dash list item', '- \u2705 @multimediallc/creator-team'],
      ['star list item', '* \u2705 @multimediallc/creator-team'],
      ['plus list item', '+ \u2705 @multimediallc/creator-team'],
      ['numbered list item', '1. \u2705 @multimediallc/creator-team'],
      ['numbered with paren', '1) \u2705 @multimediallc/creator-team'],
      ['nested list item', '  - \u2705 @multimediallc/creator-team'],
      ['tab indented', '\t\u2705 @multimediallc/creator-team'],
      ['blockquote', '> \u2705 @multimediallc/creator-team'],
      ['bold team', '- \u2705 **@multimediallc/creator-team**'],
      ['table row', '| \u2705 | @multimediallc/creator-team |'],
      ['table row, tick last', '| @multimediallc/creator-team | \u2705 |'],
      ['tick after the team', '- @multimediallc/creator-team \u2705'],
      ['checkbox and tick', '- [x] \u2705 @multimediallc/creator-team'],
      ['trailing whitespace', '- \u2705 @multimediallc/creator-team   '],
      ['html list item', '<li>\u2705 @multimediallc/creator-team</li>'],
    ];

    for (const [name, line] of SATISFIED_LAYOUTS) {
      it(`reads a satisfied requirement written as: ${name}`, () => {
        const result = parseCodeownerComment(`${HEADER}\n${line}`);
        expect(result!.requirements).toEqual([{ teams: ['creator-team'], satisfied: true }]);
        expect(result!.allSatisfied).toBe(true);
      });
    }

    const OUTSTANDING_LAYOUTS: [string, string][] = [
      ['bare', '@multimediallc/creator-team'],
      ['dash list item', '- @multimediallc/creator-team'],
      ['numbered list item', '1. @multimediallc/creator-team'],
      ['nested list item', '  - @multimediallc/creator-team'],
      ['blockquote', '> @multimediallc/creator-team'],
      ['bold team', '- **@multimediallc/creator-team**'],
      ['table row', '| | @multimediallc/creator-team |'],
      ['html list item', '<li>@multimediallc/creator-team</li>'],
    ];

    for (const [name, line] of OUTSTANDING_LAYOUTS) {
      it(`reads an outstanding requirement written as: ${name}`, () => {
        const result = parseCodeownerComment(`${HEADER}\n${line}`);
        expect(result!.requirements).toEqual([{ teams: ['creator-team'], satisfied: false }]);
        expect(result!.allSatisfied).toBe(false);
      });
    }

    it('recognises the header regardless of its own formatting', () => {
      for (const header of [
        'Codeowners approval required for this PR:',
        '**Codeowners approval required for this PR:**',
        '## Codeowners approval required',
        '> Codeowners approval required for this PR',
        'CODEOWNERS APPROVAL REQUIRED',
        'Codeowner approval required',
      ]) {
        const result = parseCodeownerComment(`${header}\n- \u2705 @multimediallc/creator-team`);
        expect(result, header).not.toBeNull();
        expect(result!.allSatisfied, header).toBe(true);
      }
    });

    it('recognises the all-clear regardless of its own formatting', () => {
      for (const body of [
        'Codeowners reviews satisfied',
        '  Codeowners reviews satisfied  ',
        '- Codeowners reviews satisfied',
        '**Codeowners reviews satisfied**',
        '\u2705 Codeowners reviews satisfied',
        'Codeowners reviews satisfied.',
        '## Codeowners review satisfied',
        'Codeowners approval required for this PR:\n\nCodeowners reviews satisfied',
      ]) {
        expect(parseCodeownerComment(body), body).toEqual({
          requirements: [],
          minimum: null,
          allSatisfied: true,
        });
      }
    });

    it('reads the review minimum regardless of its own formatting', () => {
      for (const line of [
        'Minimum review requirement not met. Need 2 reviews, found 1.',
        '- Minimum review requirement not met. Need 2 reviews, found 1.',
        '> need 2 reviews, found 1',
        '**Need 2 reviews, found 1.**',
      ]) {
        const result = parseCodeownerComment(
          `${HEADER}\n- \u2705 @multimediallc/creator-team\n${line}`,
        );
        expect(result!.minimum, line).toEqual({ required: 2, found: 1, met: false });
        expect(result!.allSatisfied, line).toBe(false);
      }
    });

    it('ignores the collapsed per-file breakdown', () => {
      // The breakdown repeats the same teams against individual files. Parsing it
      // would invent duplicate requirements with no tick attached, leaving an
      // approved PR looking permanently outstanding.
      const body = [
        HEADER,
        '- \u2705 @multimediallc/media-library-experts',
        '',
        '<details><summary>Show detailed file reviewers</summary>',
        '',
        '| File | Owners |',
        '| --- | --- |',
        '| src/media/a.py | @multimediallc/media-library-experts |',
        '| src/media/b.py | @multimediallc/media-library-experts |',
        '',
        '</details>',
      ].join('\n');

      const result = parseCodeownerComment(body);
      expect(result!.requirements).toEqual([
        { teams: ['media-library-experts'], satisfied: true },
      ]);
      expect(result!.allSatisfied).toBe(true);
    });

    it('does not mistake an unrelated comment for a status comment', () => {
      // Author filtering is the first line of defence, but the parser is also what
      // decides which of the bot's comments is the status one.
      for (const body of [
        'LGTM!',
        '- LGTM!',
        '',
        '   ',
        'cc @multimediallc/creator-team can you take a look?',
        '<h3>Confidence Score: 4/5</h3>',
        '<!-- qodo:trial-expiring -->',
        '## Summary of Changes',
      ]) {
        expect(parseCodeownerComment(body), JSON.stringify(body)).toBeNull();
      }
    });
  });

  it('ignores "Show detailed file reviewers" lines', () => {
    const body = `Codeowners approval required for this PR:

✅ @multimediallc/creator-team
Show detailed file reviewers`;

    const result = parseCodeownerComment(body);
    expect(result!.requirements).toHaveLength(1);
  });
});
