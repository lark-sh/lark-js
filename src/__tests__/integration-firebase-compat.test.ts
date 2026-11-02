/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * This file contains test code derived from the Firebase JS SDK.
 * https://github.com/firebase/firebase-js-sdk
 * Modified for Lark compatibility testing.
 */

// @ts-nocheck - These tests intentionally test behaviors that may not match our TypeScript types
/**
 * Firebase Compatibility Tests
 *
 * These tests are ported from the Firebase JS SDK's database-compat package
 * to verify that our Lark client behaves the same as Firebase RTDB.
 *
 * Source: https://github.com/firebase/firebase-js-sdk/tree/main/packages/database-compat/test
 *
 * Tests marked with `it.skip` indicate known differences from Firebase behavior.
 * Tests marked with `it.todo` indicate features not yet implemented.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { LarkDatabase } from '../LarkDatabase';
import { DatabaseReference } from '../DatabaseReference';
import { DataSnapshot } from '../DataSnapshot';

// =============================================================================
// Test Setup
// =============================================================================

const TEST_DATABASE = 'javascript-integration/test';
const WRITE_DELAY = 350; // Server rate limit

let db: LarkDatabase;

async function getRandomNode(): Promise<DatabaseReference> {
  const pushId = db.ref().push().key!;
  return db.ref(`test/${pushId}`);
}

async function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper to wait for a specific number of events
class EventAccumulator<T> {
  private events: T[] = [];
  private resolve: ((events: T[]) => void) | null = null;
  private targetCount: number;
  private exact: boolean;

  constructor(targetCount: number, exact = true) {
    this.targetCount = targetCount;
    this.exact = exact;
  }

  addEvent(event: T) {
    this.events.push(event);
    if (this.exact && this.events.length > this.targetCount) {
      throw new Error(`Received more events than expected (${this.events.length} > ${this.targetCount})`);
    }
    if (this.events.length >= this.targetCount && this.resolve) {
      this.resolve(this.events);
    }
  }

  get promise(): Promise<T[]> {
    if (this.events.length >= this.targetCount) {
      return Promise.resolve(this.events);
    }
    return new Promise(resolve => {
      this.resolve = resolve;
    });
  }

  get count(): number {
    return this.events.length;
  }
}

// =============================================================================
// DataSnapshot Tests (from datasnapshot.test.ts)
// =============================================================================

describe('Firebase Compat: DataSnapshot Tests', () => {
  beforeAll(async () => {
    db = new LarkDatabase(TEST_DATABASE, { anonymous: true });
    await db.connect(TEST_DATABASE, { anonymous: true });
  });

  afterAll(async () => {
    await db.disconnect();
  });

  describe('DataSnapshot.hasChildren()', () => {
    it('returns false for empty object', async () => {
      const ref = await getRandomNode();
      await ref.set({});
      const snap = await ref.once('value');
      expect(snap.hasChildren()).toBe(false);
    });

    it('returns false for primitive value', async () => {
      const ref = await getRandomNode();
      await ref.set(5);
      await pause(WRITE_DELAY);
      const snap = await ref.once('value');
      expect(snap.hasChildren()).toBe(false);
    });

    it('returns true for object with children', async () => {
      const ref = await getRandomNode();
      await ref.set({ x: 5 });
      await pause(WRITE_DELAY);
      const snap = await ref.once('value');
      expect(snap.hasChildren()).toBe(true);
    });
  });

  describe('DataSnapshot.exists()', () => {
    it('returns false for empty object', async () => {
      const ref = await getRandomNode();
      await ref.set({});
      const snap = await ref.once('value');
      expect(snap.exists()).toBe(false);
    });

    it('returns false for null', async () => {
      const ref = await getRandomNode();
      await ref.set(null);
      const snap = await ref.once('value');
      expect(snap.exists()).toBe(false);
    });

    it('returns true for boolean true', async () => {
      const ref = await getRandomNode();
      await ref.set(true);
      await pause(WRITE_DELAY);
      const snap = await ref.once('value');
      expect(snap.exists()).toBe(true);
    });

    it('returns true for number', async () => {
      const ref = await getRandomNode();
      await ref.set(5);
      await pause(WRITE_DELAY);
      const snap = await ref.once('value');
      expect(snap.exists()).toBe(true);
    });

    it('returns true for object with children', async () => {
      const ref = await getRandomNode();
      await ref.set({ x: 5 });
      await pause(WRITE_DELAY);
      const snap = await ref.once('value');
      expect(snap.exists()).toBe(true);
    });
  });

  describe('DataSnapshot.val()', () => {
    it('returns primitive value', async () => {
      const ref = await getRandomNode();
      await ref.set(5);
      await pause(WRITE_DELAY);
      const snap = await ref.once('value');
      expect(snap.val()).toBe(5);
    });

    it('returns null for empty object', async () => {
      const ref = await getRandomNode();
      await ref.set({});
      const snap = await ref.once('value');
      expect(snap.val()).toBe(null);
    });

    it('returns deep object correctly', async () => {
      const ref = await getRandomNode();
      const json = {
        x: 5,
        y: {
          ya: 1,
          yb: 2,
          yc: { yca: 3 }
        }
      };
      await ref.set(json);
      await pause(WRITE_DELAY);
      const snap = await ref.once('value');
      expect(snap.val()).toEqual(json);
    });
  });

  describe('DataSnapshot.child()', () => {
    it('returns child values correctly', async () => {
      const ref = await getRandomNode();
      await ref.set({ x: 5, y: { yy: 3, yz: 4 } });
      await pause(WRITE_DELAY);
      const snap = await ref.once('value');

      expect(snap.child('x').val()).toBe(5);
      expect(snap.child('y').val()).toEqual({ yy: 3, yz: 4 });
      expect(snap.child('y').child('yy').val()).toBe(3);
      expect(snap.child('y/yz').val()).toBe(4);
      expect(snap.child('z').val()).toBe(null);
      expect(snap.child('x/y').val()).toBe(null);
      expect(snap.child('x').child('y').val()).toBe(null);
    });
  });

  describe('DataSnapshot.hasChild()', () => {
    it('returns correct values', async () => {
      const ref = await getRandomNode();
      await ref.set({ x: 5, y: { yy: 3, yz: 4 } });
      await pause(WRITE_DELAY);
      const snap = await ref.once('value');

      expect(snap.hasChild('x')).toBe(true);
      expect(snap.hasChild('y/yy')).toBe(true);
      expect(snap.hasChild('dinosaur')).toBe(false);
      expect(snap.child('x').hasChild('anything')).toBe(false);
      expect(snap.hasChild('x/anything/at/all')).toBe(false);
    });
  });

  describe('DataSnapshot.key', () => {
    it('returns correct keys for nested paths', async () => {
      const ref = await getRandomNode();
      await ref.set({ a: { b: { c: 5 } } });
      await pause(WRITE_DELAY);
      const snap = await ref.once('value');

      expect(snap.child('a').key).toBe('a');
      expect(snap.child('a/b/c').key).toBe('c');
      expect(snap.child('/a/b/c/').key).toBe('c');

      // Should also work for nonexistent paths
      expect(snap.child('/z/q/r/v/m').key).toBe('m');
    });
  });

  describe('DataSnapshot.forEach()', () => {
    it('iterates in key order (no priorities)', async () => {
      const ref = await getRandomNode();
      await ref.set({
        a: 1,
        z: 26,
        m: 13,
        n: 14,
        c: 3,
        b: 2,
        e: 5
      });
      await pause(WRITE_DELAY);
      const snap = await ref.once('value');

      let out = '';
      snap.forEach(child => {
        out = out + child.key + ':' + child.val() + ':';
      });

      expect(out).toBe('a:1:b:2:c:3:e:5:m:13:n:14:z:26:');
    });

    it('exports array-like data as arrays', async () => {
      const ref = await getRandomNode();
      const array = ['bob', 'and', 'becky', 'seem', 'really', 'nice', 'yeah?'];
      await ref.set(array);
      await pause(WRITE_DELAY);
      const snap = await ref.once('value');
      const snapVal = snap.val();

      expect(snapVal).toEqual(array);
      expect(Array.isArray(snapVal)).toBe(true);
    });
  });

  // Priority ordering tests (ported from Firebase datasnapshot.test.ts)
  // Note: These use setWithPriority + orderByPriority query to test priority ordering
  describe('DataSnapshot.forEach() with priorities', () => {
    it('iterates in priority order (numeric priorities)', async () => {
      // From Firebase: DataSnapshot.forEach() works: numeric priorities.
      const ref = await getRandomNode();

      // Set data with numeric priorities
      // Firebase test data: a:pri=26, z:pri=1, m:pri=14, n:pri=12, c:pri=24, b:pri=25, e:pri=22
      // Expected order by priority: z(1), n(12), m(14), e(22), c(24), b(25), a(26)
      await ref.child('a').setWithPriority(1, 26);
      await pause(WRITE_DELAY);
      await ref.child('z').setWithPriority(26, 1);
      await pause(WRITE_DELAY);
      await ref.child('m').setWithPriority(13, 14);
      await pause(WRITE_DELAY);
      await ref.child('n').setWithPriority(14, 12);
      await pause(WRITE_DELAY);
      await ref.child('c').setWithPriority(3, 24);
      await pause(WRITE_DELAY);
      await ref.child('b').setWithPriority(2, 25);
      await pause(WRITE_DELAY);
      await ref.child('e').setWithPriority(5, 22);
      await pause(WRITE_DELAY);

      const snap = await ref.orderByPriority().once('value');
      let out = '';
      snap.forEach(child => {
        out = out + child.key + ':' + child.val() + ':';
      });

      expect(out).toBe('z:26:n:14:m:13:e:5:c:3:b:2:a:1:');
    });

    it('iterates in priority order (string priorities)', async () => {
      // From Firebase: DataSnapshot.forEach() works: alpha priorities.
      const ref = await getRandomNode();

      // Set data with string priorities
      // Firebase expected order: fifth, first, fourth, second, seventh, sixth, third (alphabetical)
      // c:fifth, a:first, n:fourth, z:second, e:seventh, b:sixth, m:third
      await ref.child('a').setWithPriority(1, 'first');
      await pause(WRITE_DELAY);
      await ref.child('z').setWithPriority(26, 'second');
      await pause(WRITE_DELAY);
      await ref.child('m').setWithPriority(13, 'third');
      await pause(WRITE_DELAY);
      await ref.child('n').setWithPriority(14, 'fourth');
      await pause(WRITE_DELAY);
      await ref.child('c').setWithPriority(3, 'fifth');
      await pause(WRITE_DELAY);
      await ref.child('b').setWithPriority(2, 'sixth');
      await pause(WRITE_DELAY);
      await ref.child('e').setWithPriority(5, 'seventh');
      await pause(WRITE_DELAY);

      const snap = await ref.orderByPriority().once('value');
      let out = '';
      snap.forEach(child => {
        out = out + child.key + ':' + child.val() + ':';
      });

      // Alphabetical order of priorities: fifth, first, fourth, second, seventh, sixth, third
      expect(out).toBe('c:3:a:1:n:14:z:26:e:5:b:2:m:13:');
    });

    it('iterates in priority order (mixed null/numeric/string priorities)', async () => {
      // From Firebase: DataSnapshot.foreach() works: mixed alpha and numeric priorities
      // Priority order: null first (by key), then numeric (by value), then string (alphabetically)
      const ref = await getRandomNode();

      await ref.child('noPriorityC').set(1); // null priority
      await pause(WRITE_DELAY);
      await ref.child('noPriorityA').set(1); // null priority
      await pause(WRITE_DELAY);
      await ref.child('noPriorityB').set(1); // null priority
      await pause(WRITE_DELAY);
      await ref.child('num10').setWithPriority(1, 24);
      await pause(WRITE_DELAY);
      await ref.child('num20').setWithPriority(1, 123);
      await pause(WRITE_DELAY);
      await ref.child('num30').setWithPriority(1, 300);
      await pause(WRITE_DELAY);
      await ref.child('alpha10').setWithPriority(1, '0horse');
      await pause(WRITE_DELAY);
      await ref.child('alpha20').setWithPriority(1, 'horse');
      await pause(WRITE_DELAY);
      await ref.child('alpha30').setWithPriority(1, 'tree');
      await pause(WRITE_DELAY);

      const snap = await ref.orderByPriority().once('value');
      const keys: string[] = [];
      snap.forEach(child => {
        keys.push(child.key!);
      });

      // Expected: null priorities first (sorted by key), then numeric (by value), then string (alphabetically)
      expect(keys).toEqual([
        'noPriorityA', 'noPriorityB', 'noPriorityC', // null, sorted by key
        'num10', 'num20', 'num30', // numeric priorities: 24, 123, 300
        'alpha10', 'alpha20', 'alpha30' // string priorities: 0horse, horse, tree
      ]);
    });
  });
});

// =============================================================================
// Query Tests (from query.test.ts)
// =============================================================================

describe('Firebase Compat: Query Tests', () => {
  beforeAll(async () => {
    db = new LarkDatabase(TEST_DATABASE, { anonymous: true });
    await db.connect(TEST_DATABASE, { anonymous: true });
  });

  afterAll(async () => {
    await db.disconnect();
  });

  describe('Can create basic queries', () => {
    it('creates limit queries', async () => {
      const ref = await getRandomNode();

      // These should not throw
      ref.limitToLast(10);
      ref.limitToFirst(10);
    });

    it('creates range queries', async () => {
      const ref = await getRandomNode();

      ref.startAt('199').limitToFirst(10);
      ref.startAt('199', 'test').limitToFirst(10);
      ref.endAt('199').limitToLast(1);
      ref.startAt('50', 'test').endAt('100', 'tree');
      ref.startAt('4').endAt('10');
      ref.startAt().limitToFirst(10);
      ref.endAt().limitToLast(10);
    });

    it('creates orderBy queries', async () => {
      const ref = await getRandomNode();

      ref.orderByKey().startAt('foo');
      ref.orderByKey().endAt('foo');
      ref.orderByKey().equalTo('foo');
      ref.orderByChild('child');
      ref.orderByChild('child/deep/path');
      ref.orderByValue();
      ref.orderByPriority();
    });
  });

  describe('Invalid queries throw', () => {
    it('throws for double limitToLast', async () => {
      const ref = await getRandomNode();
      expect(() => ref.limitToLast(100).limitToLast(100)).toThrow();
    });

    it('throws for limitToLast + limitToFirst', async () => {
      const ref = await getRandomNode();
      expect(() => ref.limitToLast(100).limitToFirst(100)).toThrow();
    });

    it('throws for double orderBy', async () => {
      const ref = await getRandomNode();
      expect(() => ref.orderByPriority().orderByPriority()).toThrow();
      expect(() => ref.orderByPriority().orderByKey()).toThrow();
      expect(() => ref.orderByPriority().orderByChild('foo')).toThrow();
      expect(() => ref.orderByKey().orderByPriority()).toThrow();
      expect(() => ref.orderByKey().orderByKey()).toThrow();
      expect(() => ref.orderByChild('foo').orderByKey()).toThrow();
    });

    it('throws for double startAt', async () => {
      const ref = await getRandomNode();
      expect(() => ref.startAt('foo').startAt('foo')).toThrow();
    });

    it('throws for double endAt', async () => {
      const ref = await getRandomNode();
      expect(() => ref.endAt('foo').endAt('foo')).toThrow();
    });

    it('throws for startAt + equalTo', async () => {
      const ref = await getRandomNode();
      expect(() => ref.startAt('foo').equalTo('foo')).toThrow();
    });

    it('throws for endAt + equalTo', async () => {
      const ref = await getRandomNode();
      expect(() => ref.endAt('foo').equalTo('foo')).toThrow();
    });

    it('throws for equalTo + startAt', async () => {
      const ref = await getRandomNode();
      expect(() => ref.equalTo('foo').startAt('foo')).toThrow();
    });

    it('throws for double equalTo', async () => {
      const ref = await getRandomNode();
      expect(() => ref.equalTo('foo').equalTo('foo')).toThrow();
    });

    it('throws for orderByKey with non-string startAt', async () => {
      const ref = await getRandomNode();
      expect(() => ref.orderByKey().startAt(1)).toThrow();
      expect(() => ref.orderByKey().startAt(true)).toThrow();
      expect(() => ref.orderByKey().startAt(null)).toThrow();
    });

    it('throws for orderByKey with key parameter', async () => {
      const ref = await getRandomNode();
      expect(() => ref.orderByKey().startAt('foo', 'bar')).toThrow();
      expect(() => ref.orderByKey().endAt('foo', 'bar')).toThrow();
      expect(() => ref.orderByKey().equalTo('foo', 'bar')).toThrow();
    });
  });

  describe('Query.ref', () => {
    it('produces a valid ref', async () => {
      const ref = await getRandomNode();
      const query = ref.limitToLast(1);
      const queryRef = query.ref;

      expect(queryRef.toString()).toBe(ref.toString());
    });
  });

  describe('Limit queries', () => {
    // Version 1: Synchronous test - relies on set() firing callbacks synchronously
    // This is how Firebase works - local-first writes should fire events synchronously
    it('limitToLast(5) keeps only last 5 items (synchronous)', async () => {
      const ref = await getRandomNode();
      let snap: DataSnapshot | null = null;

      ref.limitToLast(5).on('value', s => {
        snap = s;
      });

      // These are intentionally NOT awaited - Firebase fires events synchronously
      ref.set({});
      for (let i = 0; i < 10; i++) {
        ref.push().set(i);
      }

      // In Firebase, snap is already updated synchronously
      expect(snap).not.toBeNull();
      let expected = 5;
      let count = 0;
      snap!.forEach(child => {
        expect(child.val()).toBe(expected);
        expected++;
        count++;
      });

      expect(count).toBe(5);
    });

    // Version 2: Async test - write all data first, then subscribe
    // This tests that the server correctly returns only the last 5 items
    it('limitToLast(5) returns only last 5 items from server', async () => {
      const ref = await getRandomNode();

      // Write all data first
      await ref.set({});
      for (let i = 0; i < 10; i++) {
        await ref.push().set(i);
        await pause(WRITE_DELAY);
      }

      // Now subscribe - should get only 1 event with the last 5 items
      const ea = new EventAccumulator<DataSnapshot>(1);
      const unsub = ref.limitToLast(5).on('value', snap => {
        ea.addEvent(snap);
      });

      const [snap] = await ea.promise;
      let expected = 5;
      let count = 0;
      snap.forEach(child => {
        expect(child.val()).toBe(expected);
        expected++;
        count++;
      });

      expect(count).toBe(5);
      unsub();
    });

    it('various limits return correct data', async () => {
      const ref = await getRandomNode();
      await ref.set({ a: 1, b: 2, c: 3 });
      await pause(WRITE_DELAY);

      const tests: [DatabaseReference, unknown][] = [
        [ref.limitToLast(1), { c: 3 }],
        [ref.limitToLast(2), { b: 2, c: 3 }],
        [ref.limitToLast(3), { a: 1, b: 2, c: 3 }],
        [ref.limitToLast(4), { a: 1, b: 2, c: 3 }],
      ];

      for (const [query, expected] of tests) {
        const snap = await query.once('value');
        expect(snap.val()).toEqual(expected);
      }
    });

    it('various limits with startAt return correct data', async () => {
      const ref = await getRandomNode();
      await ref.set({ a: 1, b: 2, c: 3 });
      await pause(WRITE_DELAY);

      const tests: [DatabaseReference, unknown][] = [
        [ref.startAt().limitToFirst(1), { a: 1 }],
        [ref.startAt(null, 'c').limitToFirst(1), { c: 3 }],
        [ref.startAt(null, 'b').limitToFirst(1), { b: 2 }],
        [ref.startAt(null, 'b').limitToFirst(2), { b: 2, c: 3 }],
        [ref.startAt(null, 'b').limitToFirst(3), { b: 2, c: 3 }],
        [ref.startAt(null, 'b').limitToLast(1), { c: 3 }],
        [ref.startAt(null, 'b').limitToLast(2), { b: 2, c: 3 }],
      ];

      for (const [query, expected] of tests) {
        const snap = await query.once('value');
        expect(snap.val()).toEqual(expected);
      }
    });

    it('various limits with endAt return correct data', async () => {
      const ref = await getRandomNode();
      await ref.set({ a: 1, b: 2, c: 3 });
      await pause(WRITE_DELAY);

      const tests: [DatabaseReference, unknown][] = [
        [ref.endAt().limitToFirst(1), { a: 1 }],
        [ref.endAt(null, 'c').limitToFirst(1), { a: 1 }],
        [ref.endAt(null, 'b').limitToFirst(1), { a: 1 }],
        [ref.endAt(null, 'b').limitToFirst(2), { a: 1, b: 2 }],
        [ref.endAt(null, 'b').limitToFirst(3), { a: 1, b: 2 }],
        [ref.endAt(null, 'c').limitToLast(1), { c: 3 }],
        [ref.endAt(null, 'b').limitToLast(1), { b: 2 }],
        [ref.endAt(null, 'b').limitToLast(2), { a: 1, b: 2 }],
      ];

      for (const [query, expected] of tests) {
        const snap = await query.once('value');
        expect(snap.val()).toEqual(expected);
      }
    });
  });

  describe('Child events with limits', () => {
    it('fires child_removed and child_added when limit is hit', async () => {
      const ref = await getRandomNode();
      let added = '';
      let removed = '';

      const unsubAdd = ref.limitToLast(2).on('child_added', snap => {
        added += snap.key + ' ';
      });
      const unsubRemove = ref.limitToLast(2).on('child_removed', snap => {
        removed += snap.key + ' ';
      });

      await ref.set({ a: 1, b: 2, c: 3 });
      await pause(WRITE_DELAY);

      // Initial: should have b and c (last 2)
      expect(added).toContain('b');
      expect(added).toContain('c');
      expect(removed).toBe('');

      added = '';
      await ref.child('d').set(4);
      await pause(WRITE_DELAY);

      // After adding d: should add d and remove b
      expect(added).toContain('d');
      expect(removed).toContain('b');

      unsubAdd();
      unsubRemove();
    });
  });

  describe('Synchronous events (local-first)', () => {
    it('raises snapshots synchronously for local writes', async () => {
      const ref = await getRandomNode();
      let newValue: unknown = undefined;

      const unsub = ref.on('value', snap => {
        newValue = snap.val();
      });

      // This should fire the callback synchronously (local-first)
      ref.set('foo');
      expect(newValue).toBe('foo');

      unsub();
    });
  });
});

// =============================================================================
// OrderBy Tests (from order_by.test.ts)
// =============================================================================

describe('Firebase Compat: OrderBy Tests', () => {
  beforeAll(async () => {
    db = new LarkDatabase(TEST_DATABASE, { anonymous: true });
    await db.connect(TEST_DATABASE, { anonymous: true });
  });

  afterAll(async () => {
    await db.disconnect();
  });

  describe('orderByChild', () => {
    it('snapshots are iterated in order', async () => {
      const ref = await getRandomNode();

      const initial = {
        alex: { nuggets: 60 },
        rob: { nuggets: 56 },
        vassili: { nuggets: 55.5 },
        tony: { nuggets: 52 },
        greg: { nuggets: 52 }
      };

      const expectedOrder = ['greg', 'tony', 'vassili', 'rob', 'alex'];
      const expectedPrevNames = [null, 'greg', 'tony', 'vassili', 'rob'];

      const valueOrder: string[] = [];
      const addedOrder: string[] = [];
      const addedPrevNames: (string | null)[] = [];

      const orderedRef = ref.orderByChild('nuggets');

      const unsubValue = orderedRef.on('value', snap => {
        snap.forEach(childSnap => {
          valueOrder.push(childSnap.key!);
        });
      });

      const unsubAdded = orderedRef.on('child_added', (snap, prevName) => {
        addedOrder.push(snap.key!);
        addedPrevNames.push(prevName);
      });

      await ref.set(initial);
      await pause(WRITE_DELAY);

      // Wait for events
      await pause(100);

      expect(addedOrder).toEqual(expectedOrder);
      expect(valueOrder).toEqual(expectedOrder);
      expect(addedPrevNames).toEqual(expectedPrevNames);

      unsubValue();
      unsubAdded();
    });

    it('fires child_moved events', async () => {
      const ref = await getRandomNode();

      const initial = {
        alex: { nuggets: 60 },
        rob: { nuggets: 56 },
        vassili: { nuggets: 55.5 },
        tony: { nuggets: 52 },
        greg: { nuggets: 52 }
      };

      const orderedRef = ref.orderByChild('nuggets');

      let moved = false;
      let movedKey: string | null = null;
      let movedPrevName: string | null = null;
      let movedValue: unknown = null;

      const unsubMoved = orderedRef.on('child_moved', (snap, prevName) => {
        moved = true;
        movedKey = snap.key;
        movedPrevName = prevName;
        movedValue = snap.val();
      });

      // Subscribe to value to ensure we get initial data
      const unsubValue = orderedRef.on('value', () => {});

      await ref.set(initial);
      await pause(WRITE_DELAY);

      // Now move greg by changing nuggets from 52 to 57
      await ref.child('greg/nuggets').set(57);
      await pause(WRITE_DELAY);

      // Wait for events
      await pause(100);

      expect(moved).toBe(true);
      expect(movedKey).toBe('greg');
      expect(movedPrevName).toBe('rob');
      expect(movedValue).toEqual({ nuggets: 57 });

      unsubMoved();
      unsubValue();
    });
  });

  describe('orderByValue', () => {
    it('snapshots are iterated in order', async () => {
      const ref = await getRandomNode();

      const initial = {
        alex: 60,
        rob: 56,
        vassili: 55.5,
        tony: 52,
        greg: 52
      };

      const expectedOrder = ['greg', 'tony', 'vassili', 'rob', 'alex'];
      const expectedPrevNames = [null, 'greg', 'tony', 'vassili', 'rob'];

      const valueOrder: string[] = [];
      const addedOrder: string[] = [];
      const addedPrevNames: (string | null)[] = [];

      const orderedRef = ref.orderByValue();

      const unsubValue = orderedRef.on('value', snap => {
        snap.forEach(childSnap => {
          valueOrder.push(childSnap.key!);
        });
      });

      const unsubAdded = orderedRef.on('child_added', (snap, prevName) => {
        addedOrder.push(snap.key!);
        addedPrevNames.push(prevName);
      });

      await ref.set(initial);
      await pause(WRITE_DELAY);

      // Wait for events
      await pause(100);

      expect(addedOrder).toEqual(expectedOrder);
      expect(valueOrder).toEqual(expectedOrder);
      expect(addedPrevNames).toEqual(expectedPrevNames);

      unsubValue();
      unsubAdded();
    });

    it('startAt/endAt works on value index', async () => {
      const ref = await getRandomNode();

      const initial = {
        alex: 60,
        rob: 56,
        vassili: 55.5,
        tony: 52,
        greg: 52
      };

      const expectedOrder = ['tony', 'vassili', 'rob'];

      const addedOrder: string[] = [];

      const orderedRef = ref.orderByValue().startAt(52, 'tony').endAt(59);

      const unsubAdded = orderedRef.on('child_added', snap => {
        addedOrder.push(snap.key!);
      });

      await ref.set(initial);
      await pause(WRITE_DELAY);

      // Wait for events
      await pause(100);

      expect(addedOrder).toEqual(expectedOrder);

      unsubAdded();
    });
  });

  describe('orderByKey', () => {
    it('can use key index with startAt', async () => {
      const ref = await getRandomNode();

      const data = {
        a: 'a',
        b: 'b',
        c: 'c',
        d: 'd',
        e: 'e',
        f: 'f'
      };

      await ref.set(data);
      await pause(WRITE_DELAY);

      const snap = await ref.orderByKey().startAt('c').once('value');

      const keys: string[] = [];
      snap.forEach(child => {
        keys.push(child.key!);
      });

      expect(keys).toEqual(['c', 'd', 'e', 'f']);
    });

    it('server respects KeyIndex with limitToFirst', async () => {
      const ref = await getRandomNode();

      const initial = {
        a: 1,
        b: 2,
        c: 3
      };

      await ref.set(initial);
      await pause(WRITE_DELAY);

      const snap = await ref.orderByKey().startAt('b').limitToFirst(2).once('value');

      const keys: string[] = [];
      snap.forEach(child => {
        keys.push(child.key!);
      });

      expect(keys).toEqual(['b', 'c']);
    });
  });

  describe('Deep child orderBy', () => {
    it('can define and use a deep index', async () => {
      const ref = await getRandomNode();

      const initial = {
        alex: { deep: { nuggets: 60 } },
        rob: { deep: { nuggets: 56 } },
        vassili: { deep: { nuggets: 55.5 } },
        tony: { deep: { nuggets: 52 } },
        greg: { deep: { nuggets: 52 } }
      };

      const expectedOrder = ['greg', 'tony', 'vassili'];

      const addedOrder: string[] = [];

      const orderedRef = ref.orderByChild('deep/nuggets').limitToFirst(3);

      const unsubAdded = orderedRef.on('child_added', snap => {
        addedOrder.push(snap.key!);
      });

      await ref.set(initial);
      await pause(WRITE_DELAY);

      // Wait for events
      await pause(100);

      expect(addedOrder).toEqual(expectedOrder);

      unsubAdded();
    });
  });
});

// =============================================================================
// Transaction Tests (from transaction.test.ts)
// =============================================================================

// TODO: Transaction tests skipped - transactions are not local-first (may retry with different values)
describe.skip('Firebase Compat: Transaction Tests', () => {
  beforeAll(async () => {
    db = new LarkDatabase(TEST_DATABASE, { anonymous: true });
    await db.connect(TEST_DATABASE, { anonymous: true });
  });

  afterAll(async () => {
    await db.disconnect();
  });

  describe('Basic transactions', () => {
    it('new value is immediately visible', async () => {
      const ref = await getRandomNode();

      let val: unknown = null;
      const unsub = ref.child('foo').on('value', snap => {
        val = snap.val();
      });

      // Start transaction - value should be visible immediately (optimistic)
      ref.child('foo').transaction(() => 42);

      expect(val).toBe(42);
      unsub();
    });

    it('non-aborted transaction sets committed to true', async () => {
      const ref = await getRandomNode();

      const result = await ref.transaction(() => 42);

      expect(result.committed).toBe(true);
      expect(result.snapshot.val()).toBe(42);
    });

    it('aborted transaction sets committed to false', async () => {
      const ref = await getRandomNode();

      const result = await ref.transaction(() => undefined);

      expect(result.committed).toBe(false);
      expect(result.snapshot.val()).toBe(null);
    });

    it('transaction can increment counter', async () => {
      const ref = await getRandomNode();
      await ref.set(0);
      await pause(WRITE_DELAY);

      const result = await ref.transaction(current => {
        return (current || 0) + 1;
      });

      expect(result.committed).toBe(true);
      expect(result.snapshot.val()).toBe(1);
    });
  });
});

// =============================================================================
// off() Tests (from query.test.ts)
// =============================================================================

describe('Firebase Compat: off() Tests', () => {
  beforeAll(async () => {
    db = new LarkDatabase(TEST_DATABASE, { anonymous: true });
    await db.connect(TEST_DATABASE, { anonymous: true });
  });

  afterAll(async () => {
    await db.disconnect();
  });

  describe('Query.off variations', () => {
    it('off() can be called on default query', async () => {
      const ref = await getRandomNode();
      let eventFired = false;

      const unsub = ref.limitToLast(5).on('value', () => {
        eventFired = true;
      });

      await ref.set({ a: 5, b: 6 });
      expect(eventFired).toBe(true);

      eventFired = false;
      unsub();  // Unsubscribe via returned function

      await ref.set({ a: 6, b: 5 });
      await pause(100);
      expect(eventFired).toBe(false);
    });

    it('off(eventType) removes all callbacks for that type', async () => {
      const ref = await getRandomNode();
      let count = 0;

      const unsub1 = ref.on('value', () => { count++; });
      const unsub2 = ref.on('value', () => { count++; });

      await ref.set({ a: 5 });
      expect(count).toBe(2);

      count = 0;
      ref.off('value');  // Remove all value listeners

      await ref.set({ a: 6 });
      await pause(100);
      expect(count).toBe(0);
    });

    it('off() with no args removes all callbacks', async () => {
      const ref = await getRandomNode();
      let valueCount = 0;
      let childCount = 0;

      ref.on('value', () => { valueCount++; });
      ref.on('child_added', () => { childCount++; });

      await ref.set({ a: 5 });
      expect(valueCount).toBeGreaterThan(0);

      valueCount = 0;
      childCount = 0;
      ref.off();  // Remove all listeners

      await ref.set({ b: 6 });
      await pause(100);
      expect(valueCount).toBe(0);
      expect(childCount).toBe(0);
    });
  });
});

// =============================================================================
// Firebase features - verify these work
// =============================================================================

describe('Firebase Compat: Additional Features', () => {
  beforeAll(async () => {
    db = new LarkDatabase(TEST_DATABASE, { anonymous: true });
    await db.connect(TEST_DATABASE, { anonymous: true });
  });

  afterAll(async () => {
    await db.disconnect();
  });

  it('priorities work with setWithPriority and getPriority', async () => {
    const ref = await getRandomNode();
    await ref.setWithPriority('test value', 42);
    await pause(WRITE_DELAY);

    const snap = await ref.once('value');
    expect(snap.val()).toBe('test value');
    expect(snap.getPriority()).toBe(42);
  });

  it('ServerValue.TIMESTAMP works', async () => {
    const ref = await getRandomNode();
    await ref.set({ createdAt: { '.sv': 'timestamp' } });
    await pause(WRITE_DELAY);

    const snap = await ref.once('value');
    const val = snap.val();
    expect(typeof val.createdAt).toBe('number');
    // Should be a reasonable timestamp (after year 2020)
    expect(val.createdAt).toBeGreaterThan(1577836800000);
  });

  it('startAfter/endBefore work', async () => {
    const ref = await getRandomNode();
    await ref.set({
      a: 1,
      b: 2,
      c: 3,
      d: 4,
      e: 5
    });
    await pause(WRITE_DELAY);

    // startAfter('b') should return c, d, e
    const snap1 = await ref.orderByKey().startAfter('b').once('value');
    const keys1: string[] = [];
    snap1.forEach(child => { keys1.push(child.key!); });
    expect(keys1).toEqual(['c', 'd', 'e']);

    // endBefore('d') should return a, b, c
    const snap2 = await ref.orderByKey().endBefore('d').once('value');
    const keys2: string[] = [];
    snap2.forEach(child => { keys2.push(child.key!); });
    expect(keys2).toEqual(['a', 'b', 'c']);
  });

  it('.info/connected works', async () => {
    const connectedRef = db.ref('.info/connected');
    const snap = await connectedRef.once('value');
    expect(snap.val()).toBe(true);
  });

  it('.info/serverTimeOffset works', async () => {
    const offsetRef = db.ref('.info/serverTimeOffset');
    const snap = await offsetRef.once('value');
    expect(typeof snap.val()).toBe('number');
  });
});
