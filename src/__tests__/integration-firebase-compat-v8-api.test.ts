// @ts-nocheck
/**
 * Firebase v8 API Compatibility Tests
 *
 * These tests verify the Firebase v8-style API behavior provided by @lark-sh/client/fb-v8:
 * - on() returns the callback function (not an unsubscribe function)
 * - off(eventType, callback) removes specific listeners by callback reference
 * - once(eventType, successCallback, cancelCallback) callback style
 *
 * Tests that require context parameter support (on(type, cb, context)) are marked as TODO
 * until that feature is implemented.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LarkDatabase, DatabaseReference, DataSnapshot } from '../fb-v8';

const TEST_DATABASE = 'javascript-integration/test';
const WRITE_DELAY = 350;

let db: LarkDatabase;

function getRandomNode(): DatabaseReference {
  const pushId = db.ref().push().key!;
  return db.ref(`test/${pushId}`);
}

async function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Event accumulator helper for async tests
class EventAccumulator<T = DataSnapshot> {
  private events: T[] = [];
  private resolvers: Array<(events: T[]) => void> = [];
  private targetCount: number;

  constructor(count: number = 1) {
    this.targetCount = count;
  }

  addEvent(event?: T) {
    this.events.push(event as T);
    this.checkResolve();
  }

  private checkResolve() {
    if (this.events.length >= this.targetCount) {
      this.resolvers.forEach(resolve => resolve(this.events));
      this.resolvers = [];
    }
  }

  get promise(): Promise<T[]> {
    if (this.events.length >= this.targetCount) {
      return Promise.resolve(this.events);
    }
    return new Promise(resolve => {
      this.resolvers.push(resolve);
    });
  }

  get count(): number {
    return this.events.length;
  }
}

const EventAccumulatorFactory = {
  waitsForCount<T = DataSnapshot>(count: number): EventAccumulator<T> {
    return new EventAccumulator<T>(count);
  },
  waitsForExactCount<T = DataSnapshot>(count: number): EventAccumulator<T> {
    return new EventAccumulator<T>(count);
  }
};

describe('Firebase v8 API Compatibility', () => {
  beforeAll(async () => {
    db = new LarkDatabase(TEST_DATABASE, { anonymous: true });
    await db.connect(TEST_DATABASE, { anonymous: true });
  });

  afterAll(async () => {
    await db.disconnect();
  });

  describe('on() returns callback function', () => {
    it('on() returns the callback function passed to it', () => {
      const node = getRandomNode();
      const callback = function () {};
      const ret = node.on('value', callback);
      expect(ret).toBe(callback);

      // Clean up
      node.off('value', callback);
    });

    it('on() returns different callbacks for different subscriptions', () => {
      const node = getRandomNode();
      const callback1 = function () {};
      const callback2 = function () {};

      const ret1 = node.on('value', callback1);
      const ret2 = node.on('value', callback2);

      expect(ret1).toBe(callback1);
      expect(ret2).toBe(callback2);
      expect(ret1).not.toBe(ret2);

      // Clean up
      node.off('value', callback1);
      node.off('value', callback2);
    });
  });

  describe('off(eventType, callback) removes specific listeners', () => {
    it('off(eventType, callback) removes only the specified callback', async () => {
      const ref = getRandomNode();
      let count1 = 0;
      let count2 = 0;

      const callback1 = ref.on('value', () => { count1++; });
      const callback2 = ref.on('value', () => { count2++; });

      // Both should fire on initial subscription
      await ref.set({ test: 1 });
      await pause(WRITE_DELAY);

      const initialCount1 = count1;
      const initialCount2 = count2;
      expect(initialCount1).toBeGreaterThan(0);
      expect(initialCount2).toBeGreaterThan(0);

      // Remove only callback1
      ref.off('value', callback1);

      // Reset counts
      count1 = 0;
      count2 = 0;

      await ref.set({ test: 2 });
      await pause(WRITE_DELAY + 100);

      // Only callback2 should have fired
      expect(count1).toBe(0);
      expect(count2).toBeGreaterThan(0);

      // Clean up
      ref.off('value', callback2);
    });

    it('off(eventType) removes all callbacks for that type', async () => {
      const ref = getRandomNode();
      let count1 = 0;
      let count2 = 0;

      ref.on('value', () => { count1++; });
      ref.on('value', () => { count2++; });

      await ref.set({ test: 1 });
      await pause(WRITE_DELAY);

      expect(count1).toBeGreaterThan(0);
      expect(count2).toBeGreaterThan(0);

      // Remove all value listeners
      ref.off('value');

      // Reset counts
      count1 = 0;
      count2 = 0;

      await ref.set({ test: 2 });
      await pause(WRITE_DELAY + 100);

      // Neither should fire
      expect(count1).toBe(0);
      expect(count2).toBe(0);
    });

    it('off() with no args removes all callbacks', async () => {
      const ref = getRandomNode();
      let valueCount = 0;
      let childCount = 0;

      ref.on('value', () => { valueCount++; });
      ref.on('child_added', () => { childCount++; });

      await ref.set({ a: 1 });
      await pause(WRITE_DELAY);

      expect(valueCount).toBeGreaterThan(0);

      // Remove all listeners
      ref.off();

      // Reset counts
      valueCount = 0;
      childCount = 0;

      await ref.set({ b: 2 });
      await pause(WRITE_DELAY + 100);

      // Neither should fire
      expect(valueCount).toBe(0);
      expect(childCount).toBe(0);
    });

    it('callback removal works with orderBy queries', async () => {
      const ref = getRandomNode();

      // Set initial data first, wait for server ack
      await ref.set(0);
      await pause(WRITE_DELAY);

      let fooReads = 0, barReads = 0, bazReads = 0, plainReads = 0;

      const fooCb = ref.orderByChild('foo').on('value', () => { fooReads++; });
      const barCb = ref.orderByChild('bar').on('value', () => { barReads++; });
      const bazCb = ref.orderByChild('baz').on('value', () => { bazReads++; });
      ref.on('value', () => { plainReads++; });

      // Wait for initial subscription events to settle
      await pause(200);

      // Reset counts - we only care about events from here on
      fooReads = 0; barReads = 0; bazReads = 0; plainReads = 0;

      // Write and wait for events to settle
      await ref.set(1);
      await pause(WRITE_DELAY);

      // All 4 should have fired at least once
      expect(fooReads).toBeGreaterThanOrEqual(1);
      expect(barReads).toBeGreaterThanOrEqual(1);
      expect(bazReads).toBeGreaterThanOrEqual(1);
      expect(plainReads).toBeGreaterThanOrEqual(1);

      // Remove fooCb using v8 style: off('value', callback) on BASE ref
      // This should work even though fooCb was registered on ref.orderByChild('foo')
      ref.off('value', fooCb);
      fooReads = 0; barReads = 0; bazReads = 0; plainReads = 0;

      await ref.set(2);
      await pause(WRITE_DELAY);

      // fooCb should not fire, others should
      expect(fooReads).toBe(0);
      expect(barReads).toBeGreaterThanOrEqual(1);
      expect(bazReads).toBeGreaterThanOrEqual(1);
      expect(plainReads).toBeGreaterThanOrEqual(1);

      // Remove all bar listeners
      ref.orderByChild('bar').off('value');
      fooReads = 0; barReads = 0; bazReads = 0; plainReads = 0;

      await ref.set(3);
      await pause(WRITE_DELAY);

      // foo and bar should not fire
      expect(fooReads).toBe(0);
      expect(barReads).toBe(0);
      expect(bazReads).toBeGreaterThanOrEqual(1);
      expect(plainReads).toBeGreaterThanOrEqual(1);

      // Now, remove everything
      ref.off();
      fooReads = 0; barReads = 0; bazReads = 0; plainReads = 0;

      await ref.set(4);
      await pause(WRITE_DELAY);

      // None should fire
      expect(fooReads).toBe(0);
      expect(barReads).toBe(0);
      expect(bazReads).toBe(0);
      expect(plainReads).toBe(0);
    });
  });

  describe('once() with callback style', () => {
    it('once(eventType, callback) invokes callback with snapshot', async () => {
      const ref = getRandomNode();
      await ref.set({ value: 'test data' });
      await pause(WRITE_DELAY);

      let receivedSnap: DataSnapshot | null = null;

      // Use callback style
      await ref.once('value', (snap) => {
        receivedSnap = snap;
      });

      expect(receivedSnap).not.toBeNull();
      expect(receivedSnap!.val()).toEqual({ value: 'test data' });
    });

    it('once() callback fires only once', async () => {
      const node = getRandomNode();
      let onceCount = 0;
      let onCount = 0;

      // Subscribe with on() to track all changes
      node.on('value', () => {
        onCount++;
      });

      // Subscribe with once() - should only fire once
      node.once('value', () => {
        onceCount++;
      });

      await node.set(1);
      await pause(WRITE_DELAY);
      await node.set(2);
      await pause(WRITE_DELAY);
      await node.set(3);
      await pause(WRITE_DELAY);

      // once() should have fired exactly once
      expect(onceCount).toBe(1);
      // on() should have fired multiple times
      expect(onCount).toBeGreaterThan(1);

      // Clean up
      node.off();
    });

    it('once() still returns a promise', async () => {
      const ref = getRandomNode();
      await ref.set({ foo: 'bar' });
      await pause(WRITE_DELAY);

      const snap = await ref.once('value');
      expect(snap.val()).toEqual({ foo: 'bar' });
    });

    it('once() with both callback and promise works', async () => {
      const ref = getRandomNode();
      await ref.set({ test: 123 });
      await pause(WRITE_DELAY);

      let callbackSnap: DataSnapshot | null = null;
      const promiseSnap = await ref.once('value', (snap) => {
        callbackSnap = snap;
      });

      expect(callbackSnap).not.toBeNull();
      expect(promiseSnap.val()).toEqual({ test: 123 });
      expect(callbackSnap!.val()).toEqual({ test: 123 });
    });
  });

  describe('mixed usage patterns', () => {
    it('can use v8 style for some listeners and unsubscribe function for cleanup', async () => {
      const ref = getRandomNode();
      let count1 = 0;
      let count2 = 0;

      // v8 style - on() returns callback
      const callback1 = ref.on('value', () => { count1++; });

      // Store callback for later removal
      const callback2 = () => { count2++; };
      ref.on('value', callback2);

      await ref.set(1);
      await pause(WRITE_DELAY);

      expect(count1).toBeGreaterThan(0);
      expect(count2).toBeGreaterThan(0);

      // Remove using v8 style
      ref.off('value', callback1);
      ref.off('value', callback2);

      count1 = 0;
      count2 = 0;

      await ref.set(2);
      await pause(WRITE_DELAY + 100);

      expect(count1).toBe(0);
      expect(count2).toBe(0);
    });
  });
});

// =============================================================================
// Context Parameter Tests
// =============================================================================

describe('Firebase v8 API - Context Parameter', () => {
  beforeAll(async () => {
    db = new LarkDatabase(TEST_DATABASE, { anonymous: true });
    await db.connect(TEST_DATABASE, { anonymous: true });
  });

  afterAll(async () => {
    await db.disconnect();
  });

  it('.on() with a context binds this correctly', async () => {
    const ref = getRandomNode();

    // Set up initial data
    await ref.set(0);
    await pause(WRITE_DELAY);

    // Create an object with a method that uses `this`
    const listener = {
      snap: null as DataSnapshot | null,
      onValue(snap: DataSnapshot) {
        this.snap = snap;
      }
    };

    // Subscribe with context - `this` inside onValue should be `listener`
    ref.on('value', listener.onValue, listener);

    await ref.set('test');
    await pause(WRITE_DELAY);

    expect(listener.snap).not.toBeNull();
    expect(listener.snap!.val()).toBe('test');

    // Unsubscribe with context
    ref.off('value', listener.onValue, listener);

    // Reset and verify no more events
    listener.snap = null;
    await ref.set('after-off');
    await pause(WRITE_DELAY);

    expect(listener.snap).toBeNull();
  });

  it('.once() with a context binds this correctly', async () => {
    const ref = getRandomNode();
    await ref.set('test-value');
    await pause(WRITE_DELAY);

    const listener = {
      snap: null as DataSnapshot | null,
      onValue(snap: DataSnapshot) {
        this.snap = snap;
      }
    };

    // once() with context - pass undefined for cancelCallback
    await ref.once('value', listener.onValue, undefined, listener);

    expect(listener.snap).not.toBeNull();
    expect(listener.snap!.val()).toBe('test-value');
  });

  it('off() respects provided context (for value events)', async () => {
    const ref = getRandomNode();
    await ref.set(0);
    await pause(WRITE_DELAY);

    const a = { gotValue: false, onValue() { this.gotValue = true; } };
    const b = { gotValue: false, onValue() { this.gotValue = true; } };

    ref.on('value', a.onValue, a);
    ref.on('value', b.onValue, b);

    await ref.set('hello!');
    await pause(WRITE_DELAY);

    expect(a.gotValue).toBe(true);
    expect(b.gotValue).toBe(true);
    a.gotValue = b.gotValue = false;

    // Unsubscribe only b
    ref.off('value', b.onValue, b);

    // Only a should get this event
    await ref.set(42);
    await pause(WRITE_DELAY);

    expect(a.gotValue).toBe(true);
    expect(b.gotValue).toBe(false);

    ref.off('value', a.onValue, a);
  });

  it('off() respects provided context (for child events)', async () => {
    const ref = getRandomNode();
    await ref.set(null);
    await pause(WRITE_DELAY);

    const a = { gotChildAdded: false, onChildAdded() { this.gotChildAdded = true; } };
    const b = { gotChildAdded: false, onChildAdded() { this.gotChildAdded = true; } };

    ref.on('child_added', a.onChildAdded, a);
    ref.on('child_added', b.onChildAdded, b);

    await ref.push('hello!');
    await pause(WRITE_DELAY);

    expect(a.gotChildAdded).toBe(true);
    expect(b.gotChildAdded).toBe(true);
    a.gotChildAdded = b.gotChildAdded = false;

    // Unsubscribe only b
    ref.off('child_added', b.onChildAdded, b);

    // Only a should get this event
    await ref.push(42);
    await pause(WRITE_DELAY);

    expect(a.gotChildAdded).toBe(true);
    expect(b.gotChildAdded).toBe(false);

    ref.off('child_added', a.onChildAdded, a);
  });

  it('off(eventType) removes all callbacks even with contexts', async () => {
    const ref = getRandomNode();
    await ref.set(0);
    await pause(WRITE_DELAY);

    const a = { gotValue: false, onValue() { this.gotValue = true; } };
    const b = { gotValue: false, onValue() { this.gotValue = true; } };

    ref.on('value', a.onValue, a);
    ref.on('value', b.onValue, b);

    await ref.set('hello!');
    await pause(WRITE_DELAY);

    expect(a.gotValue).toBe(true);
    expect(b.gotValue).toBe(true);
    a.gotValue = b.gotValue = false;

    // Unsubscribe all value events (no callback/context)
    ref.off('value');

    // Neither should get events
    await ref.set(42);
    await pause(WRITE_DELAY);

    expect(a.gotValue).toBe(false);
    expect(b.gotValue).toBe(false);
  });

  it('off() with no args removes all callbacks even with contexts', async () => {
    const ref = getRandomNode();
    await ref.set(null);
    await pause(WRITE_DELAY);

    const a = { gotValue: false, gotChildAdded: false,
      onValue() { this.gotValue = true; },
      onChildAdded() { this.gotChildAdded = true; }
    };
    const b = { gotValue: false, gotChildAdded: false,
      onValue() { this.gotValue = true; },
      onChildAdded() { this.gotChildAdded = true; }
    };

    ref.on('value', a.onValue, a);
    ref.on('value', b.onValue, b);
    ref.on('child_added', a.onChildAdded, a);
    ref.on('child_added', b.onChildAdded, b);

    await ref.push('hello!');
    await pause(WRITE_DELAY);

    expect(a.gotValue).toBe(true);
    expect(b.gotValue).toBe(true);
    expect(a.gotChildAdded).toBe(true);
    expect(b.gotChildAdded).toBe(true);
    a.gotValue = b.gotValue = a.gotChildAdded = b.gotChildAdded = false;

    // Unsubscribe all
    ref.off();

    // None should get events
    await ref.push(42);
    await pause(WRITE_DELAY);

    expect(a.gotValue).toBe(false);
    expect(b.gotValue).toBe(false);
    expect(a.gotChildAdded).toBe(false);
    expect(b.gotChildAdded).toBe(false);
  });

  it('same callback can be registered with different contexts', async () => {
    const ref = getRandomNode();
    await ref.set(0);
    await pause(WRITE_DELAY);

    function sharedCallback(this: { name: string; received: boolean }) {
      this.received = true;
    }

    const contextA = { name: 'A', received: false };
    const contextB = { name: 'B', received: false };

    // Register same callback with two different contexts
    ref.on('value', sharedCallback, contextA);
    ref.on('value', sharedCallback, contextB);

    await ref.set(1);
    await pause(WRITE_DELAY);

    // Both should receive
    expect(contextA.received).toBe(true);
    expect(contextB.received).toBe(true);
    contextA.received = contextB.received = false;

    // Remove only contextA
    ref.off('value', sharedCallback, contextA);

    await ref.set(2);
    await pause(WRITE_DELAY);

    // Only B should receive
    expect(contextA.received).toBe(false);
    expect(contextB.received).toBe(true);

    // Clean up
    ref.off('value', sharedCallback, contextB);
  });
});

// =============================================================================
// Priority and child_moved Tests (v8 style)
// =============================================================================

describe('Firebase v8 API - Priority and child_moved', () => {
  beforeAll(async () => {
    db = new LarkDatabase(TEST_DATABASE, { anonymous: true });
    await db.connect(TEST_DATABASE, { anonymous: true });
  });

  afterAll(async () => {
    await db.disconnect();
  });

  it('fires child_moved when setPriority changes sort order', async () => {
    const ref = getRandomNode();

    // Set up initial data with priorities
    await ref.child('a').setWithPriority('first', 1);
    await pause(WRITE_DELAY);
    await ref.child('b').setWithPriority('second', 5);
    await pause(WRITE_DELAY);
    await ref.child('c').setWithPriority('third', 10);
    await pause(WRITE_DELAY);

    const movedEvents: { key: string; prevKey: string | null }[] = [];
    const changedEvents: string[] = [];

    // Subscribe using v8 style (no orderBy - uses priority ordering by default)
    const movedCb = ref.on('child_moved', (snap, prevKey) => {
      movedEvents.push({ key: snap.key!, prevKey: prevKey ?? null });
    });

    const changedCb = ref.on('child_changed', (snap) => {
      changedEvents.push(snap.key!);
    });

    await pause(300);

    // Change a's priority to 15 (should move from first to last)
    await ref.child('a').setPriority(15);
    await pause(WRITE_DELAY + 200);

    // Clean up
    ref.off('child_moved', movedCb);
    ref.off('child_changed', changedCb);

    // child_moved should fire for 'a' since it moved from first to last
    const aMove = movedEvents.find(m => m.key === 'a');
    expect(aMove).toBeDefined();
    expect(aMove?.prevKey).toBe('c'); // Now after 'c'

    // child_changed should also fire
    expect(changedEvents).toContain('a');
  });

  it('can reset priority to null', async () => {
    const ref = getRandomNode();

    // Set up data - 'a' and 'b' have priorities
    await ref.child('a').setWithPriority('a', 1);
    await pause(WRITE_DELAY);
    await ref.child('b').setWithPriority('b', 2);
    await pause(WRITE_DELAY);

    const movedEvents: { key: string; prevKey: string | null }[] = [];

    const movedCb = ref.on('child_moved', (snap, prevKey) => {
      movedEvents.push({ key: snap.key!, prevKey: prevKey ?? null });
    });

    await pause(300);

    // Reset b's priority to null
    await ref.child('b').setPriority(null);
    await pause(WRITE_DELAY + 200);

    ref.off('child_moved', movedCb);

    // b's priority changed, which should trigger child_moved
    const bMove = movedEvents.find(m => m.key === 'b');
    expect(bMove).toBeDefined();

    // Verify priority is actually null
    const snap = await ref.child('b').once('value');
    expect(snap.getPriority()).toBeNull();
  });

  it('fires child_moved when priority changes even if order stays same (Firebase Case 2003)', async () => {
    // Firebase behavior: child_moved fires for ANY priority change when ordering by priority,
    // regardless of whether the position actually changes. This is "Case 2003" behavior.
    const ref = getRandomNode();

    // Set up data with gaps in priority
    await ref.child('a').setWithPriority('a', 1);
    await pause(WRITE_DELAY);
    await ref.child('b').setWithPriority('b', 10);
    await pause(WRITE_DELAY);
    await ref.child('c').setWithPriority('c', 100);
    await pause(WRITE_DELAY);

    const movedEvents: string[] = [];
    const changedEvents: string[] = [];

    const movedCb = ref.on('child_moved', (snap) => {
      movedEvents.push(snap.key!);
    });

    const changedCb = ref.on('child_changed', (snap) => {
      changedEvents.push(snap.key!);
    });

    await pause(300);

    // Change b's priority but keep it between a(1) and c(100)
    await ref.child('b').setPriority(50);
    await pause(WRITE_DELAY + 200);

    ref.off('child_moved', movedCb);
    ref.off('child_changed', changedCb);

    // child_changed should fire
    expect(changedEvents).toContain('b');

    // Firebase Case 2003: child_moved DOES fire for ANY priority change
    expect(movedEvents).toContain('b');
  });

  it('fires child_moved with orderByPriority() explicit ordering', async () => {
    const ref = getRandomNode();

    await ref.child('x').setWithPriority('x', 10);
    await pause(WRITE_DELAY);
    await ref.child('y').setWithPriority('y', 20);
    await pause(WRITE_DELAY);
    await ref.child('z').setWithPriority('z', 30);
    await pause(WRITE_DELAY);

    const movedEvents: { key: string; prevKey: string | null }[] = [];

    // Explicit orderByPriority with v8-style on()
    const queryRef = ref.orderByPriority();
    const movedCb = queryRef.on('child_moved', (snap, prevKey) => {
      movedEvents.push({ key: snap.key!, prevKey: prevKey ?? null });
    });

    await pause(300);

    // Move x to last
    await ref.child('x').setPriority(100);
    await pause(WRITE_DELAY + 200);

    queryRef.off('child_moved', movedCb);

    const xMove = movedEvents.find(m => m.key === 'x');
    expect(xMove).toBeDefined();
    expect(xMove?.prevKey).toBe('z');
  });
});
