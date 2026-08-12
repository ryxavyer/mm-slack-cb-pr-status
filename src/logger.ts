import pino from 'pino';

/**
 * Structured JSON to stdout only — no file transports, no host-specific sinks.
 * Whatever collects stdout (Railway, CloudWatch, journald, Loki) works unchanged.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'mm-slack-cb-pr-status' },
  redact: {
    paths: ['token', '*.token', 'botToken', 'appToken', 'headers.authorization'],
    censor: '[redacted]',
  },
});

export type Logger = pino.Logger;
