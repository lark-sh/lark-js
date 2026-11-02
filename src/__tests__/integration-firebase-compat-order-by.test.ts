/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * This file contains test code derived from the Firebase JS SDK.
 * https://github.com/firebase/firebase-js-sdk
 * Modified for Lark compatibility testing.
 */

// @ts-nocheck
/**
 * Firebase Compatibility Tests - Order By
 * Ported from: firebase-js-sdk/packages/database-compat/test/order_by.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LarkDatabase } from '../LarkDatabase';
import { DatabaseReference } from '../DatabaseReference';

// Test configuration
const TEST_PROJECT = 'javascript-integration';
const testRunId = `order-by-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let db: LarkDatabase;

// Helpers to match Firebase's test helpers
function getRandomNode(count?: number): DatabaseReference | DatabaseReference[] {
  // Generate ONE random path - when count > 1, all refs point to the SAME path
  // This simulates Firebase's behavior of multiple connections to the same location
  const path = `${testRunId}/node-${Math.random().toString(36).slice(2, 8)}`;
  if (count) {
    const refs: DatabaseReference[] = [];
    for (let i = 0; i < count; i++) {
      refs.push(db.ref(path));
    }
    return refs;
  }
  return db.ref(path);
}

// EventAccumulatorFactory matching Firebase's interface
const EventAccumulatorFactory = {
  waitsForCount(count: number) {
    const events: any[] = [];
    let resolve: ((events: any[]) => void) | null = null;
    return {
      addEvent(event?: any) {
        events.push(event);
        if (events.length >= count && resolve) {
          resolve(events);
        }
      },
      get promise(): Promise<any[]> {
        if (events.length >= count) {
          return Promise.resolve(events);
        }
        return new Promise(r => { resolve = r; });
      }
    };
  }
};

beforeAll(async () => {
  db = new LarkDatabase(`${TEST_PROJECT}/test`, { anonymous: true });
  await db.connect(`${TEST_PROJECT}/test`, { anonymous: true });
});

afterAll(async () => {
  try { await db.ref(testRunId).remove(); } catch (e) {}
  await db.disconnect();
});

describe('.orderBy tests', () => {
  // TODO: setup spy on console.warn

  it('Snapshots are iterated in order', () => {
    const ref = getRandomNode() as DatabaseReference;

    const initial = {
      alex: { nuggets: 60 },
      rob: { nuggets: 56 },
      vassili: { nuggets: 55.5 },
      tony: { nuggets: 52 },
      greg: { nuggets: 52 }
    };

    const expectedOrder = ['greg', 'tony', 'vassili', 'rob', 'alex'];
    const expectedPrevNames = [null, 'greg', 'tony', 'vassili', 'rob'];

    const valueOrder = [];
    const addedOrder = [];
    const addedPrevNames = [];

    const orderedRef = ref.orderByChild('nuggets');

    orderedRef.on('value', snap => {
      snap.forEach(childSnap => {
        valueOrder.push(childSnap.key);
      });
    });

    orderedRef.on('child_added', (snap, prevName) => {
      addedOrder.push(snap.key);
      addedPrevNames.push(prevName);
    });

    ref.set(initial);

    expect(addedOrder).toEqual(expectedOrder);
    expect(valueOrder).toEqual(expectedOrder);
    expect(addedPrevNames).toEqual(expectedPrevNames);
  });

  it('Snapshots are iterated in order for value', () => {
    const ref = getRandomNode() as DatabaseReference;

    const initial = {
      alex: 60,
      rob: 56,
      vassili: 55.5,
      tony: 52,
      greg: 52
    };

    const expectedOrder = ['greg', 'tony', 'vassili', 'rob', 'alex'];
    const expectedPrevNames = [null, 'greg', 'tony', 'vassili', 'rob'];

    const valueOrder = [];
    const addedOrder = [];
    const addedPrevNames = [];

    const orderedRef = ref.orderByValue();

    orderedRef.on('value', snap => {
      snap.forEach(childSnap => {
        valueOrder.push(childSnap.key);
      });
    });

    orderedRef.on('child_added', (snap, prevName) => {
      addedOrder.push(snap.key);
      addedPrevNames.push(prevName);
    });

    ref.set(initial);

    expect(addedOrder).toEqual(expectedOrder);
    expect(valueOrder).toEqual(expectedOrder);
    expect(addedPrevNames).toEqual(expectedPrevNames);
  });

  it('Fires child_moved events', () => {
    const ref = getRandomNode() as DatabaseReference;

    const initial = {
      alex: { nuggets: 60 },
      rob: { nuggets: 56 },
      vassili: { nuggets: 55.5 },
      tony: { nuggets: 52 },
      greg: { nuggets: 52 }
    };

    const orderedRef = ref.orderByChild('nuggets');

    let moved = false;
    orderedRef.on('child_moved', (snap, prevName) => {
      moved = true;
      expect(snap.key).toEqual('greg');
      expect(prevName).toEqual('rob');
      expect(snap.val()).toEqual({ nuggets: 57 });
    });

    ref.set(initial);
    ref.child('greg/nuggets').set(57);
    expect(moved).toEqual(true);
  });

  // Skip: Uses v8-style off(eventType, callback) pattern where on() returns the callback
  it.skip('Callback removal works', async () => {
    const ref = getRandomNode() as DatabaseReference;

    let reads = 0;
    const ea = EventAccumulatorFactory.waitsForCount(4);

    const fooCb = ref.orderByChild('foo').on('value', () => {
      reads++;
      ea.addEvent();
    });
    const barCb = ref.orderByChild('bar').on('value', () => {
      reads++;
      ea.addEvent();
    });
    const bazCb = ref.orderByChild('baz').on('value', () => {
      reads++;
      ea.addEvent();
    });
    ref.on('value', () => {
      reads++;
      ea.addEvent();
    });

    ref.set(1);

    await ea.promise;

    ref.off('value', fooCb);
    ref.set(2);
    expect(reads).toEqual(7);

    // Should be a no-op, resulting in 3 more reads
    ref.orderByChild('foo').off('value', bazCb);
    ref.set(3);
    expect(reads).toEqual(10);

    ref.orderByChild('bar').off('value');
    ref.set(4);
    expect(reads).toEqual(12);

    // Now, remove everything
    ref.off();
    ref.set(5);
    expect(reads).toEqual(12);
  });

  it('child_added events are in the correct order', () => {
    const ref = getRandomNode() as DatabaseReference;

    const initial = {
      a: { value: 5 },
      c: { value: 3 }
    };

    const added = [];
    ref.orderByChild('value').on('child_added', snap => {
      added.push(snap.key);
    });
    ref.set(initial);

    expect(added).toEqual(['c', 'a']);

    ref.update({
      b: { value: 4 },
      d: { value: 2 }
    });

    expect(added).toEqual(['c', 'a', 'd', 'b']);
  });

  it('Can use key index', async () => {
    const ref = getRandomNode() as DatabaseReference;

    const data = {
      a: { '.priority': 10, '.value': 'a' },
      b: { '.priority': 5, '.value': 'b' },
      c: { '.priority': 20, '.value': 'c' },
      d: { '.priority': 7, '.value': 'd' },
      e: { '.priority': 30, '.value': 'e' },
      f: { '.priority': 8, '.value': 'f' }
    };

    await ref.set(data);

    const snap = await ref.orderByKey().startAt('c').once('value');

    let keys = [];
    snap.forEach(child => {
      keys.push(child.key);
    });
    expect(keys).toEqual(['c', 'd', 'e', 'f']);

    const ea = EventAccumulatorFactory.waitsForCount(5);
    keys = [];

    ref
      .orderByKey()
      .limitToLast(5)
      .on('child_added', child => {
        keys.push(child.key);
        ea.addEvent();
      });

    await ea.promise;

    ref.orderByKey().off();
    expect(keys).toEqual(['b', 'c', 'd', 'e', 'f']);
  });

  it('Queries work on leaf nodes', done => {
    const ref = getRandomNode() as DatabaseReference;

    ref.set('leaf-node', () => {
      ref
        .orderByChild('foo')
        .limitToLast(1)
        .on('value', snap => {
          expect(snap.val()).toBeNull();
          done();
        });
    });
  });

  it('Updates for unindexed queries work', done => {
    const refs = getRandomNode(2) as DatabaseReference[];
    const reader = refs[0];
    const writer = refs[1];

    const value = {
      one: { index: 1, value: 'one' },
      two: { index: 2, value: 'two' },
      three: { index: 3, value: 'three' }
    };

    let count = 0;

    writer.set(value, () => {
      reader
        .orderByChild('index')
        .limitToLast(2)
        .on('value', snap => {
          if (count === 0) {
            expect(snap.val()).toEqual({
              two: { index: 2, value: 'two' },
              three: { index: 3, value: 'three' }
            });
            // update child which should trigger value event
            writer.child('one/index').set(4);
          } else if (count === 1) {
            expect(snap.val()).toEqual({
              three: { index: 3, value: 'three' },
              one: { index: 4, value: 'one' }
            });
            done();
          }
          count++;
        });
    });
  });

  it('Server respects KeyIndex', done => {
    const refs = getRandomNode(2) as DatabaseReference[];
    const reader = refs[0];
    const writer = refs[1];

    const initial = {
      a: 1,
      b: 2,
      c: 3
    };

    const expected = ['b', 'c'];

    const actual = [];

    const orderedRef = reader.orderByKey().startAt('b').limitToFirst(2);
    writer.set(initial, () => {
      orderedRef.on('value', snap => {
        snap.forEach(childSnap => {
          actual.push(childSnap.key);
        });
        expect(actual).toEqual(expected);
        done();
      });
    });
  });

  it('startAt/endAt works on value index', () => {
    const ref = getRandomNode() as DatabaseReference;

    const initial = {
      alex: 60,
      rob: 56,
      vassili: 55.5,
      tony: 52,
      greg: 52
    };

    const expectedOrder = ['tony', 'vassili', 'rob'];
    const expectedPrevNames = [null, 'tony', 'vassili'];

    const valueOrder = [];
    const addedOrder = [];
    const addedPrevNames = [];

    const orderedRef = ref.orderByValue().startAt(52, 'tony').endAt(59);

    orderedRef.on('value', snap => {
      snap.forEach(childSnap => {
        valueOrder.push(childSnap.key);
      });
    });

    orderedRef.on('child_added', (snap, prevName) => {
      addedOrder.push(snap.key);
      addedPrevNames.push(prevName);
    });

    ref.set(initial);

    expect(addedOrder).toEqual(expectedOrder);
    expect(valueOrder).toEqual(expectedOrder);
    expect(addedPrevNames).toEqual(expectedPrevNames);
  });

  it('startAfter / endAt works on value index', () => {
    const ref = getRandomNode() as DatabaseReference;

    const initial = {
      alex: 60,
      rob: 56,
      vassili: 55.5,
      tony: 52,
      greg: 52
    };

    const expectedOrder = ['vassili', 'rob'];
    const expectedPrevNames = [null, 'vassili'];

    const valueOrder = [];
    const addedOrder = [];
    const addedPrevNames = [];

    const orderedRef = ref.orderByValue().startAfter(52, 'tony').endAt(59);

    orderedRef.on('value', snap => {
      snap.forEach(childSnap => {
        valueOrder.push(childSnap.key);
      });
    });

    orderedRef.on('child_added', (snap, prevName) => {
      addedOrder.push(snap.key);
      addedPrevNames.push(prevName);
    });

    ref.set(initial);

    expect(addedOrder).toEqual(expectedOrder);
    expect(valueOrder).toEqual(expectedOrder);
    expect(addedPrevNames).toEqual(expectedPrevNames);
  });

  it('startAt / endBefore works on value index', () => {
    const ref = getRandomNode() as DatabaseReference;

    const initial = {
      alex: 60,
      rob: 56,
      vassili: 55.5,
      tony: 52,
      greg: 52
    };

    const expectedOrder = ['tony', 'vassili', 'rob'];
    const expectedPrevNames = [null, 'tony', 'vassili'];

    const valueOrder = [];
    const addedOrder = [];
    const addedPrevNames = [];

    const orderedRef = ref.orderByValue().startAt(52, 'tony').endBefore(60);

    orderedRef.on('value', snap => {
      snap.forEach(childSnap => {
        valueOrder.push(childSnap.key);
      });
    });

    orderedRef.on('child_added', (snap, prevName) => {
      addedOrder.push(snap.key);
      addedPrevNames.push(prevName);
    });

    ref.set(initial);

    expect(addedOrder).toEqual(expectedOrder);
    expect(valueOrder).toEqual(expectedOrder);
    expect(addedPrevNames).toEqual(expectedPrevNames);
  });

  it('startAfter / endBefore works on value index', () => {
    const ref = getRandomNode() as DatabaseReference;

    const initial = {
      alex: 60,
      rob: 56,
      vassili: 55.5,
      tony: 52,
      greg: 52
    };

    const expectedOrder = ['vassili', 'rob'];
    const expectedPrevNames = [null, 'vassili'];

    const valueOrder = [];
    const addedOrder = [];
    const addedPrevNames = [];

    const orderedRef = ref.orderByValue().startAfter(52, 'tony').endBefore(60);

    orderedRef.on('value', snap => {
      snap.forEach(childSnap => {
        valueOrder.push(childSnap.key);
      });
    });

    orderedRef.on('child_added', (snap, prevName) => {
      addedOrder.push(snap.key);
      addedPrevNames.push(prevName);
    });

    ref.set(initial);

    expect(addedOrder).toEqual(expectedOrder);
    expect(valueOrder).toEqual(expectedOrder);
    expect(addedPrevNames).toEqual(expectedPrevNames);
  });

  it('Removing default listener removes non-default listener that loads all data', done => {
    const ref = getRandomNode() as DatabaseReference;

    const initial = { key: 'value' };
    ref.set(initial, err => {
      expect(err).toBeNull();
      ref.orderByKey().on('value', () => {});
      ref.on('value', () => {});
      // Should remove both listener and should remove the listen sent to the server
      ref.off();

      // This used to crash because a listener for ref.orderByKey() existed already
      ref.orderByKey().once('value', snap => {
        expect(snap.val()).toEqual(initial);
        done();
      });
    });
  });

  it('Can define and use an deep index', done => {
    const ref = getRandomNode() as DatabaseReference;

    const initial = {
      alex: { deep: { nuggets: 60 } },
      rob: { deep: { nuggets: 56 } },
      vassili: { deep: { nuggets: 55.5 } },
      tony: { deep: { nuggets: 52 } },
      greg: { deep: { nuggets: 52 } }
    };

    const expectedOrder = ['greg', 'tony', 'vassili'];
    const expectedPrevNames = [null, 'greg', 'tony'];

    const valueOrder = [];
    const addedOrder = [];
    const addedPrevNames = [];

    const orderedRef = ref.orderByChild('deep/nuggets').limitToFirst(3);

    // come before value event
    orderedRef.on('child_added', (snap, prevName) => {
      addedOrder.push(snap.key);
      addedPrevNames.push(prevName);
    });

    orderedRef.once('value', snap => {
      snap.forEach(childSnap => {
        valueOrder.push(childSnap.key);
      });
    });

    ref.set(initial, err => {
      expect(err).toBeNull();
      expect(addedOrder).toEqual(expectedOrder);
      expect(valueOrder).toEqual(expectedOrder);
      expect(addedPrevNames).toEqual(expectedPrevNames);
      done();
    });
  });
});
