import { describe, expect, it } from 'vitest';
import { parseGroupMentions } from '../src/slack/parse-mentions.js';

describe('parseGroupMentions', () => {
  it('returns empty array for empty or null input', () => {
    expect(parseGroupMentions('')).toEqual([]);
    expect(parseGroupMentions(null)).toEqual([]);
    expect(parseGroupMentions(undefined)).toEqual([]);
  });

  it('returns empty array when no group mentions are present', () => {
    expect(parseGroupMentions('hey can someone review this PR?')).toEqual([]);
    expect(parseGroupMentions('<@U12345> please review')).toEqual([]);
  });

  it('extracts a single group mention handle', () => {
    expect(
      parseGroupMentions('hey <!subteam^S123ABC|@cb-creator-team> can you review?'),
    ).toEqual(['cb-creator-team']);
  });

  it('extracts multiple group mentions from one message', () => {
    expect(
      parseGroupMentions(
        '<!subteam^S111|@cb-creator-team> or <!subteam^S222|@cb-messaging-pod> please review',
      ),
    ).toEqual(['cb-creator-team', 'cb-messaging-pod']);
  });

  it('de-duplicates repeated mentions of the same group', () => {
    expect(
      parseGroupMentions(
        '<!subteam^S123|@cb-creator-team> and <!subteam^S123|@cb-creator-team>',
      ),
    ).toEqual(['cb-creator-team']);
  });

  it('normalises handles to lowercase', () => {
    expect(parseGroupMentions('<!subteam^S999|@CB-Creator-Team>')).toEqual(['cb-creator-team']);
  });

  it('extracts handle from a realistic Slack message with a PR link', () => {
    const text =
      'hey <!subteam^S456DEF|@cb-frontend-room-experts> can you review https://github.com/acme/repo/pull/42?';
    expect(parseGroupMentions(text)).toEqual(['cb-frontend-room-experts']);
  });
});
