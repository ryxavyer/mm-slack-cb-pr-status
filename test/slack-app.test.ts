import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { Config } from '../src/config.js';
import type { DbHandle } from '../src/db/client.js';
import type { Store } from '../src/db/store.js';
import { PrService } from '../src/pr-service.js';
import { Reconciler } from '../src/reconciler.js';
import { createSlackApp } from '../src/slack/app.js';
import type { PrRef } from '../src/types.js';
import {
  FakeGitHubClient,
  FakeReactionClient,
  testConfig,
  testLogger,
  testStore,
} from './helpers.js';

/**
 * Bolt replaced by a stand-in that keeps the listeners createSlackApp
 * registers, so a test can hand them the events Slack would send.
 */
vi.mock('@slack/bolt', () => ({
  LogLevel: { INFO: 'info' },
  App: class {
    readonly listeners = new Map<string, (args: unknown) => Promise<void>>();
    event(name: string, listener: (args: unknown) => Promise<void>) {
      this.listeners.set(name, listener);
    }
    error() {}
  },
}));

const BOT = 'UBOT';
const PR_URL = 'https://github.com/acme/monolith/pull/42';
const ref: PrRef = { owner: 'acme', repo: 'monolith', number: 42 };

describe('Slack app', () => {
  let store: Store;
  let handle: DbHandle;
  let service: PrService;
  let trackLinks: MockInstance<PrService['trackLinks']>;
  let acks: { channel: string; timestamp: string; name: string }[];
  let listeners: Map<string, (args: unknown) => Promise<void>>;

  const build = (overrides: Partial<Config> = {}) => {
    const config = testConfig(overrides);
    const reconciler = new Reconciler(store, new FakeReactionClient(), config.emoji, testLogger);
    service = new PrService(store, new FakeGitHubClient(), reconciler, config, testLogger);
    trackLinks = vi.spyOn(service, 'trackLinks').mockResolvedValue(undefined);
    const app = createSlackApp({ config, service, store, logger: testLogger }) as unknown as {
      listeners: typeof listeners;
    };
    listeners = app.listeners;
  };

  const client = {
    reactions: {
      add: async (input: { channel: string; timestamp: string; name: string }) => {
        acks.push(input);
      },
    },
  };

  const linkShared = (event: Record<string, unknown>) => listeners.get('link_shared')!({ event });

  const message = (event: Record<string, unknown>, botUserId: string | undefined = BOT) =>
    listeners.get('message')!({ event, context: { botUserId }, client });

  /** A freshly posted message, as Slack sends it. */
  const post = (channel: string, channelType: string | undefined, text: string, ts = '111.1') =>
    message({ type: 'message', channel, channel_type: channelType, ts, text });

  const setup = (channel: string, channelType: string | undefined, text: string) =>
    post(channel, channelType, `<@${BOT}> ${text}`, '999.9');

  const ackNames = () => acks.map((a) => a.name);

  beforeEach(() => {
    ({ store, handle } = testStore());
    acks = [];
    build();
  });

  afterEach(() => handle.close());

  describe('link_shared', () => {
    const shared = (overrides: Record<string, unknown> = {}) => ({
      channel: 'C1',
      message_ts: '111.1',
      links: [{ url: PR_URL, domain: 'github.com' }],
      is_bot_user_member: true,
      ...overrides,
    });

    it('tracks PR links in a channel the bot has been invited to', async () => {
      await linkShared(shared());
      expect(trackLinks).toHaveBeenCalledWith('C1', '111.1', [ref]);
    });

    it('ignores links shared in a channel the bot is not in', async () => {
      await linkShared(shared({ is_bot_user_member: false }));
      await linkShared(shared({ is_bot_user_member: undefined }));
      expect(trackLinks).not.toHaveBeenCalled();
    });

    it('ignores github links that are not pull requests', async () => {
      await linkShared(shared({ links: [{ url: 'https://github.com/acme/monolith/issues/7' }] }));
      expect(trackLinks).not.toHaveBeenCalled();
    });
  });

  describe('channel privacy', () => {
    it('treats private channels and group DMs as private', async () => {
      for (const [channel, type] of [
        ['G1', 'group'],
        ['G2', 'mpim'],
      ] as const) {
        await setup(channel, type, 'team creator-team');
        expect(store.channelTeam(channel), type).toBe('creator-team');
      }
      expect(ackNames()).toEqual(['ok_hand', 'ok_hand']);
    });

    it('records a public channel from any message, switching off a team set while private', async () => {
      store.setChannelTeam('C1', true, 'creator-team');

      await post('C1', 'channel', 'just chatting');

      expect(store.channelTeam('C1')).toBeNull();
    });

    it('leaves the recorded type alone when a message carries none', async () => {
      store.setChannelTeam('G1', true, 'creator-team');

      await post('G1', undefined, 'just chatting');

      expect(store.channelTeam('G1')).toBe('creator-team');
    });
  });

  describe('setup messages', () => {
    it('sets the team in a private channel and acknowledges with a reaction', async () => {
      await setup('G1', 'group', 'team @multimediallc/creator-team');

      expect(store.channelTeam('G1')).toBe('creator-team');
      expect(acks).toEqual([{ channel: 'G1', timestamp: '999.9', name: 'ok_hand' }]);
    });

    it('clears the team', async () => {
      await setup('G1', 'group', 'team creator-team');
      await setup('G1', 'group', 'team none');

      expect(store.channelTeam('G1')).toBeNull();
      expect(ackNames()).toEqual(['ok_hand', 'ok_hand']);
    });

    it('refuses a team in a public channel', async () => {
      await setup('C1', 'channel', 'team creator-team');

      expect(store.channelTeam('C1')).toBeNull();
      expect(ackNames()).toEqual(['no_entry']);
    });

    it('refuses a team when the channel type is unknown, as for a public channel', async () => {
      await setup('G1', undefined, 'team creator-team');

      expect(store.channelTeam('G1')).toBeNull();
      expect(ackNames()).toEqual(['no_entry']);
    });

    it('answers anything else addressed to the bot with a question mark, changing nothing', async () => {
      await setup('G1', 'group', 'team creator-team');
      await setup('G1', 'group', 'what are you set to?');

      expect(store.channelTeam('G1')).toBe('creator-team');
      expect(ackNames()).toEqual(['ok_hand', 'question']);
    });

    it('does not track a PR link inside a setup message', async () => {
      await setup('G1', 'group', `team creator-team ${PR_URL}`);
      expect(trackLinks).not.toHaveBeenCalled();
    });

    it('only acts on a freshly posted message, not an edit or another bot', async () => {
      const text = `<@${BOT}> team creator-team`;

      await message({
        type: 'message',
        subtype: 'message_changed',
        channel: 'G1',
        channel_type: 'group',
        message: { ts: '999.9', text },
      });
      await message({ type: 'message', subtype: 'bot_message', channel: 'G1', channel_type: 'group', ts: '999.9', text });

      expect(store.channelTeam('G1')).toBeNull();
      expect(acks).toEqual([]);
    });

    it('ignores a message that mentions someone else', async () => {
      await post('G1', 'group', '<@USOMEONE> team creator-team');

      expect(store.channelTeam('G1')).toBeNull();
      expect(acks).toEqual([]);
    });

    it('keeps the setting when the acknowledgement fails', async () => {
      client.reactions.add = async () => {
        throw new Error('missing_scope');
      };
      try {
        await setup('G1', 'group', 'team creator-team');
      } finally {
        client.reactions.add = async (input) => {
          acks.push(input);
        };
      }

      expect(store.channelTeam('G1')).toBe('creator-team');
    });
  });

  describe('deleted messages', () => {
    it('stops tracking a message once it is deleted', async () => {
      const pr = store.upsertPr(ref);
      store.linkMessage(pr.id, 'C1', '111.1');

      await message({
        type: 'message',
        subtype: 'message_deleted',
        channel: 'C1',
        channel_type: 'channel',
        previous_message: { ts: '111.1' },
      });

      expect(store.prsForMessage('C1', '111.1')).toEqual([]);
    });
  });

  describe('message scan', () => {
    it('tracks PR links from message text', async () => {
      await post('C1', 'channel', `please review ${PR_URL}`);
      expect(trackLinks).toHaveBeenCalledWith('C1', '111.1', [ref]);
    });

    it('tracks a link added by an edit, against the original message', async () => {
      await message({
        type: 'message',
        subtype: 'message_changed',
        channel: 'C1',
        channel_type: 'channel',
        message: { ts: '111.1', text: `edited: ${PR_URL}` },
      });
      expect(trackLinks).toHaveBeenCalledWith('C1', '111.1', [ref]);
    });

    it('leaves tracking to link_shared when the scan is off, but still records privacy', async () => {
      build({ enableMessageScan: false });
      store.setChannelTeam('C1', true, 'creator-team');

      await post('C1', 'channel', `please review ${PR_URL}`);

      expect(trackLinks).not.toHaveBeenCalled();
      expect(store.channelTeam('C1')).toBeNull();
    });
  });
});
