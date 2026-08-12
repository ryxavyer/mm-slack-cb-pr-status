import { describe, expect, it } from 'vitest';
import { parsePrLinks } from '../src/slack/parse-pr-links.js';

describe('parsePrLinks', () => {
  it('parses a plain PR url', () => {
    expect(parsePrLinks('https://github.com/acme/monolith/pull/42')).toEqual([
      { owner: 'acme', repo: 'monolith', number: 42 },
    ]);
  });

  it('tolerates the shapes Slack produces', () => {
    const cases = [
      '<https://github.com/acme/monolith/pull/42>',
      '<https://github.com/acme/monolith/pull/42|acme/monolith#42>',
      'please review <https://github.com/acme/monolith/pull/42/files> today',
      'http://www.github.com/acme/monolith/pull/42?w=1',
      'https://github.com/acme/monolith/pull/42#discussion_r12345',
      'https://github.com/acme/monolith/pull/42/commits/abc123',
      'ready: https://github.com/acme/monolith/pull/42.',
    ];
    for (const text of cases) {
      expect(parsePrLinks(text), text).toEqual([{ owner: 'acme', repo: 'monolith', number: 42 }]);
    }
  });

  it('finds several PRs in one message and de-duplicates them', () => {
    const text = `
      https://github.com/acme/monolith/pull/1
      https://github.com/acme/monolith/pull/2
      https://github.com/acme/monolith/pull/1/files
    `;
    expect(parsePrLinks(text)).toEqual([
      { owner: 'acme', repo: 'monolith', number: 1 },
      { owner: 'acme', repo: 'monolith', number: 2 },
    ]);
  });

  it('normalises owner and repo case so one PR is one row', () => {
    expect(parsePrLinks('https://github.com/Acme/MonoLith/pull/7')).toEqual([
      { owner: 'acme', repo: 'monolith', number: 7 },
    ]);
    expect(
      parsePrLinks('https://github.com/Acme/Repo/pull/7 https://github.com/acme/repo/pull/7'),
    ).toHaveLength(1);
  });

  it('accepts dots, underscores and hyphens in repo names', () => {
    expect(parsePrLinks('https://github.com/acme-org/my_repo.js/pull/9')).toEqual([
      { owner: 'acme-org', repo: 'my_repo.js', number: 9 },
    ]);
  });

  it('ignores non-PR github links', () => {
    const cases = [
      'https://github.com/acme/monolith',
      'https://github.com/acme/monolith/issues/42',
      'https://github.com/acme/monolith/pull/',
      'https://github.com/orgs/acme/projects/3',
      'https://gitlab.com/acme/monolith/pull/42',
      'https://notgithub.com/acme/monolith/pull/42',
      'https://github.com/acme/monolith/compare/main...feature',
    ];
    for (const text of cases) {
      expect(parsePrLinks(text), text).toEqual([]);
    }
  });

  it('does not treat a number-with-suffix as a PR number', () => {
    expect(parsePrLinks('https://github.com/acme/monolith/pull/42-old')).toEqual([]);
  });

  it('handles empty and missing input', () => {
    expect(parsePrLinks('')).toEqual([]);
    expect(parsePrLinks(undefined)).toEqual([]);
    expect(parsePrLinks(null)).toEqual([]);
    expect(parsePrLinks('no links here at all')).toEqual([]);
  });
});
