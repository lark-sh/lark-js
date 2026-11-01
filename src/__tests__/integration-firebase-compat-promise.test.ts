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
 * Firebase Compatibility Tests - Promise
 * Ported from: firebase-js-sdk/packages/database-compat/test/promise.test.ts
 *
 * NOTE: This test suite is marked as describe.skip in Firebase's own tests because it's flaky.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LarkDatabase } from '../LarkDatabase';
import { DatabaseReference } from '../DatabaseReference';

// Test configuration
const TEST_PROJECT = 'javascript-integration';
const testRunId = `promise-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

function getRootNode(index?: number, path?: string): DatabaseReference {
  if (path) {
    return db.ref(path);
  }
  return db.ref();
}

beforeAll(async () => {
  db = new LarkDatabase(`${TEST_PROJECT}/test`, { anonymous: true });
  await db.connect(`${TEST_PROJECT}/test`, { anonymous: true });
});

afterAll(async () => {
  try { await db.ref(testRunId).remove(); } catch (e) {}
  await db.disconnect();
});

/**
 * This test suite is super flaky, random test fail at random times for
 * no predictable reason. Skipping for now but adding todo to come back
 * later and fix this
 */
// TODO: Fix the flaky test suite
describe.skip('Promise Tests', () => {
  it('wraps Query.once', () => {
    return (getRandomNode() as DatabaseReference).once('value').then(snap => {
      expect(snap.val()).toEqual(null);
    });
  });

  it('wraps Firebase.set', () => {
    const ref = getRandomNode() as DatabaseReference;
    return ref
      .set(5)
      .then(() => {
        return ref.once('value');
      })
      .then(read => {
        expect(read.val()).toEqual(5);
      });
  });

  it('wraps Firebase.push when no value is passed', () => {
    const ref = getRandomNode() as DatabaseReference;
    const pushed = ref.push();
    return pushed
      .then(childRef => {
        expect(pushed.ref.parent.toString()).toEqual(ref.toString());
        expect(pushed.toString()).toEqual(childRef.toString());
        return pushed.once('value');
      })
      .then(snap => {
        expect(snap.val()).toEqual(null);
        expect(snap.ref.toString()).toEqual(pushed.toString());
      });
  });

  it('wraps Firebase.push when a value is passed', () => {
    const ref = getRandomNode() as DatabaseReference;
    const pushed = ref.push(6);
    return pushed
      .then(childRef => {
        expect(pushed.ref.parent.toString()).toEqual(ref.toString());
        expect(pushed.toString()).toEqual(childRef.toString());
        return pushed.once('value');
      })
      .then(snap => {
        expect(snap.val()).toEqual(6);
        expect(snap.ref.toString()).toEqual(pushed.toString());
      });
  });

  it('wraps Firebase.remove', () => {
    const ref = getRandomNode() as DatabaseReference;
    return ref
      .set({ a: 'b' })
      .then(() => {
        const p = ref.child('a').remove();
        expect(typeof p.then === 'function').toEqual(true);
        return p;
      })
      .then(() => {
        return ref.once('value');
      })
      .then(snap => {
        expect(snap.val()).toEqual(null);
      });
  });

  it('wraps Firebase.update', () => {
    const ref = getRandomNode() as DatabaseReference;
    return ref
      .set({ a: 'b' })
      .then(() => {
        const p = ref.update({ c: 'd' });
        expect(typeof p.then === 'function').toEqual(true);
        return p;
      })
      .then(() => {
        return ref.once('value');
      })
      .then(snap => {
        expect(snap.val()).toEqual({ a: 'b', c: 'd' });
      });
  });

  it('wraps Firebase.setPriority', () => {
    const ref = getRandomNode() as DatabaseReference;
    return ref
      .set({ a: 'b' })
      .then(() => {
        const p = ref.child('a').setPriority(5);
        expect(typeof p.then === 'function').toEqual(true);
        return p;
      })
      .then(() => {
        return ref.once('value');
      })
      .then(snap => {
        expect(snap.child('a').getPriority()).toEqual(5);
      });
  });

  it('wraps Firebase.setWithPriority', () => {
    const ref = getRandomNode() as DatabaseReference;
    return ref
      .setWithPriority('hi', 5)
      .then(() => {
        return ref.once('value');
      })
      .then(snap => {
        expect(snap.getPriority()).toEqual(5);
        expect(snap.val()).toEqual('hi');
      });
  });

  it('wraps Firebase.transaction', () => {
    const ref = getRandomNode() as DatabaseReference;
    return ref
      .transaction(() => {
        return 5;
      })
      .then(result => {
        expect(result.committed).toEqual(true);
        expect(result.snapshot.val()).toEqual(5);
        return ref.transaction(() => {
          return undefined;
        });
      })
      .then(result => {
        expect(result.committed).toEqual(false);
      });
  });

  it('exposes catch in the return of Firebase.push', () => {
    // Catch is a pain in the bum to provide safely because "catch" is a reserved word and ES3 and below require
    // you to use quotes to define it, but the closure linter really doesn't want you to do that either.
    const ref = getRandomNode() as DatabaseReference;
    const pushed = ref.push(6);

    expect(typeof ref.then === 'function').toEqual(false);
    expect(typeof ref.catch === 'function').toEqual(false);
    expect(typeof pushed.then === 'function').toEqual(true);
    expect(typeof pushed.catch === 'function').toEqual(true);
    return pushed;
  });

  it('wraps onDisconnect.remove', () => {
    const refs = getRandomNode(2) as DatabaseReference[];
    const writer = refs[0];
    const reader = refs[1];
    const refInfo = getRootNode(0, '.info/connected');

    refInfo.once('value', snapshot => {
      expect(snapshot.val()).toEqual(true);
    });

    return writer
      .child('here today')
      .set('gone tomorrow')
      .then(() => {
        const p = writer.child('here today').onDisconnect().remove();
        expect(typeof p.then === 'function').toEqual(true);
        return p;
      })
      .then(() => {
        writer.database.goOffline();
        writer.database.goOnline();
        return reader.once('value');
      })
      .then(snap => {
        expect(snap.val()).toEqual(null);
      });
  });

  it('wraps onDisconnect.update', () => {
    const refs = getRandomNode(2) as DatabaseReference[];
    const writer = refs[0];
    const reader = refs[1];
    return writer
      .set({ foo: 'baz' })
      .then(() => {
        const p = writer.onDisconnect().update({ foo: 'bar' });
        expect(typeof p.then === 'function').toEqual(true);
        return p;
      })
      .then(() => {
        writer.database.goOffline();
        writer.database.goOnline();
        return reader.once('value');
      })
      .then(snap => {
        expect(snap.val()).toEqual({ foo: 'bar' });
      });
  });

  it('wraps onDisconnect.set', () => {
    const refs = getRandomNode(2) as DatabaseReference[];
    const writer = refs[0];
    const reader = refs[1];
    return writer
      .child('hello')
      .onDisconnect()
      .set('world')
      .then(() => {
        writer.database.goOffline();
        writer.database.goOnline();
        return reader.once('value');
      })
      .then(snap => {
        expect(snap.val()).toEqual({ hello: 'world' });
      });
  });

  it('wraps onDisconnect.setWithPriority', () => {
    const refs = getRandomNode(2) as DatabaseReference[];
    const writer = refs[0];
    const reader = refs[1];
    return writer
      .child('meaning of life')
      .onDisconnect()
      .setWithPriority('ultimate question', 42)
      .then(() => {
        writer.database.goOffline();
        writer.database.goOnline();
        return reader.once('value');
      })
      .then(snap => {
        expect(snap.val()).toEqual({
          'meaning of life': 'ultimate question'
        });
        expect(snap.child('meaning of life').getPriority()).toEqual(42);
      });
  });
});
