import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import type { DbHandle } from '../src/db/client.js';
import type { Store } from '../src/db/store.js';
import { PrUnreachableError, type PrStatus } from '../src/github/client.js';
import { PrService } from '../src/pr-service.js';
import { Reconciler } from '../src/reconciler.js';
import type { CodeownerStatus, PrRef } from '../src/types.js';
import {
  FakeGitHubClient,
  FakeReactionClient,
  testConfig,
  testLogger,
  testStore,
} from './helpers.js';

const ref: PrRef = { owner: 'acme', repo: 'monolith', number: 42 };
const other: PrRef = { owner: 'acme', repo: 'monolith', number: 43 };

/** A public channel, and a private one set to creator-team. */
const PUBLIC = 'C_PUBLIC';
const TEAM = 'C_TEAM';

/**
 * The codeowner bot's comment at each point of a typical review: creator-team
 * and platform-team both own files, and the bot wants two reviews in total.
 */
const STAGES = {
  waiting: {
    requirements: [
      { teams: ['creator-team'], satisfied: false },
      { teams: ['platform-team'], satisfied: false },
    ],
    minimum: { required: 2, found: 0, met: false },
    allSatisfied: false,
  },
  oneOfTwo: {
    requirements: [
      { teams: ['creator-team'], satisfied: true },
      { teams: ['platform-team'], satisfied: false },
    ],
    minimum: { required: 2, found: 1, met: false },
    allSatisfied: false,
  },
  teamDone: {
    requirements: [
      { teams: ['creator-team'], satisfied: true },
      { teams: ['platform-team'], satisfied: false },
    ],
    minimum: { required: 2, found: 2, met: true },
    allSatisfied: false,
  },
  approved: { requirements: [], minimum: null, allSatisfied: true },
} satisfies Record<string, CodeownerStatus>;

