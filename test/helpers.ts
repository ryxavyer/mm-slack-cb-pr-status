import pino from 'pino';
import type { Config } from '../src/config.js';
import { openDatabase, type DbHandle } from '../src/db/client.js';
import { Store } from '../src/db/store.js';
import type { GitHubClient, PrStatus } from '../src/github/client.js';
import type { ReactionClient } from '../src/slack/reactions.js';
import type { CodeownerStatus, PrRef } from '../src/types.js';

/** Silent logger — tests assert on behaviour, not on log output. */
export const testLogger = pino({ level: 'silent' });

export function testStore(): { store: Store; handle: DbHandle } {
  const handle = openDatabase(':memory:');
  return { store: new Store(handle.db), handle };
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    slack: { botToken: 'xoxb-test', appToken: 'xapp-test' },
    github: { token: 'ghp-test', baseUrl: 'https://api.github.com' },
    watchedChannels: new Set(['C_WATCHED']),
    watchedRepos: new Set<string>(),
    requiredApprovals: 2,
    pollIntervalMs: 90_000,
    cleanupTtlMs: 7 * 24 * 60 * 60 * 1000,
    unreachableTtlMs: 7 * 24 * 60 * 60 * 1000,
    emoji: {
      changesRequested: 'request-changes',
      partial: '1of2',
      approved: 'white_check_mark',
      merged: 'merged',
      closed: 'x',
      unknown: 'sleeping',
    },
    databasePath: ':memory:',
    logLevel: 'silent',
    enableMessageScan: true,
    teamMap: null,
    ...overrides,
  };
}

/** Builds an error shaped like a Slack Web API platform error. */
export function slackError(code: string): Error & { data: { error: string } } {
  const error = new Error(`An API error occurred: ${code}`) as Error & { data: { error: string } };
  error.data = { ok: false, error: code } as { error: string };
  return error;
}

export interface RecordedCall {
  op: 'add' | 'remove';
  channel: string;
  timestamp: string;
  name: string;
}

/**
 * A ReactionClient that records every call and can be told to fail specific
 * (op, emoji) pairs with a given Slack error code.
 */
export class FakeReactionClient implements ReactionClient {
  readonly calls: RecordedCall[] = [];
  private failures = new Map<string, string>();

  failWith(op: 'add' | 'remove', name: string, code: string): void {
    this.failures.set(`${op}:${name}`, code);
  }

  failAll(op: 'add' | 'remove', code: string): void {
    this.failures.set(`${op}:*`, code);
  }

  clearFailures(): void {
    this.failures.clear();
  }

  async add(input: { channel: string; timestamp: string; name: string }): Promise<void> {
    this.record('add', input);
  }

  async remove(input: { channel: string; timestamp: string; name: string }): Promise<void> {
    this.record('remove', input);
  }

  private record(op: 'add' | 'remove', input: { channel: string; timestamp: string; name: string }) {
    this.calls.push({ op, ...input });
    const code = this.failures.get(`${op}:${input.name}`) ?? this.failures.get(`${op}:*`);
    if (code) throw slackError(code);
  }
}

/** A GitHubClient backed by an in-memory map of PR statuses. */
export class FakeGitHubClient implements GitHubClient {
  readonly requests: string[] = [];
  private statuses = new Map<string, PrStatus>();
  private errors = new Map<string, Error>();
  private codeownerStatuses = new Map<string, CodeownerStatus | null>();

  private static key(ref: PrRef): string {
    return `${ref.owner}/${ref.repo}#${ref.number}`;
  }

  set(ref: PrRef, status: Partial<PrStatus>): void {
    this.statuses.set(FakeGitHubClient.key(ref), {
      merged: false,
      closed: false,
      draft: false,
      approvals: 0,
      changesRequested: 0,
      title: 'test pr',
      ...status,
    });
  }

  setCodeownerStatus(ref: PrRef, status: CodeownerStatus | null): void {
    this.codeownerStatuses.set(FakeGitHubClient.key(ref), status);
  }

  fail(ref: PrRef, error: Error): void {
    this.errors.set(FakeGitHubClient.key(ref), error);
  }

  clearFailure(ref: PrRef): void {
    this.errors.delete(FakeGitHubClient.key(ref));
  }

  async fetchPrStatus(ref: PrRef): Promise<PrStatus> {
    const key = FakeGitHubClient.key(ref);
    this.requests.push(key);
    const error = this.errors.get(key);
    if (error) throw error;
    const status = this.statuses.get(key);
    if (!status) throw new Error(`no fake status registered for ${key}`);
    return status;
  }

  async fetchCodeownerStatus(ref: PrRef, _botLogin: string): Promise<CodeownerStatus | null> {
    return this.codeownerStatuses.get(FakeGitHubClient.key(ref)) ?? null;
  }
}
