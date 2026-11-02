/**
 * Tests for SubscriptionManager multi-view support.
 *
 * Verifies that multiple queries on the same path get separate Views,
 * and events are dispatched to all Views at a path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { SubscriptionManager } from '../connection/SubscriptionManager';
import { DataSnapshot } from '../DataSnapshot';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = Mock<(...args: any[]) => any>;

// Helper to create a mock snapshot factory
function createMockSnapshotFactory() {
  return (path: string, value: unknown) => {
    return {
      val: () => value,
      key: path.split('/').pop() || null,
      ref: { path },
      exists: () => value !== null,
    } as unknown as DataSnapshot;
  };
}

describe('SubscriptionManager multi-view support', () => {
  let manager: SubscriptionManager;
  let sendSubscribe: AnyMock;
  let sendUnsubscribe: AnyMock;
  let createSnapshot: AnyMock;

  beforeEach(() => {
    manager = new SubscriptionManager();
    sendSubscribe = vi.fn().mockResolvedValue(undefined);
    sendUnsubscribe = vi.fn().mockResolvedValue(undefined);
    createSnapshot = vi.fn(createMockSnapshotFactory());

    manager.initialize({
      sendSubscribe,
      sendUnsubscribe,
      createSnapshot,
    });
  });

  describe('subscribe with queryIdentifier', () => {
    it('creates separate Views for different queryIdentifiers on same path', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      // Subscribe with two different query identifiers on same path
      manager.subscribe('/users', 'value', callback1, { startAt: 'a', endAt: 'm' }, 'query1');
      manager.subscribe('/users', 'value', callback2, { startAt: 'n', endAt: 'z' }, 'query2');

      // Both should create separate subscriptions
      expect(sendSubscribe).toHaveBeenCalledTimes(2);

      // hasSubscriptions should return true
      expect(manager.hasSubscriptions('/users')).toBe(true);
    });

    it('same queryIdentifier reuses existing View', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      // Subscribe twice with same query identifier
      manager.subscribe('/users', 'value', callback1, { startAt: 'a' }, 'query1');
      manager.subscribe('/users', 'child_added', callback2, { startAt: 'a' }, 'query1');

      // Should only send one subscribe (first creates View, second adds callback locally)
      // Server sends all data changes, so no need to re-subscribe for new event types
      expect(sendSubscribe).toHaveBeenCalledTimes(1);
    });

    it('default queryIdentifier is used when not provided', () => {
      const callback = vi.fn();

      manager.subscribe('/users', 'value', callback, undefined, undefined);

      // Should work and use 'default' as the queryIdentifier
      expect(sendSubscribe).toHaveBeenCalledTimes(1);
      expect(manager.hasSubscriptions('/users')).toBe(true);
    });
  });

  describe('event dispatch with tag-based routing', () => {
    it('put event with tag routes to specific View', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      // Create two Views at same path with different query identifiers
      // First non-default query gets tag 1, second gets tag 2
      manager.subscribe('/users', 'value', callback1, { startAt: 'a' }, 'query1');
      manager.subscribe('/users', 'value', callback2, { startAt: 'b' }, 'query2');

      // Server sends tagged event for query1 (tag 1)
      manager.handleEvent({
        ev: 'put',
        sp: '/users',
        p: '/',
        v: { alice: 1 },
        tag: 1,
      });

      // Only callback1 should be called
      expect(callback1).toHaveBeenCalled();
      expect(callback2).not.toHaveBeenCalled();

      callback1.mockClear();

      // Server sends tagged event for query2 (tag 2)
      manager.handleEvent({
        ev: 'put',
        sp: '/users',
        p: '/',
        v: { bob: 2 },
        tag: 2,
      });

      // Only callback2 should be called
      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
    });

    it('patch event with tag routes to specific View', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      // Create two Views with different query identifiers (using orderByKey to avoid priority filtering)
      manager.subscribe('/users', 'value', callback1, { orderBy: 'key' }, 'query1');
      manager.subscribe('/users', 'value', callback2, { orderBy: 'key' }, 'query2');

      // Send initial data to each View (with tags)
      manager.handleEvent({ ev: 'put', sp: '/users', p: '/', v: { alice: 1 }, tag: 1 });
      manager.handleEvent({ ev: 'put', sp: '/users', p: '/', v: { bob: 1 }, tag: 2 });

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);

      callback1.mockClear();
      callback2.mockClear();

      // Patch event for query1 only
      manager.handleEvent({
        ev: 'patch',
        sp: '/users',
        p: '/',
        v: { alice: 2 },
        tag: 1,
      });

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).not.toHaveBeenCalled();
    });

    it('untagged put event routes to default View', () => {
      const defaultCallback = vi.fn();
      const queryCallback = vi.fn();

      // Create default View and a query View
      manager.subscribe('/users', 'value', defaultCallback, undefined, 'default');
      manager.subscribe('/users', 'value', queryCallback, { startAt: 'a' }, 'query1');

      // Untagged event goes to default View
      manager.handleEvent({
        ev: 'put',
        sp: '/users',
        p: '/',
        v: { alice: 1 },
      });

      expect(defaultCallback).toHaveBeenCalled();
      expect(queryCallback).not.toHaveBeenCalled();
    });

    it('volatile patch events are routed to tagged Views', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      // Create two Views with query params (so they get tags)
      // tag 1 for query1, tag 2 for query2
      manager.subscribe('/users', 'value', callback1, { orderBy: 'key' }, 'query1');
      manager.subscribe('/users', 'value', callback2, { orderBy: 'key' }, 'query2');

      // Send initial data to both Views via their tags
      manager.handleEvent({
        ev: 'put',
        sp: '/users',
        p: '/',
        v: { alice: 1 },
        tag: 1,
      });
      manager.handleEvent({
        ev: 'put',
        sp: '/users',
        p: '/',
        v: { alice: 1 },
        tag: 2,
      });

      callback1.mockClear();
      callback2.mockClear();

      // Volatile patch events are now sent per-subscription with tags
      // Server sends separate patch events to each subscribed View
      manager.handleEvent({
        ev: 'patch',
        sp: '/users',
        p: '/',
        v: { '/bob': 2 },
        x: true,
        ts: Date.now(),
        tag: 1,
      });
      manager.handleEvent({
        ev: 'patch',
        sp: '/users',
        p: '/',
        v: { '/bob': 2 },
        x: true,
        ts: Date.now(),
        tag: 2,
      });

      // Both callbacks should be called (each gets its own tagged event)
      expect(callback1).toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
    });
  });

  describe('unsubscribe with queryIdentifier', () => {
    it('unsubscribing one View does not affect other Views at same path', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      // Create two Views with query params (so they get tags)
      // query1 gets tag 1, query2 gets tag 2
      const unsub1 = manager.subscribe('/users', 'value', callback1, { orderBy: 'key' }, 'query1');
      manager.subscribe('/users', 'value', callback2, { orderBy: 'key' }, 'query2');

      // Unsubscribe first View
      unsub1();

      // Send tagged event for query2 (tag 2)
      manager.handleEvent({
        ev: 'put',
        sp: '/users',
        p: '/',
        v: { alice: 1 },
        tag: 2,
      });

      // Only second callback should be called
      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
    });

    it('unsubscribeAll removes all Views at a path', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      // Create two Views
      manager.subscribe('/users', 'value', callback1, undefined, 'query1');
      manager.subscribe('/users', 'value', callback2, undefined, 'query2');

      // Unsubscribe all
      manager.unsubscribeAll('/users');

      // No more subscriptions at this path
      expect(manager.hasSubscriptions('/users')).toBe(false);

      // Send event - no callbacks should be called
      manager.handleEvent({
        ev: 'put',
        sp: '/users',
        p: '/',
        v: { alice: 1 },
      });

      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).not.toHaveBeenCalled();
    });

    it('sends unsubscribe for each View when removed (with its queryParams and tag)', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      const queryParams1 = { orderBy: 'key' as const, startAt: 'a' };
      const queryParams2 = { orderBy: 'key' as const, startAt: 'b' };

      // Create two Views with different query params
      // query1 gets tag 1, query2 gets tag 2
      const unsub1 = manager.subscribe('/users', 'value', callback1, queryParams1, 'query1');
      const unsub2 = manager.subscribe('/users', 'value', callback2, queryParams2, 'query2');

      sendUnsubscribe.mockClear();

      // Unsubscribe first - should send unsubscribe with first View's queryParams and tag
      unsub1();
      expect(sendUnsubscribe).toHaveBeenCalledTimes(1);
      expect(sendUnsubscribe).toHaveBeenCalledWith('/users', queryParams1, 1);

      sendUnsubscribe.mockClear();

      // Unsubscribe second - should send unsubscribe with second View's queryParams and tag
      unsub2();
      expect(sendUnsubscribe).toHaveBeenCalledTimes(1);
      expect(sendUnsubscribe).toHaveBeenCalledWith('/users', queryParams2, 2);
    });
  });

  describe('getView', () => {
    it('returns View with default queryIdentifier first', () => {
      const callback = vi.fn();

      // Create a View with default queryIdentifier
      manager.subscribe('/users', 'value', callback, undefined, 'default');

      const view = manager.getView('/users');
      expect(view).toBeDefined();
      expect(view?.path).toBe('/users');
    });

    it('returns any View if default does not exist', () => {
      const callback = vi.fn();

      // Create a View with non-default queryIdentifier
      manager.subscribe('/users', 'value', callback, { startAt: 'a' }, 'custom-query');

      const view = manager.getView('/users');
      expect(view).toBeDefined();
      expect(view?.path).toBe('/users');
    });

    it('returns undefined if no Views at path', () => {
      const view = manager.getView('/users');
      expect(view).toBeUndefined();
    });
  });

  describe('getActiveSubscriptions', () => {
    it('returns all Views including those with different queryIdentifiers', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      manager.subscribe('/users', 'value', callback1, { startAt: 'a' }, 'query1');
      manager.subscribe('/users', 'value', callback2, { startAt: 'b' }, 'query2');
      manager.subscribe('/posts', 'value', callback1, undefined, 'default');

      const subs = manager.getActiveSubscriptions();
      expect(subs).toHaveLength(3);

      // All should have path '/users' or '/posts'
      const paths = subs.map((s) => s.path);
      expect(paths.filter((p) => p === '/users')).toHaveLength(2);
      expect(paths.filter((p) => p === '/posts')).toHaveLength(1);
    });
  });

  describe('clear', () => {
    it('clears all Views across all queryIdentifiers', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      manager.subscribe('/users', 'value', callback1, undefined, 'query1');
      manager.subscribe('/users', 'value', callback2, undefined, 'query2');
      manager.subscribe('/posts', 'value', callback1, undefined, 'default');

      manager.clear();

      expect(manager.hasSubscriptions('/users')).toBe(false);
      expect(manager.hasSubscriptions('/posts')).toBe(false);
      expect(manager.cacheSize).toBe(0);
    });
  });

  describe('resubscribeAll', () => {
    it('resubscribes all Views with their respective paths', async () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      manager.subscribe('/users', 'value', callback1, { startAt: 'a' }, 'query1');
      manager.subscribe('/users', 'value', callback2, { startAt: 'b' }, 'query2');

      sendSubscribe.mockClear();

      await manager.resubscribeAll();

      // Both Views should be resubscribed
      expect(sendSubscribe).toHaveBeenCalledTimes(2);

      // Both should use the same path (no event types in new protocol)
      expect(sendSubscribe).toHaveBeenCalledWith('/users', expect.any(Object));
    });
  });

  describe('client-side filtering', () => {
    it('each View applies its own query filtering to data', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      // Create two Views with different range queries (by priority)
      // Query 1: startAt 'b', endAt 'c' - should include bob, carol
      // Query 2: startAt 'a', endAt 'b' - should include alice, bob
      manager.subscribe('/users', 'value', callback1, { startAt: 'b', endAt: 'c' }, 'query1');
      manager.subscribe('/users', 'value', callback2, { startAt: 'a', endAt: 'b' }, 'query2');

      const fullData = {
        alice: { '.value': 1, '.priority': 'a' },
        bob: { '.value': 2, '.priority': 'b' },
        carol: { '.value': 3, '.priority': 'c' },
        dave: { '.value': 4, '.priority': 'd' },
      };

      // Server sends tagged events to each View with potentially different data
      // (In practice, server may filter before sending, but client also filters locally)
      // query1 (tag 1) gets the full data, filters to bob, carol
      manager.handleEvent({
        ev: 'put',
        sp: '/users',
        p: '/',
        v: fullData,
        tag: 1,
      });

      // query2 (tag 2) gets the full data, filters to alice, bob
      manager.handleEvent({
        ev: 'put',
        sp: '/users',
        p: '/',
        v: fullData,
        tag: 2,
      });

      // Both callbacks should be called
      expect(callback1).toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();

      // Verify client-side filtering was applied
      // callback1 should receive filtered data matching startAt 'b', endAt 'c'
      const snap1 = callback1.mock.calls[0][0];
      const data1 = snap1.val();
      expect(data1).toHaveProperty('bob');
      expect(data1).toHaveProperty('carol');
      expect(data1).not.toHaveProperty('alice');
      expect(data1).not.toHaveProperty('dave');

      // callback2 should receive filtered data matching startAt 'a', endAt 'b'
      const snap2 = callback2.mock.calls[0][0];
      const data2 = snap2.val();
      expect(data2).toHaveProperty('alice');
      expect(data2).toHaveProperty('bob');
      expect(data2).not.toHaveProperty('carol');
      expect(data2).not.toHaveProperty('dave');
    });
  });
});
