import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { SubscriptionManager } from '../connection/SubscriptionManager';
import type { PutEventMessage, PatchEventMessage } from '../protocol/messages';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = Mock<(...args: any[]) => any>;

describe('SubscriptionManager', () => {
  let manager: SubscriptionManager;
  let mockSendSubscribe: AnyMock;
  let mockSendUnsubscribe: AnyMock;
  let mockCreateSnapshot: AnyMock;

  beforeEach(() => {
    manager = new SubscriptionManager();
    mockSendSubscribe = vi.fn().mockResolvedValue(undefined);
    mockSendUnsubscribe = vi.fn().mockResolvedValue(undefined);
    mockCreateSnapshot = vi.fn((path, value, volatile) => ({
      val: () => value,
      path,
      volatile,
    }));

    manager.initialize({
      sendSubscribe: mockSendSubscribe,
      sendUnsubscribe: mockSendUnsubscribe,
      createSnapshot: mockCreateSnapshot,
    });
  });

  describe('isPathCovered()', () => {
    it('returns false when no subscriptions exist', () => {
      expect(manager.isPathCovered('/users')).toBe(false);
    });

    it('returns true for exact path with value subscription and data', () => {
      manager.subscribe('/users', 'value', vi.fn());
      // Send initial snapshot to populate the View
      manager.handleEvent({ ev: 'put', sp: '/users', p: '/', v: { alice: 1 } });

      expect(manager.isPathCovered('/users')).toBe(true);
    });

    it('returns true for child path when parent has value subscription and data', () => {
      manager.subscribe('/users', 'value', vi.fn());
      // Send initial snapshot to populate the View
      manager.handleEvent({ ev: 'put', sp: '/users', p: '/', v: { alice: { profile: {} } } });

      expect(manager.isPathCovered('/users/alice')).toBe(true);
      expect(manager.isPathCovered('/users/alice/profile')).toBe(true);
    });

    it('returns true for child_added subscription with data', () => {
      manager.subscribe('/users', 'child_added', vi.fn());
      // child_added also receives initial snapshot
      manager.handleEvent({ ev: 'put', sp: '/users', p: '/', v: { alice: 1 } });

      // With data, path is covered
      expect(manager.isPathCovered('/users')).toBe(true);
      expect(manager.isPathCovered('/users/alice')).toBe(true);
    });

    it('returns false for parent path when only child is subscribed', () => {
      manager.subscribe('/users/alice', 'value', vi.fn());
      // Send initial snapshot to child subscription
      manager.handleEvent({ ev: 'put', sp: '/users/alice', p: '/', v: { name: 'Alice' } });

      expect(manager.isPathCovered('/users/alice')).toBe(true);
      expect(manager.isPathCovered('/users')).toBe(false); // Parent not covered
    });

    it('returns true when root is subscribed with data', () => {
      manager.subscribe('/', 'value', vi.fn());
      // Send initial snapshot to root
      manager.handleEvent({ ev: 'put', sp: '/', p: '/', v: { users: { alice: { profile: {} } } } });

      expect(manager.isPathCovered('/')).toBe(true);
      expect(manager.isPathCovered('/users')).toBe(true);
      expect(manager.isPathCovered('/users/alice/profile')).toBe(true);
    });

    it('returns false after unsubscribing', () => {
      const unsub = manager.subscribe('/users', 'value', vi.fn());
      // Send initial snapshot
      manager.handleEvent({ ev: 'put', sp: '/users', p: '/', v: { alice: 1 } });
      expect(manager.isPathCovered('/users')).toBe(true);

      unsub();
      expect(manager.isPathCovered('/users')).toBe(false);
    });
  });

  describe('cache population with put events', () => {
    it('caches full snapshot from put event with path "/"', () => {
      const callback = vi.fn();
      manager.subscribe('/boxes', 'value', callback);

      // Simulate server sending put event with full snapshot
      const event: PutEventMessage = {
        ev: 'put',
        sp: '/boxes', // subscription path
        p: '/', // relative path - "/" means full snapshot
        v: { 0: true, 1: false, 2: true },
      };
      manager.handleEvent(event);

      // Should be able to get cached value
      const cached = manager.getCachedValue('/boxes');
      expect(cached.found).toBe(true);
      expect(cached.value).toEqual({ 0: true, 1: false, 2: true });
    });

    it('caches child values and can extract them', () => {
      const callback = vi.fn();
      manager.subscribe('/boxes', 'value', callback);

      // Simulate server sending put event with full snapshot
      const event: PutEventMessage = {
        ev: 'put',
        sp: '/boxes',
        p: '/',
        v: { 0: true, 1: false, 2: true },
      };
      manager.handleEvent(event);

      // Should be able to extract child values
      const cached = manager.getCachedValue('/boxes/1');
      expect(cached.found).toBe(true);
      expect(cached.value).toBe(false);
    });

    it('updates cache on delta put events', () => {
      const callback = vi.fn();
      manager.subscribe('/boxes', 'value', callback);

      // First, populate with initial value
      manager.handleEvent({
        ev: 'put',
        sp: '/boxes',
        p: '/',
        v: { 0: true },
      } as PutEventMessage);

      // Then receive delta update for new child
      manager.handleEvent({
        ev: 'put',
        sp: '/boxes',
        p: '/1', // relative path to new child
        v: false,
      } as PutEventMessage);

      // Cache should include new child
      const boxes = manager.getCachedValue('/boxes');
      expect(boxes.value).toEqual({ 0: true, 1: false });
    });

    it('updates cache on delta put events for nested paths', () => {
      const callback = vi.fn();
      manager.subscribe('/boxes', 'value', callback);

      // First, populate with initial value
      manager.handleEvent({
        ev: 'put',
        sp: '/boxes',
        p: '/',
        v: { 0: { value: true }, 1: { value: false } },
      } as PutEventMessage);

      // Then receive delta update for nested value
      manager.handleEvent({
        ev: 'put',
        sp: '/boxes',
        p: '/1/value',
        v: true,
      } as PutEventMessage);

      // Cache should reflect change
      const cached = manager.getCachedValue('/boxes/1/value');
      expect(cached.value).toBe(true);
    });

    it('handles deletion via put event with null value', () => {
      const callback = vi.fn();
      manager.subscribe('/boxes', 'value', callback);

      // First, populate with initial value
      manager.handleEvent({
        ev: 'put',
        sp: '/boxes',
        p: '/',
        v: { 0: true, 1: false, 2: true },
      } as PutEventMessage);

      // Then receive deletion
      manager.handleEvent({
        ev: 'put',
        sp: '/boxes',
        p: '/1',
        v: null, // null means delete
      } as PutEventMessage);

      // Cache should no longer have the removed child
      const boxes = manager.getCachedValue('/boxes').value as Record<string, boolean>;
      expect(boxes).toEqual({ 0: true, 2: true });
      expect('1' in boxes).toBe(false);
    });
  });

  describe('cache population with patch events', () => {
    it('applies multiple updates from patch event', () => {
      const callback = vi.fn();
      manager.subscribe('/users', 'value', callback);

      // First, populate with initial value
      manager.handleEvent({
        ev: 'put',
        sp: '/users',
        p: '/',
        v: { alice: { score: 0 }, bob: { score: 0 } },
      } as PutEventMessage);

      // Then receive patch with multiple updates
      manager.handleEvent({
        ev: 'patch',
        sp: '/users',
        p: '/',
        v: { 'alice/score': 100, 'bob/score': 200 },
      } as PatchEventMessage);

      // Cache should reflect all changes
      const alice = manager.getCachedValue('/users/alice/score');
      expect(alice.value).toBe(100);

      const bob = manager.getCachedValue('/users/bob/score');
      expect(bob.value).toBe(200);
    });
  });

  describe('getCachedValue()', () => {
    it('returns found: false when path is not covered', () => {
      const result = manager.getCachedValue('/users');
      expect(result.found).toBe(false);
    });

    it('returns found: false when covered but no data yet', () => {
      manager.subscribe('/users', 'value', vi.fn());

      // Subscribed but no event received yet
      const result = manager.getCachedValue('/users');
      expect(result.found).toBe(false);
    });

    it('returns cached value when covered and data exists', () => {
      manager.subscribe('/users', 'value', vi.fn());

      manager.handleEvent({
        ev: 'put',
        sp: '/users',
        p: '/',
        v: { alice: { name: 'Alice' } },
      } as PutEventMessage);

      const result = manager.getCachedValue('/users');
      expect(result.found).toBe(true);
      expect(result.value).toEqual({ alice: { name: 'Alice' } });
    });

    it('extracts child value from parent cache', () => {
      manager.subscribe('/users', 'value', vi.fn());

      manager.handleEvent({
        ev: 'put',
        sp: '/users',
        p: '/',
        v: { alice: { name: 'Alice' }, bob: { name: 'Bob' } },
      } as PutEventMessage);

      const result = manager.getCachedValue('/users/alice/name');
      expect(result.found).toBe(true);
      expect(result.value).toBe('Alice');
    });
  });

  describe('cache clearing', () => {
    it('clears cache on clear()', () => {
      manager.subscribe('/users', 'value', vi.fn());

      manager.handleEvent({
        ev: 'put',
        sp: '/users',
        p: '/',
        v: { alice: 1 },
      } as PutEventMessage);

      expect(manager.cacheSize).toBe(1);

      manager.clear();

      expect(manager.cacheSize).toBe(0);
    });
  });

  describe('callback invocation', () => {
    it('calls value callback with full snapshot on put event', () => {
      const callback = vi.fn();
      manager.subscribe('/boxes', 'value', callback);

      manager.handleEvent({
        ev: 'put',
        sp: '/boxes',
        p: '/',
        v: { 0: true },
      } as PutEventMessage);

      expect(callback).toHaveBeenCalledTimes(1);
      // value events now include orderedKeys (5th arg) for correct forEach iteration
      expect(mockCreateSnapshot).toHaveBeenCalledWith('/boxes', { 0: true }, false, undefined, ['0']);
    });

    it('generates child_added event when new child appears', () => {
      const valueCallback = vi.fn();
      const childAddedCallback = vi.fn();
      manager.subscribe('/boxes', 'value', valueCallback);
      manager.subscribe('/boxes', 'child_added', childAddedCallback);

      // Initial snapshot
      manager.handleEvent({
        ev: 'put',
        sp: '/boxes',
        p: '/',
        v: { 0: true },
      } as PutEventMessage);

      // Initial load fires child_added for existing children
      expect(childAddedCallback).toHaveBeenCalledTimes(1);

      // Add new child
      manager.handleEvent({
        ev: 'put',
        sp: '/boxes',
        p: '/1',
        v: false,
      } as PutEventMessage);

      // child_added should fire for new child
      expect(childAddedCallback).toHaveBeenCalledTimes(2);
    });

    it('generates child_changed event when existing child changes', () => {
      const childChangedCallback = vi.fn();
      manager.subscribe('/boxes', 'value', vi.fn());
      manager.subscribe('/boxes', 'child_changed', childChangedCallback);

      // Initial snapshot
      manager.handleEvent({
        ev: 'put',
        sp: '/boxes',
        p: '/',
        v: { 0: true, 1: false },
      } as PutEventMessage);

      // Change existing child
      manager.handleEvent({
        ev: 'put',
        sp: '/boxes',
        p: '/1',
        v: true,
      } as PutEventMessage);

      expect(childChangedCallback).toHaveBeenCalledTimes(1);
    });

    it('generates child_removed event when child is deleted', () => {
      const childRemovedCallback = vi.fn();
      manager.subscribe('/boxes', 'value', vi.fn());
      manager.subscribe('/boxes', 'child_removed', childRemovedCallback);

      // Initial snapshot
      manager.handleEvent({
        ev: 'put',
        sp: '/boxes',
        p: '/',
        v: { 0: true, 1: false },
      } as PutEventMessage);

      // Delete child
      manager.handleEvent({
        ev: 'put',
        sp: '/boxes',
        p: '/1',
        v: null,
      } as PutEventMessage);

      expect(childRemovedCallback).toHaveBeenCalledTimes(1);
    });

    it('passes volatile flag and server timestamp on volatile events', () => {
      const callback = vi.fn();
      manager.subscribe('/players/abc/pos', 'value', callback);

      const ts = 1703350200123;
      manager.handleEvent({
        ev: 'put',
        sp: '/players/abc/pos',
        p: '/',
        v: { x: 1, y: 2, z: 3 },
        x: true,
        ts,
      } as PutEventMessage);

      expect(callback).toHaveBeenCalledTimes(1);
      // value events now include orderedKeys (5th arg) for correct forEach iteration
      expect(mockCreateSnapshot).toHaveBeenCalledWith(
        '/players/abc/pos',
        { x: 1, y: 2, z: 3 },
        true,
        ts,
        ['x', 'y', 'z']
      );
    });
  });

  describe('query params', () => {
    it('passes query params to sendSubscribe', () => {
      const callback = vi.fn();
      const queryParams = { orderBy: 'key' as const, limitToFirst: 10 };

      // Using default queryIdentifier (no tag)
      manager.subscribe('/items', 'value', callback, queryParams);

      // No event types in new protocol - just path, queryParams, tag
      expect(mockSendSubscribe).toHaveBeenCalledWith('/items', queryParams, undefined);
    });

    it('adding new event type callback does not re-send subscribe', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      const queryParams = { orderBy: 'key' as const, limitToFirst: 10 };

      manager.subscribe('/items', 'value', callback1, queryParams);
      mockSendSubscribe.mockClear();

      // Adding a new callback type to existing view with SAME queryParams should NOT re-send
      // (server sends all data changes, client filters locally)
      manager.subscribe('/items', 'child_added', callback2, queryParams);

      expect(mockSendSubscribe).not.toHaveBeenCalled();
    });

    it('updates queryParams when new subscription has different params', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      const queryParams1 = { orderBy: 'key' as const, limitToFirst: 10 };
      const queryParams2 = { orderBy: 'child' as const, orderByChild: 'score' };

      manager.subscribe('/items', 'value', callback1, queryParams1);
      manager.subscribe('/items', 'child_added', callback2, queryParams2);

      // Second subscribe with different queryParams updates them
      expect(mockSendSubscribe).toHaveBeenLastCalledWith('/items', queryParams2, undefined);
    });

    it('does not re-send if queryParams are the same', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      const queryParams = { orderBy: 'key' as const, limitToFirst: 10 };

      manager.subscribe('/items', 'value', callback1, queryParams);
      mockSendSubscribe.mockClear();

      // Same query params - should not re-send
      manager.subscribe('/items', 'value', callback2, queryParams);

      expect(mockSendSubscribe).not.toHaveBeenCalled();
    });
  });
});
