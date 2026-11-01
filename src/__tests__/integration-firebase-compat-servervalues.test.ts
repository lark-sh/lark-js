/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * This file contains test code derived from the Firebase JS SDK.
 * https://github.com/firebase/firebase-js-sdk
 * Modified for Lark compatibility testing.
 */

/**
 * Firebase Compatibility Tests - ServerValues
 * Ported from: firebase-js-sdk/packages/database-compat/test/servervalues.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LarkDatabase } from '../LarkDatabase';
import { DatabaseReference } from '../DatabaseReference';

// Test configuration
const TEST_PROJECT = 'javascript-integration';
const testRunId = `servervalues-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

// Database.ServerValue - needs to match Firebase's API
const Database = {
  ServerValue: {
    TIMESTAMP: { '.sv': 'timestamp' },
    increment: (delta: number) => ({ '.sv': { 'increment': delta } })
  }
};

beforeAll(async () => {
  db = new LarkDatabase(`${TEST_PROJECT}/test`, { anonymous: true });
  await db.connect();
});

afterAll(async () => {
  try { await db.ref(testRunId).remove(); } catch (e) {}
  await db.disconnect();
});

describe('ServerValue tests', () => {
  it('resolves timestamps locally', async () => {
    const node = getRandomNode() as DatabaseReference;
    const start = Date.now();
    const values: number[] = [];
    node.on('value', snap => {
      expect(typeof snap.val()).toEqual('number');
      values.push(snap.val() as number);
    });
    await node.set(Database.ServerValue.TIMESTAMP);
    node.off('value');

    // By the time the write is acknowledged, we should have a local and
    // server version of the timestamp. If both land on the same millisecond the
    // value didn't change, so only one event fires.
    expect([1, 2]).toContain(values.length);
    values.forEach(serverTime => {
      const delta = Math.abs(serverTime - start);
      expect(delta).toBeLessThan(1000);
    });
  });

  it('handles increments without listeners', async () => {
    // Ensure that increments don't explode when the SyncTree must return a null
    // node (i.e. ChildrenNode.EMPTY_NODE) because there is not yet any synced
    // data.
    const node = getRandomNode() as DatabaseReference;
    await node.set(Database.ServerValue.increment(1));
  });

  describe('handles increments', () => {
    // Skip offline mode - we don't support queuing writes while offline
    for (const mode of ['online']) {
      const maybeAwait = async (p: Promise<any>) => {
        if (mode === 'online') {
          await p;
        }
      };

      it(mode, async () => {
        const node = getRandomNode() as DatabaseReference;
        if (mode === 'offline') {
          node.database.goOffline();
        }

        const addOne = Database.ServerValue.increment(1);

        const values: any = [];
        const expected: any = [];
        node.on('value', snap => values.push(snap.val()));

        // null -> increment(x) = x
        maybeAwait(node.set(addOne));
        expected.push(1);

        // x -> increment(y) = x + y
        maybeAwait(node.set(5));
        maybeAwait(node.set(addOne));
        expected.push(5);
        expected.push(6);

        // str -> increment(x) = x
        maybeAwait(node.set('hello'));
        maybeAwait(node.set(addOne));
        expected.push('hello');
        expected.push(1);

        // obj -> increment(x) = x
        maybeAwait(node.set({ 'hello': 'world' }));
        maybeAwait(node.set(addOne));
        expected.push({ 'hello': 'world' });
        expected.push(1);

        node.off('value');
        expect(values).toEqual(expected);
        node.database.goOnline();
      });
    }
  });

  it('handles sparse updates', async () => {
    const node = getRandomNode() as DatabaseReference;

    let value: any = null;
    let events = 0;
    node.on('value', snap => {
      value = snap.val();
      events++;
    });

    await node.update({
      'child/increment': Database.ServerValue.increment(1),
      'literal': 5
    });
    expect(value).toEqual({
      'literal': 5,
      'child': {
        'increment': 1
      }
    });

    await node.update({
      'child/increment': Database.ServerValue.increment(41)
    });
    expect(value).toEqual({
      'literal': 5,
      'child': {
        'increment': 42
      }
    });

    node.off('value');

    expect(events).toEqual(2);
  });

  it('handles races', async () => {
    const node = getRandomNode() as DatabaseReference;
    const all: Array<Promise<any>> = [];
    const racers = 100;

    for (let i = 0; i < racers; i++) {
      all.push(node.set(Database.ServerValue.increment(1)));
    }
    await Promise.all(all);

    const snap = await node.once('value');
    expect(snap.val()).toEqual(racers);
  });
});