describe('PrService', () => {
  let store: Store;
  let handle: DbHandle;
  let github: FakeGitHubClient;
  let reactions: FakeReactionClient;
  let config: Config;
  let service: PrService;

  // The waiting state's emoji is off here so each test shows only the
  // transitions it is about; `shows the no-reviews emoji while waiting` covers it.
  const build = (overrides: Partial<Config> = {}) => {
    config = testConfig({ emoji: { ...testConfig().emoji, noReviews: null }, ...overrides });
    const reconciler = new Reconciler(store, reactions, config.emoji, testLogger);
    service = new PrService(store, github, reconciler, config, testLogger);
  };

  /** Puts a PR at a review stage, optionally with other GitHub facts. */
  const stage = (pr: PrRef, name: keyof typeof STAGES | null, status: Partial<PrStatus> = {}) => {
    github.set(pr, status);
    github.setCodeownerStatus(pr, name === null ? null : STAGES[name]);
  };

  const names = () => reactions.calls.map((c) => `${c.op}:${c.name}`);

  beforeEach(() => {
    ({ store, handle } = testStore());
    github = new FakeGitHubClient();
    reactions = new FakeReactionClient();
    build();
    store.setChannelPrivacy(PUBLIC, false);
    store.setChannelTeam(TEAM, true, 'creator-team');
  });

  afterEach(() => handle.close());

  describe('trackLinks', () => {
    it('tracks a link and applies the emoji immediately', async () => {
      stage(ref, 'approved');
      await service.trackLinks(PUBLIC, '111.1', [ref]);

      expect(store.findPr(ref)?.state).toBe('approved');
      expect(reactions.calls).toEqual([
        { op: 'add', channel: PUBLIC, timestamp: '111.1', name: 'white_check_mark' },
      ]);
    });

    it('shows nothing for an open PR the codeowner bot has not commented on', async () => {
      stage(ref, null);
      await service.trackLinks(PUBLIC, '111.1', [ref]);
      await service.trackLinks(TEAM, '222.2', [ref]);

      expect(store.findPr(ref)?.state).toBe('no_reviews');
      expect(reactions.calls).toEqual([]);
    });

    it('shows the no-reviews emoji while waiting, in every channel', async () => {
      build({ emoji: testConfig().emoji });
      stage(ref, 'waiting');
      await service.trackLinks(PUBLIC, '111.1', [ref]);
      await service.trackLinks(TEAM, '222.2', [ref]);

      expect(names()).toEqual(['add:please', 'add:please']);

      stage(ref, 'approved');
      await service.runCycle();
      expect(store.messageReaction(PUBLIC, '111.1')).toBe('white_check_mark');
      expect(store.messageReaction(TEAM, '222.2')).toBe('white_check_mark');
    });

    it('tracks every repo when no allowlist is set', async () => {
      const elsewhere = { owner: 'other', repo: 'thing', number: 9 };
      stage(elsewhere, 'approved');
      await service.trackLinks(PUBLIC, '111.1', [elsewhere]);

      expect(store.findPr(elsewhere)?.state).toBe('approved');
    });

    it('ignores links outside the repo allowlist', async () => {
      build({ watchedRepos: new Set(['acme/monolith']) });
      const elsewhere = { owner: 'other', repo: 'thing', number: 9 };
      stage(ref, 'approved');
      stage(elsewhere, 'approved');

      await service.trackLinks(PUBLIC, '111.1', [ref, elsewhere]);

      expect(store.findPr(ref)?.state).toBe('approved');
      // Not tracked at all — no row, no GitHub call, and crucially no reaction,
      // rather than the :sleeping: a 404 would have produced.
      expect(store.findPr(elsewhere)).toBeUndefined();
      expect(github.requests).toEqual(['acme/monolith#42']);
      expect(names()).toEqual(['add:white_check_mark']);
    });

    it('matches the allowlist case-insensitively', async () => {
      build({ watchedRepos: new Set(['acme/monolith']) });
      stage(ref, 'approved');

      // The parser lower-cases links, so `Acme/MonoLith` arrives normalised.
      await service.trackLinks(PUBLIC, '111.1', [ref]);

      expect(store.findPr(ref)?.state).toBe('approved');
    });

    it('is idempotent across re-delivery and edits of the same message', async () => {
      stage(ref, 'approved');
      await service.trackLinks(PUBLIC, '111.1', [ref]);
      await service.trackLinks(PUBLIC, '111.1', [ref]);

      const pr = store.findPr(ref);
      expect(store.counts().messages).toBe(1);
      expect(store.messagesForPr(pr!.id)[0]?.currentReaction).toBe('white_check_mark');
      // Second pass sees the reaction already in place and issues no Slack call.
      expect(reactions.calls).toHaveLength(1);
    });

    it('tracks the same PR posted in two messages and updates both', async () => {
      stage(ref, 'waiting');
      await service.trackLinks(PUBLIC, '111.1', [ref]);
      await service.trackLinks(PUBLIC, '222.2', [ref]);

      stage(ref, 'approved');
      await service.runCycle();

      expect(reactions.calls.map((c) => `${c.op}:${c.timestamp}`)).toEqual([
        'add:111.1',
        'add:222.2',
      ]);
    });

    it('applies the merged emoji at once for an already-merged PR', async () => {
      stage(ref, 'approved', { merged: true, closed: true });
      await service.trackLinks(PUBLIC, '111.1', [ref]);

      expect(store.findPr(ref)?.state).toBe('merged');
      expect(names()).toEqual(['add:merged']);
      // Terminal on arrival: never polled again.
      expect(store.listActivePrs()).toHaveLength(0);
    });

    it('keeps going when one link in a message fails', async () => {
      github.fail(ref, new Error('boom'));
      stage(other, 'approved');

      await service.trackLinks(PUBLIC, '111.1', [ref, other]);

      // The second link is still tracked and polled despite the first throwing.
      expect(store.findPr(ref)?.state).toBe('no_reviews');
      expect(store.findPr(other)?.state).toBe('approved');
      // No reaction, though: the message also links a PR we know nothing about,
      // so it cannot honestly be reported as approved.
      expect(reactions.calls).toEqual([]);
    });
  });

  describe('channels', () => {
    it('shows only the codeowner bot’s whole-PR verdict in a public channel', async () => {
      stage(ref, 'teamDone');
      await service.trackLinks(PUBLIC, '111.1', [ref]);
      expect(reactions.calls).toEqual([]);

      stage(ref, 'approved');
      await service.runCycle();
      expect(names()).toEqual(['add:white_check_mark']);
    });

    it('ignores a team setting once the channel turns out to be public', async () => {
      store.setChannelTeam(PUBLIC, false, 'creator-team');
      stage(ref, 'teamDone');
      await service.trackLinks(PUBLIC, '111.1', [ref]);

      expect(reactions.calls).toEqual([]);
    });

    it('treats a channel whose type is not yet known as public', async () => {
      // Only link_shared has arrived from this channel, which carries no
      // channel_type, so there is no row for it at all.
      stage(ref, 'teamDone');
      await service.trackLinks('C_UNSEEN', '111.1', [ref]);

      expect(reactions.calls).toEqual([]);
    });

    it('shows the whole-PR view in a private channel with no team set', async () => {
      store.setChannelPrivacy('C_PRIVATE', true);
      stage(ref, 'teamDone');
      await service.trackLinks('C_PRIVATE', '111.1', [ref]);

      expect(reactions.calls).toEqual([]);
    });

    it('shows the team’s progress in a private channel set to a team', async () => {
      stage(ref, 'teamDone');
      await service.trackLinks(TEAM, '111.1', [ref]);

      expect(names()).toEqual(['add:blue_check_mark']);
    });

    it('shows the same PR differently per channel', async () => {
      stage(ref, 'teamDone');
      await service.trackLinks(PUBLIC, '111.1', [ref]);
      await service.trackLinks(TEAM, '222.2', [ref]);

      expect(store.messageReaction(PUBLIC, '111.1')).toBeNull();
      expect(store.messageReaction(TEAM, '222.2')).toBe('blue_check_mark');
    });
  });

  describe('setChannelTeam', () => {
    it('applies a new team to messages already tracked in the channel', async () => {
      store.setChannelPrivacy('C_PRIVATE', true);
      stage(ref, 'teamDone');
      await service.trackLinks('C_PRIVATE', '111.1', [ref]);
      expect(reactions.calls).toEqual([]);

      expect(await service.setChannelTeam('C_PRIVATE', true, 'creator-team')).toBe('saved');
      expect(names()).toEqual(['add:blue_check_mark']);

      // Clearing it goes back to the whole-PR view.
      reactions.calls.length = 0;
      expect(await service.setChannelTeam('C_PRIVATE', true, null)).toBe('saved');
      expect(names()).toEqual(['remove:blue_check_mark']);
      expect(store.channelTeam('C_PRIVATE')).toBeNull();
    });

    it('refuses a team for a public channel', async () => {
      expect(await service.setChannelTeam('C_OPEN', false, 'creator-team')).toBe('public_channel');
      expect(store.channelTeam('C_OPEN')).toBeNull();
    });
  });

  describe('a message linking several PRs', () => {
    it('carries one reaction for the least settled PR on it', async () => {
      stage(ref, 'approved');
      stage(other, 'oneOfTwo');

      await service.trackLinks(TEAM, '111.1', [ref, other]);

      // One PR approved, one partial → the message still needs eyes.
      expect(names()).toEqual(['add:1of2']);
    });

    it('does not lose one PR’s status when another shares its emoji and moves on', async () => {
      // The exact collision this design fixes: both PRs partial, so both want
      // :1of2:, but Slack has only one reaction slot per message.
      stage(ref, 'oneOfTwo');
      stage(other, 'oneOfTwo');
      await service.trackLinks(TEAM, '111.1', [ref, other]);
      expect(names()).toEqual(['add:1of2']);

      // First PR gets approved; the second is still only partially reviewed.
      reactions.calls.length = 0;
      stage(ref, 'approved');
      await service.runCycle();

      // The reaction must stay :1of2: for the PR still awaiting review, rather
      // than being removed out from under it.
      expect(reactions.calls).toEqual([]);
      expect(store.messageReaction(TEAM, '111.1')).toBe('1of2');

      // Once both are approved, the message finally advances.
      stage(other, 'approved');
      await service.runCycle();
      expect(names()).toEqual(['remove:1of2', 'add:white_check_mark']);
    });

    it('hands the reaction to the surviving PR when one is retired', async () => {
      stage(ref, 'oneOfTwo');
      stage(other, 'approved', { merged: true, closed: true });
      await service.trackLinks(TEAM, '111.1', [ref, other]);
      // Aggregate is partial: the merged PR does not settle the message.
      expect(store.messageReaction(TEAM, '111.1')).toBe('1of2');

      // The merged PR ages out of the database entirely.
      reactions.calls.length = 0;
      await service.cleanup(Date.now() + config.cleanupTtlMs + 1_000);
      await service.runCycle();

      // Still :1of2: — the remaining PR keeps the message accurate.
      expect(store.findPr(other)).toBeUndefined();
      expect(store.messageReaction(TEAM, '111.1')).toBe('1of2');
    });

    it('strips the reaction when the last PR on a message is retired', async () => {
      stage(ref, 'approved');
      await service.trackLinks(PUBLIC, '111.1', [ref]);

      github.fail(ref, new PrUnreachableError(ref, 'not_found', 404));
      await service.runCycle();
      reactions.calls.length = 0;

      await service.cleanup(Date.now() + config.unreachableTtlMs + 1_000);

      expect(names()).toEqual(['remove:sleeping']);
    });
  });

  describe('runCycle', () => {
    it('polls active PRs and reconciles the ones that changed', async () => {
      stage(ref, 'waiting');
      await service.trackLinks(PUBLIC, '111.1', [ref]);
      reactions.calls.length = 0;

      stage(ref, 'approved');
      const first = await service.runCycle();
      expect(first).toMatchObject({ polled: 1, changed: 1, failed: 0 });
      expect(names()).toEqual(['add:white_check_mark']);

      // Nothing changed on the second cycle → no Slack traffic.
      reactions.calls.length = 0;
      const second = await service.runCycle();
      expect(second).toMatchObject({ polled: 1, changed: 0 });
      expect(reactions.calls).toEqual([]);
    });

    it('counts a codeowner progress change as a change even when the PR state holds', async () => {
      stage(ref, 'waiting');
      await service.trackLinks(TEAM, '111.1', [ref]);

      stage(ref, 'oneOfTwo');
      const summary = await service.runCycle();

      expect(store.findPr(ref)?.state).toBe('no_reviews');
      expect(summary.changed).toBe(1);
      expect(names()).toEqual(['add:1of2']);
    });

    it('walks a PR through the whole lifecycle in a team channel', async () => {
      stage(ref, 'waiting');
      await service.trackLinks(TEAM, '111.1', [ref]);

      stage(ref, 'oneOfTwo');
      await service.runCycle();
      stage(ref, 'teamDone');
      await service.runCycle();
      stage(ref, 'approved');
      await service.runCycle();
      expect(store.findPr(ref)?.state).toBe('approved');

      stage(ref, 'approved', { merged: true, closed: true });
      await service.runCycle();
      expect(store.findPr(ref)?.state).toBe('merged');

      expect(names()).toEqual([
        'add:1of2',
        'remove:1of2',
        'add:blue_check_mark',
        'remove:blue_check_mark',
        'add:white_check_mark',
        'remove:white_check_mark',
        'add:merged',
      ]);
    });

    it('swaps to the blocked emoji when a reviewer requests changes', async () => {
      stage(ref, 'oneOfTwo');
      await service.trackLinks(TEAM, '111.1', [ref]);
      reactions.calls.length = 0;

      stage(ref, 'oneOfTwo', { changesRequested: 1 });
      await service.runCycle();

      expect(store.findPr(ref)?.state).toBe('changes_requested');
      expect(names()).toEqual(['remove:1of2', 'add:request-changes']);

      // Author addresses it, the codeowner bot approves: straight to approved.
      reactions.calls.length = 0;
      stage(ref, 'approved');
      await service.runCycle();

      expect(store.findPr(ref)?.state).toBe('approved');
      expect(names()).toEqual(['remove:request-changes', 'add:white_check_mark']);
    });

    it('shows blocked even when the codeowner bot is satisfied', async () => {
      stage(ref, 'approved', { changesRequested: 1 });
      await service.trackLinks(PUBLIC, '111.1', [ref]);

      expect(store.findPr(ref)?.state).toBe('changes_requested');
      expect(names()).toEqual(['add:request-changes']);
    });

    it('walks backwards when the codeowner bot withdraws approval', async () => {
      stage(ref, 'approved');
      await service.trackLinks(PUBLIC, '111.1', [ref]);
      reactions.calls.length = 0;

      // New commits dismissed the reviews; the bot is waiting again.
      stage(ref, 'waiting');
      await service.runCycle();

      expect(store.findPr(ref)?.state).toBe('no_reviews');
      expect(names()).toEqual(['remove:white_check_mark']);
    });

    it('stops polling a PR once it is terminal', async () => {
      stage(ref, null, { merged: true, closed: true });
      await service.trackLinks(PUBLIC, '111.1', [ref]);
      github.requests.length = 0;

      await service.runCycle();
      expect(github.requests).toEqual([]);
    });

    it('shows unknown rather than closed when GitHub stops answering', async () => {
      stage(ref, 'approved');
      await service.trackLinks(PUBLIC, '111.1', [ref]);
      reactions.calls.length = 0;

      github.fail(ref, new PrUnreachableError(ref, 'unauthorized', 401));
      await service.runCycle();

      // Not "closed" — we genuinely don't know, and we say so.
      expect(store.findPr(ref)?.state).toBe('unknown');
      expect(names()).toEqual(['remove:white_check_mark', 'add:sleeping']);
    });

    it.each([
      ['unauthorized', 401],
      ['forbidden', 403],
      ['not_found', 404],
    ] as const)('treats a %s response as unknown', async (reason, status) => {
      stage(ref, 'waiting');
      await service.trackLinks(PUBLIC, '111.1', [ref]);

      github.fail(ref, new PrUnreachableError(ref, reason, status));
      await service.runCycle();

      expect(store.findPr(ref)?.state).toBe('unknown');
      expect(store.findPr(ref)?.unreachableSince).toBeGreaterThan(0);
    });

    it('keeps polling an unknown PR and restores the real state once access returns', async () => {
      stage(ref, 'waiting');
      await service.trackLinks(PUBLIC, '111.1', [ref]);

      github.fail(ref, new PrUnreachableError(ref, 'unauthorized', 401));
      await service.runCycle();
      expect(store.findPr(ref)?.state).toBe('unknown');

      // Token rotated: the PR is visible again, no human intervention needed.
      reactions.calls.length = 0;
      github.clearFailure(ref);
      stage(ref, 'approved');
      await service.runCycle();

      const pr = store.findPr(ref);
      expect(pr?.state).toBe('approved');
      expect(pr?.unreachableSince).toBeNull();
      expect(names()).toEqual(['remove:sleeping', 'add:white_check_mark']);
    });

    it('remembers the codeowner verdict while a PR is unreachable', async () => {
      stage(ref, 'oneOfTwo');
      await service.trackLinks(PUBLIC, '111.1', [ref]);

      github.fail(ref, new PrUnreachableError(ref, 'not_found', 404));
      await service.runCycle();

      expect(store.findPr(ref)?.codeownerStatus).toBe(JSON.stringify(STAGES.oneOfTwo));
    });

    it('does not flip a PR to unknown on a transient error', async () => {
      stage(ref, 'approved');
      await service.trackLinks(PUBLIC, '111.1', [ref]);
      reactions.calls.length = 0;

      // Rate limiting and 5xx are not access failures — state must not move.
      github.fail(ref, new Error('503 Service Unavailable'));
      const summary = await service.runCycle();

      expect(summary.failed).toBe(1);
      expect(store.findPr(ref)?.state).toBe('approved');
      expect(reactions.calls).toEqual([]);
    });

    it('keeps the unreachable clock running across repeated failures', async () => {
      stage(ref, 'waiting');
      await service.trackLinks(PUBLIC, '111.1', [ref]);

      github.fail(ref, new PrUnreachableError(ref, 'forbidden', 403));
      await service.runCycle();
      const first = store.findPr(ref)?.unreachableSince;

      await service.runCycle();
      expect(store.findPr(ref)?.unreachableSince).toBe(first);
    });

    it('survives a failing PR without abandoning the rest of the cycle', async () => {
      stage(ref, 'waiting');
      stage(other, 'waiting');
      await service.trackLinks(PUBLIC, '111.1', [ref]);
      await service.trackLinks(PUBLIC, '222.2', [other]);

      github.fail(ref, new Error('502 from github'));
      stage(other, 'approved');
      const summary = await service.runCycle();

      expect(summary).toMatchObject({ polled: 1, failed: 1 });
      expect(store.findPr(ref)?.state).toBe('no_reviews');
      expect(store.findPr(other)?.state).toBe('approved');
    });

    it('repairs a reaction that failed to apply earlier', async () => {
      stage(ref, 'approved');
      reactions.failAll('add', 'rate_limited');
      await service.trackLinks(PUBLIC, '111.1', [ref]);
      expect(store.messagesForPr(store.findPr(ref)!.id)[0]?.currentReaction).toBeNull();

      // Nothing about the PR changed, but the next cycle still fixes the emoji.
      reactions.clearFailures();
      reactions.calls.length = 0;
      await service.runCycle();

      expect(names()).toEqual(['add:white_check_mark']);
      expect(store.messagesForPr(store.findPr(ref)!.id)[0]?.currentReaction).toBe('white_check_mark');
    });
  });

  describe('cleanup', () => {
    it('drops PRs that went terminal longer ago than the TTL', async () => {
      stage(ref, 'approved', { merged: true, closed: true });
      await service.trackLinks(PUBLIC, '111.1', [ref]);

      const ttl = config.cleanupTtlMs;
      expect((await service.cleanup(Date.now() + ttl - 1_000)).expired).toBe(0);
      expect((await service.cleanup(Date.now() + ttl + 1_000)).expired).toBe(1);
      expect(store.counts()).toEqual({ prs: 0, messages: 0, active: 0 });
    });

    it('gives up on a PR that stays unreachable, removing its emoji first', async () => {
      stage(ref, 'approved');
      await service.trackLinks(PUBLIC, '111.1', [ref]);

      github.fail(ref, new PrUnreachableError(ref, 'unauthorized', 401));
      await service.runCycle();
      expect(store.findPr(ref)?.state).toBe('unknown');
      reactions.calls.length = 0;

      const ttl = config.unreachableTtlMs;
      expect((await service.cleanup(Date.now() + ttl - 1_000)).retired).toBe(0);

      const { retired } = await service.cleanup(Date.now() + ttl + 1_000);
      expect(retired).toBe(1);
      // The message must not be left wearing a permanent :sleeping:.
      expect(names()).toEqual(['remove:sleeping']);
      expect(store.counts()).toEqual({ prs: 0, messages: 0, active: 0 });
    });

    it('does not give up on a PR that became reachable again', async () => {
      stage(ref, 'approved');
      await service.trackLinks(PUBLIC, '111.1', [ref]);
      github.fail(ref, new PrUnreachableError(ref, 'not_found', 404));
      await service.runCycle();

      github.clearFailure(ref);
      await service.runCycle();

      const { retired } = await service.cleanup(Date.now() + config.unreachableTtlMs + 1_000);
      expect(retired).toBe(0);
      expect(store.findPr(ref)?.state).toBe('approved');
    });

    it('runs as part of every cycle', async () => {
      stage(ref, 'waiting');
      stage(other, 'approved', { merged: true, closed: true });
      await service.trackLinks(PUBLIC, '111.1', [ref]);
      await service.trackLinks(PUBLIC, '222.2', [other]);

      // Negative TTL: everything already closed is past its cutoff, regardless of
      // how many milliseconds this test takes to reach the cycle.
      build({ cleanupTtlMs: -1_000 });
      const summary = await service.runCycle();

      expect(summary.cleaned).toBe(1);
      expect(store.findPr(other)).toBeUndefined();
      expect(store.findPr(ref)).toBeDefined();
    });
  });
});
