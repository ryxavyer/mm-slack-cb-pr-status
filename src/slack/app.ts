import { App, LogLevel, type Logger as BoltLogger } from '@slack/bolt';
import type { Config } from '../config.js';
import type { Store } from '../db/store.js';
import type { Logger } from '../logger.js';
import type { PrService } from '../pr-service.js';
import { parsePrLinks } from './parse-pr-links.js';
import { parseSetupCommand } from './parse-setup-command.js';

export interface SlackAppDeps {
  config: Config;
  service: PrService;
  store: Store;
  logger: Logger;
}

/** Bridges Bolt's logger interface onto pino so everything lands in one stream. */
function boltLogger(logger: Logger, level: LogLevel): BoltLogger {
  const child = logger.child({ component: 'bolt' });
  const join = (msgs: unknown[]) => msgs.map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join(' ');
  let currentLevel = level;
  return {
    debug: (...msgs) => child.debug(join(msgs)),
    info: (...msgs) => child.info(join(msgs)),
    warn: (...msgs) => child.warn(join(msgs)),
    error: (...msgs) => child.error(join(msgs)),
    setLevel: (l) => {
      currentLevel = l;
    },
    getLevel: () => currentLevel,
    setName: () => undefined,
  };
}

/** Text and identity of a message event, across the subtypes we care about. */
function extractMessage(event: Record<string, unknown>): { ts: string; text: string } | null {
  const subtype = typeof event.subtype === 'string' ? event.subtype : undefined;

  if (subtype === undefined || subtype === 'bot_message' || subtype === 'thread_broadcast') {
    const ts = event.ts;
    if (typeof ts !== 'string') return null;
    return { ts, text: typeof event.text === 'string' ? event.text : '' };
  }

  // An edit that adds a PR link should start tracking it.
  if (subtype === 'message_changed') {
    const inner = event.message as Record<string, unknown> | undefined;
    const ts = inner?.ts;
    if (typeof ts !== 'string') return null;
    return { ts, text: typeof inner?.text === 'string' ? inner.text : '' };
  }

  return null;
}

/** Reactions the bot uses to answer a setup message. Never on PR messages. */
const SETUP_REPLY = { saved: 'ok_hand', invalid: 'question' } as const;

/**
 * The Slack side of the bot: a Socket Mode connection (no inbound HTTP, no public
 * URL, no request signing) that turns GitHub PR links into tracked PRs.
 */
export function createSlackApp({ config, service, store, logger }: SlackAppDeps): App {
  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
    logger: boltLogger(logger, LogLevel.INFO),
  });

  /**
   * Primary signal. `is_bot_user_member` gates it to channels the bot has been
   * invited to — without it, Slack fires link_shared for any public channel in
   * the workspace where github.com links appear, even if the bot isn't there.
   */
  app.event('link_shared', async ({ event }) => {
    if (!event.is_bot_user_member) return;
    if (typeof event.channel !== 'string') return;
    const messageTs = event.message_ts;
    if (typeof messageTs !== 'string') return;

    const urls = (event.links ?? []).map((link) => link.url ?? '').join('\n');
    const refs = parsePrLinks(urls);
    logger.debug(
      { channel: event.channel, messageTs, links: urls, prCount: refs.length },
      'link_shared received',
    );
    if (refs.length === 0) return;
    await service.trackLinks(event.channel, messageTs, refs);
  });

  /**
   * Every message in a channel the bot is in. Three jobs:
   * - Untrack a deleted message.
   * - Handle a channel setup message ("@CB PR Status team creator-team").
   * - When ENABLE_MESSAGE_SCAN is on, track PR links in the text. Slack
   *   suppresses link_shared for URLs recently unfurled in the same channel, so
   *   scanning text catches re-posts. Both paths are idempotent upserts, so
   *   overlap with link_shared is harmless.
   */
  app.event('message', async ({ event, context, client }) => {
    const raw = event as unknown as Record<string, unknown>;
    const channel = raw.channel;
    if (typeof channel !== 'string') return;

    if (raw.subtype === 'message_deleted') {
      const previous = raw.previous_message as Record<string, unknown> | undefined;
      const ts = previous?.ts;
      if (typeof ts === 'string') {
        const dropped = store.deleteMessagesByTs(channel, ts);
        if (dropped > 0) {
          logger.info({ channel, messageTs: ts, dropped }, 'message deleted, untracked');
        }
      }
      return;
    }

    const message = extractMessage(raw);
    if (!message) return;

    // Only a freshly posted message counts as setup; an edit or another bot
    // repeating the words does not.
    const command =
      raw.subtype === undefined && context.botUserId
        ? parseSetupCommand(message.text, context.botUserId)
        : null;
    if (command) {
      let outcome: keyof typeof SETUP_REPLY = 'invalid';
      if (command.kind === 'set_teams') {
        await service.setChannelTeams(channel, command.teams);
        outcome = 'saved';
      }
      logger.info({ channel, messageTs: message.ts, command, outcome }, 'setup message handled');
      try {
        await client.reactions.add({ channel, timestamp: message.ts, name: SETUP_REPLY[outcome] });
      } catch (error) {
        logger.warn({ err: error, channel }, 'could not react to setup message');
      }
      return;
    }

    const refs = parsePrLinks(message.text);
    logger.debug({ channel, messageTs: message.ts, prCount: refs.length }, 'message received');
    if (refs.length === 0) return;

    if (config.enableMessageScan) await service.trackLinks(channel, message.ts, refs);
  });

  app.error(async (error) => {
    logger.error({ err: error }, 'bolt listener error');
  });

  return app;
}
