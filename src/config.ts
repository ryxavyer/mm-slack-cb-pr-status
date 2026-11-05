import { z } from 'zod';

/**
 * All configuration comes from env vars — strict 12-factor, no host-specific
 * metadata, no SDK calls. See .env.example for the documented set.
 */

/** Slack emoji names are stored without colons; empty string disables the state. */
const emojiName = z
  .string()
  .transform((s) => s.trim().replace(/^:+|:+$/g, ''))
  .refine((s) => s === '' || /^[a-z0-9_+'-]+$/i.test(s), {
    message: 'must be a bare Slack emoji name (no colons), or empty to disable',
  });

const boolish = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .refine((s) => ['true', 'false', '1', '0', 'yes', 'no'].includes(s), {
    message: 'must be a boolean (true/false)',
  })
  .transform((s) => s === 'true' || s === '1' || s === 'yes');

/**
 * Optional `owner/repo` allowlist. Lower-cased to match the parser, which
 * normalises links the same way (GitHub treats both case-insensitively).
 */
const repoList = z
  .string()
  .transform((s) =>
    s
      .split(',')
      .map((r) => r.trim().toLowerCase())
      .filter((r) => r.length > 0),
  )
  .refine((list) => list.every((r) => /^[a-z0-9._-]+\/[a-z0-9._-]+$/.test(r)), {
    message: 'entries must be owner/repo (e.g. acme/monolith), comma separated',
  });

const envSchema = z.object({
  SLACK_BOT_TOKEN: z.string().min(1, 'required (xoxb-… bot token)'),
  SLACK_APP_TOKEN: z.string().min(1, 'required (xapp-… app-level token)'),
  GITHUB_TOKEN: z.string().min(1, 'required (read-only Pull Requests PAT)'),
  /** Empty means "any repo the GitHub token can see". */
  WATCHED_REPOS: repoList.default(''),
  /** GitHub login of the codeowner bot whose PR comment decides approval. */
  CODEOWNER_BOT_LOGIN: z.string().trim().min(1).default('mmllc-gh'),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().min(10).default(90),
  CLEANUP_TTL_DAYS: z.coerce.number().int().min(1).default(7),
  /** How long to keep showing "unknown" before giving up on a PR entirely. */
  UNREACHABLE_TTL_DAYS: z.coerce.number().int().min(1).default(7),
  EMOJI_CHANGES_REQUESTED: emojiName.default('request-changes'),
  EMOJI_NO_REVIEWS: emojiName.default('please'),
  EMOJI_PARTIAL: emojiName.default('1of2'),
  EMOJI_TEAM_DONE: emojiName.default('blue_check_mark'),
  EMOJI_APPROVED: emojiName.default('white_check_mark'),
  EMOJI_MERGED: emojiName.default('merged'),
  EMOJI_CLOSED: emojiName.default('x'),
  EMOJI_UNKNOWN: emojiName.default('sleeping'),
  DATABASE_PATH: z.string().min(1).default('/data/bot.sqlite'),
  GITHUB_API_BASE_URL: z.string().url().default('https://api.github.com'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  /**
   * Fallback link discovery. `link_shared` is the primary signal, but Slack
   * suppresses it for repeated URLs and for messages posted by other apps, so we
   * also scan plain message text by default. Both paths are idempotent upserts.
   */
  ENABLE_MESSAGE_SCAN: boolish.default('true'),
});

export type EmojiConfig = {
  changesRequested: string | null;
  noReviews: string | null;
  partial: string | null;
  teamDone: string | null;
  approved: string | null;
  merged: string | null;
  closed: string | null;
  unknown: string | null;
};

export interface Config {
  slack: { botToken: string; appToken: string };
  github: { token: string; baseUrl: string };
  /** Empty set means every repo is allowed. */
  watchedRepos: Set<string>;
  codeownerBotLogin: string;
  pollIntervalMs: number;
  cleanupTtlMs: number;
  unreachableTtlMs: number;
  emoji: EmojiConfig;
  databasePath: string;
  logLevel: string;
  enableMessageScan: boolean;
}

const orNull = (s: string): string | null => (s === '' ? null : s);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${details}`);
  }
  const e = parsed.data;
  return {
    slack: { botToken: e.SLACK_BOT_TOKEN, appToken: e.SLACK_APP_TOKEN },
    github: { token: e.GITHUB_TOKEN, baseUrl: e.GITHUB_API_BASE_URL },
    watchedRepos: new Set(e.WATCHED_REPOS),
    codeownerBotLogin: e.CODEOWNER_BOT_LOGIN,
    pollIntervalMs: e.POLL_INTERVAL_SECONDS * 1000,
    cleanupTtlMs: e.CLEANUP_TTL_DAYS * 24 * 60 * 60 * 1000,
    unreachableTtlMs: e.UNREACHABLE_TTL_DAYS * 24 * 60 * 60 * 1000,
    emoji: {
      changesRequested: orNull(e.EMOJI_CHANGES_REQUESTED),
      noReviews: orNull(e.EMOJI_NO_REVIEWS),
      partial: orNull(e.EMOJI_PARTIAL),
      teamDone: orNull(e.EMOJI_TEAM_DONE),
      approved: orNull(e.EMOJI_APPROVED),
      merged: orNull(e.EMOJI_MERGED),
      closed: orNull(e.EMOJI_CLOSED),
      unknown: orNull(e.EMOJI_UNKNOWN),
    },
    databasePath: e.DATABASE_PATH,
    logLevel: e.LOG_LEVEL,
    enableMessageScan: e.ENABLE_MESSAGE_SCAN,
  };
}
