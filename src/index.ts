import { WebClient } from '@slack/web-api';
import { loadConfig } from './config.js';
import { openDatabase } from './db/client.js';
import { Store } from './db/store.js';
import { OctokitGitHubClient } from './github/client.js';
import { logger } from './logger.js';
import { Poller } from './poller.js';
import { PrService } from './pr-service.js';
import { Reconciler } from './reconciler.js';
import { createSlackApp } from './slack/app.js';
import { WebApiReactionClient } from './slack/reactions.js';
import { managedEmojis } from './state.js';

async function main(): Promise<void> {
  const config = loadConfig();
  logger.level = config.logLevel;

  const { db, close: closeDb } = openDatabase(config.databasePath);
  const store = new Store(db);

  const github = new OctokitGitHubClient({
    token: config.github.token,
    baseUrl: config.github.baseUrl,
  });

  const webClient = new WebClient(config.slack.botToken);
  const reconciler = new Reconciler(
    store,
    new WebApiReactionClient(webClient),
    config.emoji,
    logger,
  );
  const service = new PrService(store, github, reconciler, config, logger);
  const poller = new Poller(service, config.pollIntervalMs, logger);
  const slackApp = createSlackApp({ config, service, store, logger });

  logger.info(
    {
      watchedRepos: config.watchedRepos.size > 0 ? [...config.watchedRepos] : 'any',
      requiredApprovals: config.requiredApprovals,
      pollIntervalSeconds: config.pollIntervalMs / 1000,
      managedEmojis: managedEmojis(config.emoji),
      messageScan: config.enableMessageScan,
      databasePath: config.databasePath,
      counts: store.counts(),
    },
    'starting mm-slack-cb-pr-status',
  );

  await slackApp.start();
  logger.info('socket mode connection established');
  poller.start();

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    // Order matters: stop accepting new events, drain the poll cycle already in
    // flight so no reaction transition is left half-applied, then close SQLite.
    try {
      await slackApp.stop();
      await poller.stop();
      closeDb();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', (s) => void shutdown(s));
  process.on('SIGINT', (s) => void shutdown(s));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });
  // Bolt's socket client can throw from its own async callbacks, outside any
  // promise we hold. Log it as JSON like everything else, then let the
  // supervisor restart us rather than limping on in an unknown state.
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    process.exit(1);
  });
}

main().catch((error) => {
  logger.fatal({ err: error }, 'fatal startup error');
  process.exit(1);
});
