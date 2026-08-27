import { App, LogLevel, type Logger as BoltLogger } from '@slack/bolt';
import type { Config } from '../config.js';
import type { Store } from '../db/store.js';
import type { Logger } from '../logger.js';
import type { PrService } from '../pr-service.js';
import { parsePrLinks } from './parse-pr-links.js';

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
   * Fallback signal. Slack suppresses link_shared for URLs recently unfurled in
   * the same channel, so scanning message text catches re-posts reliably. Both
   * paths are idempotent upserts so overlap is harmless.
   */
  if (config.enableMessageScan) {
    app.event('message', async ({ event }) => {
      const raw = event as unknown as Record<string, unknown>;
      if (typeof raw.channel !== 'string') return;

      if (raw.subtype === 'message_deleted') {
        const previous = raw.previous_message as Record<string, unknown> | undefined;
        const ts = previous?.ts;
        if (typeof ts === 'string' && typeof raw.channel === 'string') {
          const dropped = store.deleteMessagesByTs(raw.channel, ts);
          if (dropped > 0) {
            logger.info({ channel: raw.channel, messageTs: ts, dropped }, 'message deleted, untracked');
          }
        }
        return;
      }

      const message = extractMessage(raw);
      if (!message) return;

      const refs = parsePrLinks(message.text);
      logger.debug(
        { channel: raw.channel, messageTs: message.ts, prCount: refs.length },
        'message received',
      );
      if (refs.length === 0) return;
      await service.trackLinks(raw.channel as string, message.ts, refs, message.text);
    });
  }

  app.error(async (error) => {
    logger.error({ err: error }, 'bolt listener error');
  });

  return app;
}
