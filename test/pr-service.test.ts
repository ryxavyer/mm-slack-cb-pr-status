import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import type { DbHandle } from '../src/db/client.js';
import type { Store } from '../src/db/store.js';
import { PrUnreachableError } from '../src/github/client.js';
import { PrService } from '../src/pr-service.js';
import { Reconciler } from '../src/reconciler.js';
import type { PrRef } from '../src/types.js';
import {
  FakeGitHubClient,
  FakeReactionClient,
  testConfig,
  testLogger,
  testStore,
} from './helpers.js';

const ref: PrRef = { owner: 'acme', repo: 'monolith', number: 42 };
const other: PrRef = { owner: 'acme', repo: 'monolith', number: 43 };

describe('PrService', () => {
  let store: Store;
  let handle: DbHandle;
  let github: FakeGitHubClient;
  let reactions: FakeReactionClient;
  let config: Config;
  let service: PrService;

  const build = (overrides: Partial<Config> = {}) => {
    config = testConfig(overrides);
    const reconciler = new Reconciler(store, reactions, config.emoji, testLogger);
    service = new PrService(store, github, reconciler, config, testLogger);
  };

  beforeEach(() => {
    ({ store, handle } = testStore());
    github = new FakeGitHubClient();
    reactions = new FakeReactionClient();
    build();
  });

  afterEach(() => handle.close());

  describe('trackLinks', () => {
    it('tracks a link and applies the emoji immediately', async () => {
      github.set(ref, { approvals: 1 });
      await service.trackLinks('C_WATCHED', '111.1', [ref]);

      const pr = store.findPr(ref);
      expect(pr?.state).toBe('partial');
      expect(pr?.approvals).toBe(1);
      expect(reactions.calls).toEqual([
        { op: 'add', channel: 'C_WATCHED', timestamp: '111.1', name: '1of2' },
      ]);
    });

    it('tracks every repo when no allowlist is set', async () => {
      const elsewhere = { owner: 'other', repo: 'thing', number: 9 };
      github.set(elsewhere, { approvals: 2 });
      await service.trackLinks('C_WATCHED', '111.1', [elsewhere]);

      expect(store.findPr(elsewhere)?.state).toBe('approved');
    });

    it('ignores links outside the repo allowlist', async () => {
      build({ watchedRepos: new Set(['acme/monolith']) });
      const elsewhere = { owner: 'other', repo: 'thing', number: 9 };
      github.set(ref, { approvals: 1 });
      github.set(elsewhere, { approvals: 2 });

      await service.trackLinks('C_WATCHED', '111.1', [ref, elsewhere]);

      expect(store.findPr(ref)?.state).toBe('partial');
      // Not tracked at all — no row, no GitHub call, and crucially no reaction,
      // rather than the :sleeping: a 404 would have produced.
      expect(store.findPr(elsewhere)).toBeUndefined();
      expect(github.requests).toEqual(['acme/monolith#42']);
      expect(reactions.calls.map((c) => c.name)).toEqual(['1of2']);
    });

    it('matches the allowlist case-insensitively', async () => {
      build({ watchedRepos: new Set(['acme/monolith']) });
      github.set(ref, { approvals: 2 });

      // The parser lower-cases links, so `Acme/MonoLith` arrives normalised.
      await service.trackLinks('C_WATCHED', '111.1', [ref]);

      expect(store.findPr(ref)?.state).toBe('approved');
    });

    it('is idempotent across re-delivery and edits of the same message', async () => {
      github.set(ref, { approvals: 2 });
      await service.trackLinks('C_WATCHED', '111.1', [ref]);
      await service.trackLinks('C_WATCHED', '111.1', [ref]);

      const pr = store.findPr(ref);
      expect(store.counts().messages).toBe(1);
      expect(store.messagesForPr(pr!.id)[0]?.currentReaction).toBe('white_check_mark');
      // Second pass sees the reaction already in place and issues no Slack call.
      expect(reactions.calls).toHaveLength(1);
    });

    it('tracks the same PR posted in two messages and updates both', async () => {
      github.set(ref, { approvals: 0 });
      await service.trackLinks('C_WATCHED', '111.1', [ref]);
      await service.trackLinks('C_WATCHED', '222.2', [ref]);

      github.set(ref, { approvals: 2 });
      await service.runCycle();

      expect(reactions.calls.map((c) => `${c.op}:${c.timestamp}`)).toEqual([
        'add:111.1',
        'add:222.2',
      ]);
    });

    it('applies the merged emoji at once for an already-merged PR', async () => {
      github.set(ref, { merged: true, closed: true, approvals: 2 });
      await service.trackLinks('C_WATCHED', '111.1', [ref]);

      expect(store.findPr(ref)?.state).toBe('merged');
      expect(reactions.calls.map((c) => c.name)).toEqual(['merged']);
      // Terminal on arrival: never polled again.
      expect(store.listActivePrs()).toHaveLength(0);
    });

    it('keeps going when one link in a message fails', async () => {
      github.fail(ref, new Error('boom'));
      github.set(other, { approvals: 2 });

      await service.trackLinks('C_WATCHED', '111.1', [ref, other]);

      // The second link is still tracked and polled despite the first throwing.
      expect(store.findPr(ref)?.state).toBe('no_reviews');
      expect(store.findPr(other)?.state).toBe('approved');
      // No reaction, though: the message also links a PR we know nothing about,
      // so it cannot honestly be reported as approved.
      expect(reactions.calls).toEqual([]);
    });
  });

  describe('team resolution', () => {
    const teamMap = {
      botLogin: 'mmllc-gh',
      channels: new Map([['C_CREATOR', 'creator-team']]),
      groups: new Map([['messaging-team', 'messaging-pod']]),
    };

    // Slack renders a user group mention as <!subteam^ID|@handle>.
    const mention = 'ping <!subteam^S123|@messaging-team> please';

    beforeEach(() => {
      build({ teamMap });
      github.set(ref, { approvals: 1 });
    });

    it('resolves the channel team when the message has no group mention', async () => {
      await service.trackLinks('C_CREATOR', '111.1', [ref], 'no mentions here');
      expect(store.messageRequiredTeams('C_CREATOR', '111.1')).toEqual(['creator-team']);
    });

    it('resolves a group mention in a channel with no team of its own', async () => {
      await service.trackLinks('C_OTHER', '111.1', [ref], mention);
      expect(store.messageRequiredTeams('C_OTHER', '111.1')).toEqual(['messaging-pod']);
    });

    it('prefers the mentioned team over the channel team', async () => {
      await service.trackLinks('C_CREATOR', '111.1', [ref], mention);
      expect(store.messageRequiredTeams('C_CREATOR', '111.1')).toEqual(['messaging-pod']);
    });

    it('leaves no team context when neither the channel nor a mention resolves', async () => {
      await service.trackLinks('C_OTHER', '111.1', [ref], 'nothing to see');
      expect(store.messageRequiredTeams('C_OTHER', '111.1')).toEqual([]);
    });

    // `link_shared` carries no message text, so it always resolves to the
    // channel team (or nothing). It and the `message` event both fire for the
    // same post, in either order, and the mention must survive both orderings.
    describe('when link_shared and message both fire', () => {
      it('upgrades the channel team once the message text arrives', async () => {
        await service.trackLinks('C_CREATOR', '111.1', [ref]); // link_shared
        expect(store.messageRequiredTeams('C_CREATOR', '111.1')).toEqual(['creator-team']);

        await service.trackLinks('C_CREATOR', '111.1', [ref], mention); // message
        expect(store.messageRequiredTeams('C_CREATOR', '111.1')).toEqual(['messaging-pod']);
      });

      it('does not let a late link_shared clobber the mentioned team', async () => {
        await service.trackLinks('C_CREATOR', '111.1', [ref], mention); // message
        await service.trackLinks('C_CREATOR', '111.1', [ref]); // link_shared, arriving late

        expect(store.messageRequiredTeams('C_CREATOR', '111.1')).toEqual(['messaging-pod']);
      });

      it('does not strip a mentioned team in a channel with no team of its own', async () => {
        await service.trackLinks('C_OTHER', '111.1', [ref], mention);
        await service.trackLinks('C_OTHER', '111.1', [ref]);

        expect(store.messageRequiredTeams('C_OTHER', '111.1')).toEqual(['messaging-pod']);
      });
    });

    // An edit re-delivers as message_changed with the full new text, so the
    // resolution is made afresh from what the message now says.
    describe('when an edit changes the mentions', () => {
      it('falls back to the channel team when the mention is removed', async () => {
        await service.trackLinks('C_CREATOR', '111.1', [ref], mention);
        expect(store.messageRequiredTeams('C_CREATOR', '111.1')).toEqual(['messaging-pod']);

        await service.trackLinks('C_CREATOR', '111.1', [ref], 'mention removed');
        expect(store.messageRequiredTeams('C_CREATOR', '111.1')).toEqual(['creator-team']);
      });

      it('clears the team context when the mention is removed in an unmapped channel', async () => {
        await service.trackLinks('C_OTHER', '111.1', [ref], mention);
        expect(store.messageRequiredTeams('C_OTHER', '111.1')).toEqual(['messaging-pod']);

        await service.trackLinks('C_OTHER', '111.1', [ref], 'mention removed');
        expect(store.messageRequiredTeams('C_OTHER', '111.1')).toEqual([]);
      });

      it('switches to the newly mentioned team', async () => {
        await service.trackLinks('C_CREATOR', '111.1', [ref], mention);

        await service.trackLinks('C_CREATOR', '111.1', [ref], 'no wait, this one');
        expect(store.messageRequiredTeams('C_CREATOR', '111.1')).toEqual(['creator-team']);
      });

      it('still ignores a late link_shared after the mention was cleared', async () => {
        await service.trackLinks('C_OTHER', '111.1', [ref], mention);
        await service.trackLinks('C_OTHER', '111.1', [ref], 'mention removed');
        await service.trackLinks('C_OTHER', '111.1', [ref]); // link_shared

        expect(store.messageRequiredTeams('C_OTHER', '111.1')).toEqual([]);
      });
    });

    it('keeps the team context when a later edit adds another PR link', async () => {
      github.set(other, { approvals: 1 });
      await service.trackLinks('C_CREATOR', '111.1', [ref], mention);

      // The edit re-delivers as a message_changed with the same text; the new
      // link inserts a row whose required_team starts null.
      await service.trackLinks('C_CREATOR', '111.1', [ref, other], mention);

      expect(store.messageRequiredTeams('C_CREATOR', '111.1')).toEqual(['messaging-pod']);
    });

    it('sets no team at all when TEAM_MAP_FILE is not configured', async () => {
      build({ teamMap: null });
      await service.trackLinks('C_CREATOR', '111.1', [ref], mention);
      expect(store.messageRequiredTeams('C_CREATOR', '111.1')).toEqual([]);
    });
  });

  describe('a message linking several PRs', () => {
    it('carries one reaction for the least settled PR on it', async () => {
      github.set(ref, { approvals: 2 });
      github.set(other, { approvals: 1 });

      await service.trackLinks('C_WATCHED', '111.1', [ref, other]);

      // One PR approved, one partial → the message still needs eyes.
      expect(reactions.calls.map((c) => `${c.op}:${c.name}`)).toEqual(['add:1of2']);
    });

    it('does not lose one PR’s status when another shares its emoji and moves on', async () => {
      // The exact collision this design fixes: both PRs partial, so both want
      // :1of2:, but Slack has only one reaction slot per message.
      github.set(ref, { approvals: 1 });
      github.set(other, { approvals: 1 });
      await service.trackLinks('C_WATCHED', '111.1', [ref, other]);
      expect(reactions.calls.map((c) => `${c.op}:${c.name}`)).toEqual(['add:1of2']);

      // First PR gets approved; the second is still only partially reviewed.
      reactions.calls.length = 0;
      github.set(ref, { approvals: 2 });
      await service.runCycle();

      // The reaction must stay :1of2: for the PR still awaiting review, rather
      // than being removed out from under it.
      expect(reactions.calls).toEqual([]);
      expect(store.messageReaction('C_WATCHED', '111.1')).toBe('1of2');

      // Once both are approved, the message finally advances.
      github.set(other, { approvals: 2 });
      await service.runCycle();
      expect(reactions.calls.map((c) => `${c.op}:${c.name}`)).toEqual([
        'remove:1of2',
        'add:white_check_mark',
      ]);
    });

    it('hands the reaction to the surviving PR when one is retired', async () => {
      github.set(ref, { approvals: 1 });
      github.set(other, { merged: true, closed: true, approvals: 2 });
      await service.trackLinks('C_WATCHED', '111.1', [ref, other]);
      // Aggregate is partial: the merged PR does not settle the message.
      expect(store.messageReaction('C_WATCHED', '111.1')).toBe('1of2');

      // The merged PR ages out of the database entirely.
      reactions.calls.length = 0;
      await service.cleanup(Date.now() + config.cleanupTtlMs + 1_000);
      await service.runCycle();

      // Still :1of2: — the remaining PR keeps the message accurate.
      expect(store.findPr(other)).toBeUndefined();
      expect(store.messageReaction('C_WATCHED', '111.1')).toBe('1of2');
    });

    it('strips the reaction when the last PR on a message is retired', async () => {
      github.set(ref, { approvals: 1 });
      await service.trackLinks('C_WATCHED', '111.1', [ref]);

      github.fail(ref, new PrUnreachableError(ref, 'not_found', 404));
      await service.runCycle();
      reactions.calls.length = 0;

      await service.cleanup(Date.now() + config.unreachableTtlMs + 1_000);

      expect(reactions.calls.map((c) => `${c.op}:${c.name}`)).toEqual(['remove:sleeping']);
    });
  });

  describe('runCycle', () => {
    it('polls active PRs and reconciles the ones that changed', async () => {
      github.set(ref, { approvals: 0 });
      await service.trackLinks('C_WATCHED', '111.1', [ref]);
      reactions.calls.length = 0;

      github.set(ref, { approvals: 1 });
      const first = await service.runCycle();
      expect(first).toMatchObject({ polled: 1, changed: 1, failed: 0 });
      expect(reactions.calls.map((c) => c.name)).toEqual(['1of2']);

      // Nothing changed on the second cycle → no Slack traffic.
      reactions.calls.length = 0;
      const second = await service.runCycle();
      expect(second).toMatchObject({ polled: 1, changed: 0 });
      expect(reactions.calls).toEqual([]);
    });

    it('walks a PR through the whole lifecycle', async () => {
      github.set(ref, { approvals: 0 });
      await service.trackLinks('C_WATCHED', '111.1', [ref]);

      github.set(ref, { approvals: 1 });
      await service.runCycle();
      expect(store.findPr(ref)?.state).toBe('partial');

      github.set(ref, { approvals: 2 });
      await service.runCycle();
      expect(store.findPr(ref)?.state).toBe('approved');

      github.set(ref, { approvals: 2, merged: true, closed: true });
      await service.runCycle();
      expect(store.findPr(ref)?.state).toBe('merged');

      expect(reactions.calls.map((c) => `${c.op}:${c.name}`)).toEqual([
        'add:1of2',
        'remove:1of2',
        'add:white_check_mark',
        'remove:white_check_mark',
        'add:merged',
      ]);
    });

    it('swaps to the blocked emoji when a reviewer requests changes', async () => {
      github.set(ref, { approvals: 1 });
      await service.trackLinks('C_WATCHED', '111.1', [ref]);
      reactions.calls.length = 0;

      // A second reviewer blocks: one approval, one changes-requested.
      github.set(ref, { approvals: 1, changesRequested: 1 });
      await service.runCycle();

      expect(store.findPr(ref)?.state).toBe('changes_requested');
      expect(reactions.calls.map((c) => `${c.op}:${c.name}`)).toEqual([
        'remove:1of2',
        'add:request-changes',
      ]);

      // Author addresses it, reviewer approves: straight to fully approved.
      reactions.calls.length = 0;
      github.set(ref, { approvals: 2, changesRequested: 0 });
      await service.runCycle();

      expect(store.findPr(ref)?.state).toBe('approved');
      expect(reactions.calls.map((c) => `${c.op}:${c.name}`)).toEqual([
        'remove:request-changes',
        'add:white_check_mark',
      ]);
    });

    it('shows blocked even when the PR already has enough approvals', async () => {
      github.set(ref, { approvals: 2, changesRequested: 1 });
      await service.trackLinks('C_WATCHED', '111.1', [ref]);

      expect(store.findPr(ref)?.state).toBe('changes_requested');
      expect(reactions.calls.map((c) => c.name)).toEqual(['request-changes']);
    });

    it('walks backwards when an approval is revoked', async () => {
      github.set(ref, { approvals: 2 });
      await service.trackLinks('C_WATCHED', '111.1', [ref]);
      reactions.calls.length = 0;

      github.set(ref, { approvals: 1 });
      await service.runCycle();

      expect(store.findPr(ref)?.state).toBe('partial');
      expect(reactions.calls.map((c) => `${c.op}:${c.name}`)).toEqual([
        'remove:white_check_mark',
        'add:1of2',
      ]);
    });

    it('stops polling a PR once it is terminal', async () => {
      github.set(ref, { merged: true, closed: true, approvals: 0 });
      await service.trackLinks('C_WATCHED', '111.1', [ref]);
      github.requests.length = 0;

      await service.runCycle();
      expect(github.requests).toEqual([]);
    });

    it('shows unknown rather than closed when GitHub stops answering', async () => {
      github.set(ref, { approvals: 2 });
      await service.trackLinks('C_WATCHED', '111.1', [ref]);
      reactions.calls.length = 0;

      github.fail(ref, new PrUnreachableError(ref, 'unauthorized', 401));
      await service.runCycle();

      // Not "closed" — we genuinely don't know, and we say so.
      expect(store.findPr(ref)?.state).toBe('unknown');
      expect(reactions.calls.map((c) => `${c.op}:${c.name}`)).toEqual([
        'remove:white_check_mark',
        'add:sleeping',
      ]);
    });

    it.each([
      ['unauthorized', 401],
      ['forbidden', 403],
      ['not_found', 404],
    ] as const)('treats a %s response as unknown', async (reason, status) => {
      github.set(ref, { approvals: 0 });
      await service.trackLinks('C_WATCHED', '111.1', [ref]);

      github.fail(ref, new PrUnreachableError(ref, reason, status));
      await service.runCycle();

      expect(store.findPr(ref)?.state).toBe('unknown');
      expect(store.findPr(ref)?.unreachableSince).toBeGreaterThan(0);
    });

    it('keeps polling an unknown PR and restores the real state once access returns', async () => {
      github.set(ref, { approvals: 1 });
      await service.trackLinks('C_WATCHED', '111.1', [ref]);

      github.fail(ref, new PrUnreachableError(ref, 'unauthorized', 401));
      await service.runCycle();
      expect(store.findPr(ref)?.state).toBe('unknown');

      // Token rotated: the PR is visible again, no human intervention needed.
      reactions.calls.length = 0;
      github.clearFailure(ref);
      github.set(ref, { approvals: 2 });
      await service.runCycle();

      const pr = store.findPr(ref);
      expect(pr?.state).toBe('approved');
      expect(pr?.unreachableSince).toBeNull();
      expect(reactions.calls.map((c) => `${c.op}:${c.name}`)).toEqual([
        'remove:sleeping',
        'add:white_check_mark',
      ]);
    });

    it('remembers the approval count while a PR is unreachable', async () => {
      github.set(ref, { approvals: 1 });
      await service.trackLinks('C_WATCHED', '111.1', [ref]);

      github.fail(ref, new PrUnreachableError(ref, 'not_found', 404));
      await service.runCycle();

      expect(store.findPr(ref)?.approvals).toBe(1);
    });

    it('does not flip a PR to unknown on a transient error', async () => {
      github.set(ref, { approvals: 1 });
      await service.trackLinks('C_WATCHED', '111.1', [ref]);
      reactions.calls.length = 0;

      // Rate limiting and 5xx are not access failures — state must not move.
      github.fail(ref, new Error('503 Service Unavailable'));
      const summary = await service.runCycle();

      expect(summary.failed).toBe(1);
      expect(store.findPr(ref)?.state).toBe('partial');
      expect(reactions.calls).toEqual([]);
    });

    it('keeps the unreachable clock running across repeated failures', async () => {
      github.set(ref, { approvals: 0 });
      await service.trackLinks('C_WATCHED', '111.1', [ref]);

      github.fail(ref, new PrUnreachableError(ref, 'forbidden', 403));
      await service.runCycle();
      const first = store.findPr(ref)?.unreachableSince;

      await service.runCycle();
      expect(store.findPr(ref)?.unreachableSince).toBe(first);
    });

    it('survives a failing PR without abandoning the rest of the cycle', async () => {
      github.set(ref, { approvals: 0 });
      github.set(other, { approvals: 0 });
      await service.trackLinks('C_WATCHED', '111.1', [ref]);
      await service.trackLinks('C_WATCHED', '222.2', [other]);

      github.fail(ref, new Error('502 from github'));
      github.set(other, { approvals: 2 });
      const summary = await service.runCycle();

      expect(summary).toMatchObject({ polled: 1, failed: 1 });
      expect(store.findPr(ref)?.state).toBe('no_reviews');
      expect(store.findPr(other)?.state).toBe('approved');
    });

    it('repairs a reaction that failed to apply earlier', async () => {
      github.set(ref, { approvals: 1 });
      reactions.failAll('add', 'rate_limited');
      await service.trackLinks('C_WATCHED', '111.1', [ref]);
      expect(store.messagesForPr(store.findPr(ref)!.id)[0]?.currentReaction).toBeNull();

      // Nothing about the PR changed, but the next cycle still fixes the emoji.
      reactions.clearFailures();
      reactions.calls.length = 0;
      await service.runCycle();

      expect(reactions.calls.map((c) => c.name)).toEqual(['1of2']);
      expect(store.messagesForPr(store.findPr(ref)!.id)[0]?.currentReaction).toBe('1of2');
    });

    it('respects a changed REQUIRED_APPROVALS on the next poll', async () => {
      github.set(ref, { approvals: 1 });
      await service.trackLinks('C_WATCHED', '111.1', [ref]);
      expect(store.findPr(ref)?.state).toBe('partial');

      build({ requiredApprovals: 1 });
      await service.runCycle();

      expect(store.findPr(ref)?.state).toBe('approved');
      expect(store.findPr(ref)?.requiredApprovals).toBe(1);
    });
  });

  describe('cleanup', () => {
    it('drops PRs that went terminal longer ago than the TTL', async () => {
      github.set(ref, { merged: true, closed: true, approvals: 2 });
      await service.trackLinks('C_WATCHED', '111.1', [ref]);

      const ttl = config.cleanupTtlMs;
      expect((await service.cleanup(Date.now() + ttl - 1_000)).expired).toBe(0);
      expect((await service.cleanup(Date.now() + ttl + 1_000)).expired).toBe(1);
      expect(store.counts()).toEqual({ prs: 0, messages: 0, active: 0 });
    });

    it('gives up on a PR that stays unreachable, removing its emoji first', async () => {
      github.set(ref, { approvals: 1 });
      await service.trackLinks('C_WATCHED', '111.1', [ref]);

      github.fail(ref, new PrUnreachableError(ref, 'unauthorized', 401));
      await service.runCycle();
      expect(store.findPr(ref)?.state).toBe('unknown');
      reactions.calls.length = 0;

      const ttl = config.unreachableTtlMs;
      expect((await service.cleanup(Date.now() + ttl - 1_000)).retired).toBe(0);

      const { retired } = await service.cleanup(Date.now() + ttl + 1_000);
      expect(retired).toBe(1);
      // The message must not be left wearing a permanent :sleeping:.
      expect(reactions.calls.map((c) => `${c.op}:${c.name}`)).toEqual(['remove:sleeping']);
      expect(store.counts()).toEqual({ prs: 0, messages: 0, active: 0 });
    });

    it('does not give up on a PR that became reachable again', async () => {
      github.set(ref, { approvals: 1 });
      await service.trackLinks('C_WATCHED', '111.1', [ref]);
      github.fail(ref, new PrUnreachableError(ref, 'not_found', 404));
      await service.runCycle();

      github.clearFailure(ref);
      await service.runCycle();

      const { retired } = await service.cleanup(Date.now() + config.unreachableTtlMs + 1_000);
      expect(retired).toBe(0);
      expect(store.findPr(ref)?.state).toBe('partial');
    });

    it('runs as part of every cycle', async () => {
      github.set(ref, { approvals: 0 });
      github.set(other, { merged: true, closed: true, approvals: 2 });
      await service.trackLinks('C_WATCHED', '111.1', [ref]);
      await service.trackLinks('C_WATCHED', '222.2', [other]);

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
