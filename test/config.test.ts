import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const required = {
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_APP_TOKEN: 'xapp-test',
  GITHUB_TOKEN: 'github_pat_test',
  WATCHED_CHANNELS: 'C0123ABC',
};

describe('loadConfig', () => {
  it('applies the documented defaults', () => {
    const config = loadConfig({ ...required });
    expect(config.requiredApprovals).toBe(2);
    expect(config.pollIntervalMs).toBe(90_000);
    expect(config.cleanupTtlMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(config.databasePath).toBe('/data/bot.sqlite');
    expect(config.emoji).toEqual({
      partial: 'eyes',
      approved: 'white_check_mark',
      merged: 'merged',
      closed: 'x',
      unknown: 'sleeping',
    });
    expect(config.unreachableTtlMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('parses a channel allowlist, trimming whitespace', () => {
    const config = loadConfig({ ...required, WATCHED_CHANNELS: 'C0123ABC, C0456DEF ,' });
    expect([...config.watchedChannels]).toEqual(['C0123ABC', 'C0456DEF']);
  });

  it('strips colons from emoji names', () => {
    const config = loadConfig({ ...required, EMOJI_APPROVED: ':shipit:' });
    expect(config.emoji.approved).toBe('shipit');
  });

  it('reads an empty emoji as "no reaction for this state"', () => {
    const config = loadConfig({ ...required, EMOJI_CLOSED: '' });
    expect(config.emoji.closed).toBeNull();
  });

  it('rejects a missing token', () => {
    expect(() => loadConfig({ ...required, SLACK_BOT_TOKEN: undefined })).toThrow(
      /SLACK_BOT_TOKEN/,
    );
  });

  it('rejects an empty channel allowlist', () => {
    expect(() => loadConfig({ ...required, WATCHED_CHANNELS: '' })).toThrow(/WATCHED_CHANNELS/);
    expect(() => loadConfig({ ...required, WATCHED_CHANNELS: undefined })).toThrow(
      /WATCHED_CHANNELS/,
    );
  });

  it('rejects nonsense numbers instead of silently defaulting', () => {
    expect(() => loadConfig({ ...required, REQUIRED_APPROVALS: 'many' })).toThrow(
      /REQUIRED_APPROVALS/,
    );
    expect(() => loadConfig({ ...required, POLL_INTERVAL_SECONDS: '1' })).toThrow(
      /POLL_INTERVAL_SECONDS/,
    );
  });

  it('reports every problem at once', () => {
    expect(() => loadConfig({})).toThrow(/SLACK_BOT_TOKEN[\s\S]*GITHUB_TOKEN/);
  });

  it('accepts the usual boolean spellings for the message scan flag', () => {
    expect(loadConfig({ ...required, ENABLE_MESSAGE_SCAN: 'false' }).enableMessageScan).toBe(false);
    expect(loadConfig({ ...required, ENABLE_MESSAGE_SCAN: 'TRUE' }).enableMessageScan).toBe(true);
    expect(loadConfig({ ...required }).enableMessageScan).toBe(true);
  });
});
