import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DbHandle } from '../src/db/client.js';
import type { TrackedPr } from '../src/db/schema.js';
import type { Store } from '../src/db/store.js';
import { Reconciler } from '../src/reconciler.js';
import { managedEmojis } from '../src/state.js';
import type { PrState } from '../src/types.js';
import { FakeReactionClient, testConfig, testLogger, testStore } from './helpers.js';

const emoji = testConfig().emoji;
const ref = { owner: 'acme', repo: 'monolith', number: 42 };

describe('Reconciler', () => {
  let store: Store;
  let handle: DbHandle;
  let reactions: FakeReactionClient;
  let reconciler: Reconciler;
  let pr: TrackedPr;

  beforeEach(() => {
    ({ store, handle } = testStore());
    reactions = new FakeReactionClient();
    reconciler = new Reconciler(store, reactions, emoji, testLogger);
    pr = store.upsertPr(ref, 2);
  });

  afterEach(() => handle.close());

  /** Puts the PR into `state` and returns the row, as the poller would. */
  const setState = (state: PrState): TrackedPr => {
    const updated = store.recordPoll(pr.id, { state, approvals: 0, requiredApprovals: 2 });
    if (!updated) throw new Error('missing pr');
    return updated;
  };

  it('adds the no-reviews emoji for a PR nobody has looked at', async () => {
    store.linkMessage(pr.id, 'C1', '111.1');
    const summary = await reconciler.reconcilePr(setState('no_reviews'));

    expect(reactions.calls).toEqual([
      { op: 'add', channel: 'C1', timestamp: '111.1', name: 'please' },
    ]);
    expect(summary.added).toBe(1);
    expect(store.messagesForPr(pr.id)[0]?.currentReaction).toBe('please');
  });

  it('adds nothing when the no-reviews emoji is configured empty', async () => {
    const bare = new Reconciler(store, reactions, { ...emoji, noReviews: null }, testLogger);
    store.linkMessage(pr.id, 'C1', '111.1');
    const summary = await bare.reconcilePr(setState('no_reviews'));

    expect(reactions.calls).toEqual([]);
    expect(summary.unchanged).toBe(1);
    expect(store.messagesForPr(pr.id)[0]?.currentReaction).toBeNull();
  });

  it('adds the target emoji on the first transition', async () => {
    store.linkMessage(pr.id, 'C1', '111.1');
    const summary = await reconciler.reconcilePr(setState('partial'));

    expect(reactions.calls).toEqual([
      { op: 'add', channel: 'C1', timestamp: '111.1', name: '1of2' },
    ]);
    expect(summary.added).toBe(1);
    expect(store.messagesForPr(pr.id)[0]?.currentReaction).toBe('1of2');
  });

  it('swaps one managed emoji for another, remove before add', async () => {
    store.linkMessage(pr.id, 'C1', '111.1');
    await reconciler.reconcilePr(setState('partial'));
    reactions.calls.length = 0;

    const summary = await reconciler.reconcilePr(setState('approved'));

    expect(reactions.calls.map((c) => [c.op, c.name])).toEqual([
      ['remove', '1of2'],
      ['add', 'white_check_mark'],
    ]);
    expect(summary).toMatchObject({ added: 1, removed: 1 });
    expect(store.messagesForPr(pr.id)[0]?.currentReaction).toBe('white_check_mark');
  });

  it('swaps back to the no-reviews emoji when an approval is revoked', async () => {
    store.linkMessage(pr.id, 'C1', '111.1');
    await reconciler.reconcilePr(setState('partial'));
    reactions.calls.length = 0;

    // Approval revoked: partial → no_reviews.
    await reconciler.reconcilePr(setState('no_reviews'));

    expect(reactions.calls.map((c) => [c.op, c.name])).toEqual([
      ['remove', '1of2'],
      ['add', 'please'],
    ]);
    expect(store.messagesForPr(pr.id)[0]?.currentReaction).toBe('please');
  });

  it('removes the emoji with no replacement when a state has none', async () => {
    const bare = new Reconciler(store, reactions, { ...emoji, noReviews: null }, testLogger);
    store.linkMessage(pr.id, 'C1', '111.1');
    await bare.reconcilePr(setState('partial'));
    reactions.calls.length = 0;

    await bare.reconcilePr(setState('no_reviews'));

    expect(reactions.calls.map((c) => [c.op, c.name])).toEqual([['remove', '1of2']]);
    expect(store.messagesForPr(pr.id)[0]?.currentReaction).toBeNull();
  });

  it('does nothing when the message already carries the target emoji', async () => {
    store.linkMessage(pr.id, 'C1', '111.1');
    await reconciler.reconcilePr(setState('approved'));
    reactions.calls.length = 0;

    const summary = await reconciler.reconcilePr(setState('approved'));
    expect(reactions.calls).toEqual([]);
    expect(summary.unchanged).toBe(1);
  });

  it('updates every message linking the same PR', async () => {
    store.linkMessage(pr.id, 'C1', '111.1');
    store.linkMessage(pr.id, 'C1', '222.2');
    store.linkMessage(pr.id, 'C2', '333.3');

    const summary = await reconciler.reconcilePr(setState('merged'));

    expect(summary.added).toBe(3);
    expect(reactions.calls.map((c) => `${c.channel}/${c.timestamp}`)).toEqual([
      'C1/111.1',
      'C1/222.2',
      'C2/333.3',
    ]);
    expect(reactions.calls.every((c) => c.name === 'merged')).toBe(true);
  });

  it('treats already_reacted as success', async () => {
    store.linkMessage(pr.id, 'C1', '111.1');
    reactions.failWith('add', '1of2', 'already_reacted');

    const summary = await reconciler.reconcilePr(setState('partial'));

    expect(summary.added).toBe(1);
    expect(summary.failed).toBe(0);
    expect(store.messagesForPr(pr.id)[0]?.currentReaction).toBe('1of2');
  });

  it('treats no_reaction on remove as success', async () => {
    store.linkMessage(pr.id, 'C1', '111.1');
    await reconciler.reconcilePr(setState('partial'));
    reactions.failWith('remove', '1of2', 'no_reaction');

    const summary = await reconciler.reconcilePr(setState('approved'));

    expect(summary).toMatchObject({ removed: 1, added: 1, failed: 0 });
    expect(store.messagesForPr(pr.id)[0]?.currentReaction).toBe('white_check_mark');
  });

  it('untracks a message that Slack says is gone', async () => {
    store.linkMessage(pr.id, 'C1', '111.1');
    store.linkMessage(pr.id, 'C1', '222.2');
    reactions.failWith('add', '1of2', 'message_not_found');

    const summary = await reconciler.reconcilePr(setState('partial'));

    expect(summary.droppedMessages).toBe(2);
    expect(store.messagesForPr(pr.id)).toHaveLength(0);
  });

  it('untracks a message deleted mid-transition, on the remove call', async () => {
    store.linkMessage(pr.id, 'C1', '111.1');
    await reconciler.reconcilePr(setState('partial'));
    reactions.failWith('remove', '1of2', 'message_not_found');

    const summary = await reconciler.reconcilePr(setState('approved'));

    expect(summary.droppedMessages).toBe(1);
    expect(store.messagesForPr(pr.id)).toHaveLength(0);
  });

  it('records the removal even when the follow-up add fails, and retries next time', async () => {
    store.linkMessage(pr.id, 'C1', '111.1');
    await reconciler.reconcilePr(setState('partial'));
    reactions.failWith('add', 'white_check_mark', 'rate_limited');

    const failed = await reconciler.reconcilePr(setState('approved'));
    expect(failed).toMatchObject({ removed: 1, failed: 1 });
    // State on Slack is "no reaction", and the row now says so.
    expect(store.messagesForPr(pr.id)[0]?.currentReaction).toBeNull();

    reactions.clearFailures();
    reactions.calls.length = 0;
    const retried = await reconciler.reconcilePr(setState('approved'));

    // The retry only adds — it does not try to remove an emoji that is gone.
    expect(retried.added).toBe(1);
    expect(reactions.calls.map((c) => c.op)).toEqual(['add']);
    expect(store.messagesForPr(pr.id)[0]?.currentReaction).toBe('white_check_mark');
  });

  it('leaves the row untouched when a removal fails outright', async () => {
    store.linkMessage(pr.id, 'C1', '111.1');
    await reconciler.reconcilePr(setState('partial'));
    reactions.failWith('remove', '1of2', 'rate_limited');

    const summary = await reconciler.reconcilePr(setState('merged'));

    expect(summary).toMatchObject({ failed: 1, added: 0, removed: 0 });
    expect(store.messagesForPr(pr.id)[0]?.currentReaction).toBe('1of2');
  });

  it('reports a missing custom emoji as a failure without dropping the message', async () => {
    store.linkMessage(pr.id, 'C1', '111.1');
    reactions.failWith('add', 'merged', 'invalid_name');

    const summary = await reconciler.reconcilePr(setState('merged'));

    expect(summary.failed).toBe(1);
    expect(store.messagesForPr(pr.id)).toHaveLength(1);
    expect(store.messagesForPr(pr.id)[0]?.currentReaction).toBeNull();
  });

  it('never touches emoji outside the managed set', async () => {
    store.linkMessage(pr.id, 'C1', '111.1');
    for (const state of ['partial', 'approved', 'merged', 'closed', 'no_reviews'] as const) {
      await reconciler.reconcilePr(setState(state));
    }
    // Derived from the config rather than hardcoded, so adding a state to the
    // managed set cannot quietly widen what this test accepts.
    const managed = new Set(managedEmojis(emoji));
    expect(reactions.calls.length).toBeGreaterThan(0);
    expect(reactions.calls.every((c) => managed.has(c.name))).toBe(true);
  });

  it('honours an emoji configured as disabled', async () => {
    const noClosedEmoji = new Reconciler(
      store,
      reactions,
      { ...emoji, closed: null },
      testLogger,
    );
    store.linkMessage(pr.id, 'C1', '111.1');

    await noClosedEmoji.reconcilePr(setState('closed'));

    expect(reactions.calls).toEqual([]);
  });

  describe('codeowner review groups', () => {
    /** Puts the PR at `state` with a codeowner status naming each team. */
    function setPr(state: PrState, teamStatuses: Record<string, boolean>): void {
      const requirements = Object.entries(teamStatuses).map(([team, satisfied]) => ({
        teams: [team],
        satisfied,
      }));
      const allSatisfied = requirements.length > 0 && requirements.every((r) => r.satisfied);
      const updated = store.recordPoll(pr.id, {
        state,
        approvals: state === 'approved' ? 2 : state === 'partial' ? 1 : 0,
        requiredApprovals: 2,
        codeownerStatus: JSON.stringify({ requirements, minimum: null, allSatisfied }),
      });
      if (!updated) throw new Error('missing pr');
    }

    const added = () => reactions.calls.find((c) => c.op === 'add')?.name ?? null;

    it('shows approved when every group has signed off', async () => {
      store.linkMessage(pr.id, 'C1', '111.1');
      setPr('approved', { 'creator-team': true, 'platform-team': true });

      await reconciler.reconcileMessage('C1', '111.1');
      expect(added()).toBe('white_check_mark');
    });

    it('holds at partial while any group is still pending', async () => {
      store.linkMessage(pr.id, 'C1', '111.1');
      setPr('approved', { 'creator-team': true, 'platform-team': false });

      const summary = await reconciler.reconcileMessage('C1', '111.1');
      expect(added()).toBe('1of2');
      expect(summary.added).toBe(1);
    });

    it('marks an unreviewed PR as awaiting the group', async () => {
      store.linkMessage(pr.id, 'C1', '111.1');
      setPr('no_reviews', { 'creator-team': false });

      const summary = await reconciler.reconcileMessage('C1', '111.1');
      expect(added()).toBe('please');
      expect(summary.added).toBe(1);
    });

    it('applies the same rule in every channel', async () => {
      // The channel a message is in no longer changes the answer.
      store.linkMessage(pr.id, 'C1', '111.1');
      store.linkMessage(pr.id, 'C2', '222.2');
      setPr('approved', { 'creator-team': false });

      await reconciler.reconcileMessage('C1', '111.1');
      await reconciler.reconcileMessage('C2', '222.2');

      expect(reactions.calls.filter((c) => c.op === 'add').map((c) => c.name)).toEqual([
        '1of2',
        '1of2',
      ]);
    });

    it('falls back to the approval count with no codeowner data', async () => {
      store.linkMessage(pr.id, 'C1', '111.1');
      setState('partial');

      const summary = await reconciler.reconcileMessage('C1', '111.1');
      expect(added()).toBe('1of2');
      expect(summary.added).toBe(1);
    });

    it('releases the hold once the last group signs off', async () => {
      store.linkMessage(pr.id, 'C1', '111.1');
      setPr('approved', { 'creator-team': false });
      await reconciler.reconcileMessage('C1', '111.1');
      reactions.calls.length = 0;

      setPr('approved', { 'creator-team': true });
      await reconciler.reconcileMessage('C1', '111.1');

      expect(reactions.calls.map((c) => [c.op, c.name])).toEqual([
        ['remove', '1of2'],
        ['add', 'white_check_mark'],
      ]);
    });
  });

  describe('aggregating several PRs on one message', () => {
    it('lets awaiting_codeowners outrank a partly reviewed PR', async () => {
      const other = store.upsertPr({ owner: 'acme', repo: 'monolith', number: 43 }, 2);
      store.linkMessage(pr.id, 'C1', '111.1');
      store.linkMessage(other.id, 'C1', '111.1');

      store.recordPoll(pr.id, {
        state: 'no_reviews',
        approvals: 0,
        requiredApprovals: 2,
        codeownerStatus: JSON.stringify({
          requirements: [{ teams: ['creator-team'], satisfied: false }],
          minimum: null,
          allSatisfied: false,
        }),
      });
      store.recordPoll(other.id, { state: 'partial', approvals: 1, requiredApprovals: 2 });

      await reconciler.reconcileMessage('C1', '111.1');
      expect(reactions.calls.find((c) => c.op === 'add')?.name).toBe('please');
    });
  });
});
