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
    const first = store.upsertPr(ref, 2);
    const second = store.upsertPr(ref, 2);
    expect(second.id).toBe(first.id);
    expect(first.state).toBe('no_reviews');
    expect(store.counts().prs).toBe(1);
  });

  it('refreshes requiredApprovals on re-upsert so config changes take effect', () => {
    store.upsertPr(ref, 2);
    expect(store.upsertPr(ref, 3).requiredApprovals).toBe(3);
  });

  it('links many messages to one PR without duplicating rows', () => {
    const pr = store.upsertPr(ref, 2);
    const a = store.linkMessage(pr.id, 'C1', '111.1');
    const b = store.linkMessage(pr.id, 'C1', '222.2');
    const again = store.linkMessage(pr.id, 'C1', '111.1');

    expect(again.id).toBe(a.id);
    expect(a.id).not.toBe(b.id);
    expect(store.messagesForPr(pr.id)).toHaveLength(2);
  });

  it('treats the same timestamp in different channels as different messages', () => {
    const pr = store.upsertPr(ref, 2);
    store.linkMessage(pr.id, 'C1', '111.1');
    store.linkMessage(pr.id, 'C2', '111.1');
    expect(store.messagesForPr(pr.id)).toHaveLength(2);
  });

  it('lists only non-terminal PRs as active', () => {
    const open = store.upsertPr(ref, 2);
    const done = store.upsertPr(other, 2);
    store.recordPoll(done.id, { state: 'merged', approvals: 2, requiredApprovals: 2 });

    const active = store.listActivePrs();
    expect(active.map((p) => p.id)).toEqual([open.id]);
  });

  it('stamps closedAt when a PR first goes terminal and keeps it stable', () => {
    const pr = store.upsertPr(ref, 2);
    const merged = store.recordPoll(
      pr.id,
      { state: 'merged', approvals: 2, requiredApprovals: 2 },
      1_000,
    );
    expect(merged?.closedAt).toBe(1_000);

    const again = store.recordPoll(
      pr.id,
      { state: 'merged', approvals: 2, requiredApprovals: 2 },
      9_000,
    );
    expect(again?.closedAt).toBe(1_000);
    expect(again?.lastPolledAt).toBe(9_000);
  });

  it('clears closedAt if a PR is reopened', () => {
    const pr = store.upsertPr(ref, 2);
    store.recordPoll(pr.id, { state: 'closed', approvals: 0, requiredApprovals: 2 }, 1_000);
    const reopened = store.recordPoll(
      pr.id,
      { state: 'no_reviews', approvals: 0, requiredApprovals: 2 },
      2_000,
    );
    expect(reopened?.closedAt).toBeNull();
    expect(store.listActivePrs()).toHaveLength(1);
  });

  it('tracks the reaction currently on a message', () => {
    const pr = store.upsertPr(ref, 2);
    const message = store.linkMessage(pr.id, 'C1', '111.1');
    expect(message.currentReaction).toBeNull();
    expect(store.messageReaction('C1', '111.1')).toBeNull();

    store.setMessageReaction('C1', '111.1', '1of2');
    expect(store.messageReaction('C1', '111.1')).toBe('1of2');

    store.setMessageReaction('C1', '111.1', null);
    expect(store.messageReaction('C1', '111.1')).toBeNull();
  });

  it('keeps the reaction consistent across every PR linked in a message', () => {
    const a = store.upsertPr(ref, 2);
    const b = store.upsertPr(other, 2);
    store.linkMessage(a.id, 'C1', '111.1');
    store.linkMessage(b.id, 'C1', '111.1');

    store.setMessageReaction('C1', '111.1', '1of2');

    expect(store.messagesForPr(a.id)[0]?.currentReaction).toBe('1of2');
    expect(store.messagesForPr(b.id)[0]?.currentReaction).toBe('1of2');
  });

  it('reports an existing reaction even when a newly linked PR row is still null', () => {
    const a = store.upsertPr(ref, 2);
    store.linkMessage(a.id, 'C1', '111.1');
    store.setMessageReaction('C1', '111.1', 'white_check_mark');

    // A second PR link posted onto the same message starts with a null row.
    const b = store.upsertPr(other, 2);
    store.linkMessage(b.id, 'C1', '111.1');

    expect(store.messageReaction('C1', '111.1')).toBe('white_check_mark');
  });

  it('lists every PR linked in a message', () => {
    const a = store.upsertPr(ref, 2);
    const b = store.upsertPr(other, 2);
    store.linkMessage(a.id, 'C1', '111.1');
    store.linkMessage(b.id, 'C1', '111.1');
    store.linkMessage(b.id, 'C1', '222.2');

    expect(store.prsForMessage('C1', '111.1').map((p) => p.number).sort()).toEqual([42, 43]);
    expect(store.prsForMessage('C1', '222.2').map((p) => p.number)).toEqual([43]);
    expect(store.prsForMessage('C1', 'nope')).toEqual([]);
  });

  it('deletes every link carried by one deleted Slack message', () => {
    const a = store.upsertPr(ref, 2);
    const b = store.upsertPr(other, 2);
    store.linkMessage(a.id, 'C1', '111.1');
    store.linkMessage(b.id, 'C1', '111.1');
    store.linkMessage(b.id, 'C1', '222.2');

    expect(store.deleteMessagesByTs('C1', '111.1')).toBe(2);
    expect(store.messagesForPr(a.id)).toHaveLength(0);
    expect(store.messagesForPr(b.id)).toHaveLength(1);
  });

  it('expires PRs closed before the cutoff, along with their messages', () => {
    const stale = store.upsertPr(ref, 2);
    const recent = store.upsertPr(other, 2);
    store.linkMessage(stale.id, 'C1', '111.1');
    store.linkMessage(recent.id, 'C1', '222.2');
    store.recordPoll(stale.id, { state: 'merged', approvals: 2, requiredApprovals: 2 }, 1_000);
    store.recordPoll(recent.id, { state: 'merged', approvals: 2, requiredApprovals: 2 }, 9_000);

    expect(store.deleteClosedBefore(5_000)).toBe(1);
    expect(store.getPr(stale.id)).toBeUndefined();
    expect(store.getPr(recent.id)).toBeDefined();
    expect(store.counts()).toEqual({ prs: 1, messages: 1, active: 0 });
  });

  it('never expires a PR that is still open', () => {
    const pr = store.upsertPr(ref, 2);
    store.recordPoll(pr.id, { state: 'approved', approvals: 2, requiredApprovals: 2 });
    expect(store.deleteClosedBefore(Date.now() + 1_000_000)).toBe(0);
    expect(store.getPr(pr.id)).toBeDefined();
  });

  it('finds a PR by its reference', () => {
    const pr = store.upsertPr(ref, 2);
    expect(store.findPr(ref)?.id).toBe(pr.id);
    expect(store.findPr(other)).toBeUndefined();
  });

  describe('messageRequiredTeams', () => {
    it('returns empty array when no team has been set', () => {
      const pr = store.upsertPr(ref, 2);
      store.linkMessage(pr.id, 'C1', '111.1');
      expect(store.messageRequiredTeams('C1', '111.1')).toEqual([]);
    });

    it('stores and returns a single-team array', () => {
      const pr = store.upsertPr(ref, 2);
      store.linkMessage(pr.id, 'C1', '111.1');
      store.setMessageRequiredTeams('C1', '111.1', ['creator-team']);
      expect(store.messageRequiredTeams('C1', '111.1')).toEqual(['creator-team']);
    });

    it('stores and returns multiple teams', () => {
      const pr = store.upsertPr(ref, 2);
      store.linkMessage(pr.id, 'C1', '111.1');
      store.setMessageRequiredTeams('C1', '111.1', ['creator-team', 'platform-team']);
      expect(store.messageRequiredTeams('C1', '111.1')).toEqual(['creator-team', 'platform-team']);
    });

    it('setMessageRequiredTeams overwrites existing teams', () => {
      const pr = store.upsertPr(ref, 2);
      store.linkMessage(pr.id, 'C1', '111.1');
      store.setMessageRequiredTeams('C1', '111.1', ['creator-team']);
      store.setMessageRequiredTeams('C1', '111.1', ['platform-team', 'design-team']);
      expect(store.messageRequiredTeams('C1', '111.1')).toEqual(['platform-team', 'design-team']);
    });

    it('initMessageRequiredTeams does not overwrite an existing value', () => {
      const pr = store.upsertPr(ref, 2);
      store.linkMessage(pr.id, 'C1', '111.1');
      store.setMessageRequiredTeams('C1', '111.1', ['creator-team']);
      store.initMessageRequiredTeams('C1', '111.1', ['platform-team']);
      expect(store.messageRequiredTeams('C1', '111.1')).toEqual(['creator-team']);
    });

    it('initMessageRequiredTeams writes when no value exists yet', () => {
      const pr = store.upsertPr(ref, 2);
      store.linkMessage(pr.id, 'C1', '111.1');
      store.initMessageRequiredTeams('C1', '111.1', ['creator-team']);
      expect(store.messageRequiredTeams('C1', '111.1')).toEqual(['creator-team']);
    });
  });
});
