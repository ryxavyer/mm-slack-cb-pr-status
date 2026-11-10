import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DbHandle } from '../src/db/client.js';
import type { Store } from '../src/db/store.js';
import type { PrRef } from '../src/types.js';
import { testStore } from './helpers.js';

const ref: PrRef = { owner: 'acme', repo: 'monolith', number: 42 };
const other: PrRef = { owner: 'acme', repo: 'monolith', number: 43 };

describe('Store', () => {
  let store: Store;
  let handle: DbHandle;

  beforeEach(() => {
    ({ store, handle } = testStore());
  });

  afterEach(() => {
    handle.close();
  });

  it('creates a PR once and returns the same row afterwards', () => {
    const first = store.upsertPr(ref);
    const second = store.upsertPr(ref);
    expect(second.id).toBe(first.id);
    expect(first.state).toBe('no_reviews');
    expect(store.counts().prs).toBe(1);
  });

  it('keeps a known PR’s state on re-upsert', () => {
    const pr = store.upsertPr(ref);
    store.recordPoll(pr.id, { state: 'approved' });
    expect(store.upsertPr(ref).state).toBe('approved');
  });

  it('links many messages to one PR without duplicating rows', () => {
    const pr = store.upsertPr(ref);
    const a = store.linkMessage(pr.id, 'C1', '111.1');
    const b = store.linkMessage(pr.id, 'C1', '222.2');
    const again = store.linkMessage(pr.id, 'C1', '111.1');

    expect(again.id).toBe(a.id);
    expect(a.id).not.toBe(b.id);
    expect(store.messagesForPr(pr.id)).toHaveLength(2);
  });

  it('treats the same timestamp in different channels as different messages', () => {
    const pr = store.upsertPr(ref);
    store.linkMessage(pr.id, 'C1', '111.1');
    store.linkMessage(pr.id, 'C2', '111.1');
    expect(store.messagesForPr(pr.id)).toHaveLength(2);
  });

  it('lists only non-terminal PRs as active', () => {
    const open = store.upsertPr(ref);
    const done = store.upsertPr(other);
    store.linkMessage(open.id, 'C1', '111.1');
    store.linkMessage(done.id, 'C1', '222.2');
    store.recordPoll(done.id, { state: 'merged' });

    const active = store.listActivePrs();
    expect(active.map((p) => p.id)).toEqual([open.id]);
  });

  it('stamps closedAt when a PR first goes terminal and keeps it stable', () => {
    const pr = store.upsertPr(ref);
    const merged = store.recordPoll(
      pr.id,
      { state: 'merged' },
      1_000,
    );
    expect(merged?.closedAt).toBe(1_000);

    const again = store.recordPoll(
      pr.id,
      { state: 'merged' },
      9_000,
    );
    expect(again?.closedAt).toBe(1_000);
    expect(again?.lastPolledAt).toBe(9_000);
  });

  it('clears closedAt if a PR is reopened', () => {
    const pr = store.upsertPr(ref);
    store.linkMessage(pr.id, 'C1', '111.1');
    store.recordPoll(pr.id, { state: 'closed' }, 1_000);
    const reopened = store.recordPoll(
      pr.id,
      { state: 'no_reviews' },
      2_000,
    );
    expect(reopened?.closedAt).toBeNull();
    expect(store.listActivePrs()).toHaveLength(1);
  });

  it('tracks the reaction currently on a message', () => {
    const pr = store.upsertPr(ref);
    const message = store.linkMessage(pr.id, 'C1', '111.1');
    expect(message.currentReaction).toBeNull();
    expect(store.messageReaction('C1', '111.1')).toBeNull();

    store.setMessageReaction('C1', '111.1', '1of2');
    expect(store.messageReaction('C1', '111.1')).toBe('1of2');

    store.setMessageReaction('C1', '111.1', null);
    expect(store.messageReaction('C1', '111.1')).toBeNull();
  });

  it('keeps the reaction consistent across every PR linked in a message', () => {
    const a = store.upsertPr(ref);
    const b = store.upsertPr(other);
    store.linkMessage(a.id, 'C1', '111.1');
    store.linkMessage(b.id, 'C1', '111.1');

    store.setMessageReaction('C1', '111.1', '1of2');

    expect(store.messagesForPr(a.id)[0]?.currentReaction).toBe('1of2');
    expect(store.messagesForPr(b.id)[0]?.currentReaction).toBe('1of2');
  });

  it('reports an existing reaction even when a newly linked PR row is still null', () => {
    const a = store.upsertPr(ref);
    store.linkMessage(a.id, 'C1', '111.1');
    store.setMessageReaction('C1', '111.1', 'white_check_mark');

    // A second PR link posted onto the same message starts with a null row.
    const b = store.upsertPr(other);
    store.linkMessage(b.id, 'C1', '111.1');

    expect(store.messageReaction('C1', '111.1')).toBe('white_check_mark');
  });

  it('lists every PR linked in a message', () => {
    const a = store.upsertPr(ref);
    const b = store.upsertPr(other);
    store.linkMessage(a.id, 'C1', '111.1');
    store.linkMessage(b.id, 'C1', '111.1');
    store.linkMessage(b.id, 'C1', '222.2');

    expect(store.prsForMessage('C1', '111.1').map((p) => p.number).sort()).toEqual([42, 43]);
    expect(store.prsForMessage('C1', '222.2').map((p) => p.number)).toEqual([43]);
    expect(store.prsForMessage('C1', 'nope')).toEqual([]);
  });

  it('deletes every link carried by one deleted Slack message', () => {
    const a = store.upsertPr(ref);
    const b = store.upsertPr(other);
    store.linkMessage(a.id, 'C1', '111.1');
    store.linkMessage(b.id, 'C1', '111.1');
    store.linkMessage(b.id, 'C1', '222.2');

    expect(store.deleteMessagesByTs('C1', '111.1')).toBe(2);
    expect(store.messagesForPr(a.id)).toHaveLength(0);
    expect(store.messagesForPr(b.id)).toHaveLength(1);
  });

  it('expires PRs closed before the cutoff, along with their messages', () => {
    const stale = store.upsertPr(ref);
    const recent = store.upsertPr(other);
    store.linkMessage(stale.id, 'C1', '111.1');
    store.linkMessage(recent.id, 'C1', '222.2');
    store.recordPoll(stale.id, { state: 'merged' }, 1_000);
    store.recordPoll(recent.id, { state: 'merged' }, 9_000);

    expect(store.deleteClosedBefore(5_000)).toBe(1);
    expect(store.getPr(stale.id)).toBeUndefined();
    expect(store.getPr(recent.id)).toBeDefined();
    expect(store.counts()).toEqual({ prs: 1, messages: 1, active: 0 });
  });

  it('never expires a PR that is still open', () => {
    const pr = store.upsertPr(ref);
    store.recordPoll(pr.id, { state: 'approved' });
    expect(store.deleteClosedBefore(Date.now() + 1_000_000)).toBe(0);
    expect(store.getPr(pr.id)).toBeDefined();
  });

  it('excludes PRs with no linked messages from listActivePrs', () => {
    const linked = store.upsertPr(ref);
    const orphan = store.upsertPr(other);
    store.linkMessage(linked.id, 'C1', '111.1');
    // orphan has no messages

    expect(store.listActivePrs().map((p) => p.id)).toEqual([linked.id]);
  });

  it('deleteOrphanedPrs removes PRs with no message links', () => {
    const linked = store.upsertPr(ref);
    const orphan = store.upsertPr(other);
    store.linkMessage(linked.id, 'C1', '111.1');

    expect(store.deleteOrphanedPrs()).toBe(1);
    expect(store.getPr(orphan.id)).toBeUndefined();
    expect(store.getPr(linked.id)).toBeDefined();
  });

  it('deleteOrphanedPrs leaves PRs alone once all messages are deleted', () => {
    const pr = store.upsertPr(ref);
    store.linkMessage(pr.id, 'C1', '111.1');
    store.deleteMessagesByTs('C1', '111.1');

    expect(store.deleteOrphanedPrs()).toBe(1);
    expect(store.getPr(pr.id)).toBeUndefined();
  });

  it('finds a PR by its reference', () => {
    const pr = store.upsertPr(ref);
    expect(store.findPr(ref)?.id).toBe(pr.id);
    expect(store.findPr(other)).toBeUndefined();
  });

  describe('channel settings', () => {
    it('has no team for a channel nobody has set up', () => {
      expect(store.channelTeams('C1')).toEqual([]);
    });

    it('sets, replaces and clears a channel’s team', () => {
      store.setChannelTeams('C1', ['creator-team']);
      expect(store.channelTeams('C1')).toEqual(['creator-team']);
      expect(store.channelTeams('C2')).toEqual([]);

      store.setChannelTeams('C1', ['platform-team']);
      expect(store.channelTeams('C1')).toEqual(['platform-team']);

      store.setChannelTeams('C1', []);
      expect(store.channelTeams('C1')).toEqual([]);
    });

    it('keeps several teams in the order given', () => {
      store.setChannelTeams('C1', ['monetization-team', 'creator-team']);
      expect(store.channelTeams('C1')).toEqual(['monetization-team', 'creator-team']);
    });

    it('lists each tracked message in a channel once', () => {
      const a = store.upsertPr(ref);
      const b = store.upsertPr(other);
      store.linkMessage(a.id, 'C1', '111.1');
      store.linkMessage(b.id, 'C1', '111.1');
      store.linkMessage(a.id, 'C1', '222.2');
      store.linkMessage(a.id, 'C2', '333.3');

      expect(store.messageTsInChannel('C1').sort()).toEqual(['111.1', '222.2']);
    });
  });
});
