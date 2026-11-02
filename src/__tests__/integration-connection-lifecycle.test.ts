/**
 * Integration tests for using the database before it's connected, and while
 * offline.
 *
 * These tests verify:
 * 1. A write made before connecting is applied locally at once and sent once connected
 * 2. A volatile write made before connecting doesn't wait for an ack
 * 3. A rejected token fails the connection quickly, and held writes roll back
 * 4. Writes and listeners made after goOffline() go out on goOnline()
 *
 * Requires security rules on javascript-integration project:
 * - /__volatile__/* - read: true, write: true, .volatile: true
 *
 * Run with: npm run test:integration
 */

import { describe, it, expect, afterEach } from 'vitest';
import { LarkDatabase } from '../LarkDatabase';
import { LarkError } from '../LarkError';
import { DATABASE_ID } from './integration-utils';

const OPTIONS = { anonymous: true };

const open: LarkDatabase[] = [];
function newDb(options: Record<string, unknown> = OPTIONS): LarkDatabase {
  const db = new LarkDatabase(DATABASE_ID, options);
  open.push(db);
  return db;
}

function testPath(name: string): string {
  return `lifecycle/${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Resolves with 'resolved', 'rejected', or 'pending' if `promise` hasn't settled by `ms`. */
function settled(promise: Promise<unknown>, ms: number): Promise<string> {
  return Promise.race([
    promise.then(
      () => 'resolved',
      () => 'rejected'
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('pending'), ms)),
  ]);
}

afterEach(async () => {
  for (const db of open.splice(0)) {
    await db.disconnect().catch(() => {});
  }
});

describe('Before connecting', () => {
  it('applies a write locally at once and sends it once connected', async () => {
    const db = newDb();
    const path = testPath('early-write');
    const seen: unknown[] = [];
    db.ref(path).on('value', (snap) => seen.push(snap.val()));

    const write = db.ref(path).set({ hello: 'world' });
    expect(db.state).not.toBe('authenticated');
    expect(seen).toEqual([{ hello: 'world' }]);

    await write;
    const reader = newDb();
    expect((await reader.ref(path).once('value')).val()).toEqual({ hello: 'world' });
  });

  it('sends writes made before connecting in order', async () => {
    const db = newDb();
    const path = testPath('early-order');
    const writes = [1, 2, 3].map((n) => db.ref(path).set(n));
    await Promise.all(writes);

    const reader = newDb();
    expect((await reader.ref(path).once('value')).val()).toBe(3);
  });

  it('does not wait for an ack on a volatile write', async () => {
    const db = newDb();
    const write = db.ref(`__volatile__/${testPath('early-volatile')}`).set({ x: 1 });
    expect(await settled(write, 5000)).toBe('resolved');
    expect(db.getPendingWriteCount()).toBe(0);
  });
});

describe('Rejected token', () => {
  it('fails the connection quickly and reports it to onError', async () => {
    const db = newDb({ ...OPTIONS, anonymous: false, token: 'not-a-real-token' });
    const errors: Error[] = [];
    db.onError((error) => errors.push(error));

    const started = Date.now();
    const error = await db.connect().catch((e) => e);
    expect(error).toBeInstanceOf(LarkError);
    expect(error.code).toBe('auth_failed');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(errors).toHaveLength(1);
  });

  it('rejects a held write and rolls back its local change', async () => {
    const db = newDb({ ...OPTIONS, anonymous: false, token: 'not-a-real-token' });
    const path = testPath('rejected-write');
    const seen: unknown[] = [];
    db.ref(path).on('value', (snap) => seen.push(snap.val()));

    const error = await db
      .ref(path)
      .set('local only')
      .catch((e) => e);
    expect(error.code).toBe('auth_failed');
    expect(seen[0]).toBe('local only');
    expect(seen[seen.length - 1]).toBe(null);
    expect(db.getPendingWriteCount()).toBe(0);
  });
});

describe('Offline', () => {
  it('holds writes made while offline and sends them on goOnline()', async () => {
    const db = newDb();
    await db.connect();
    const path = testPath('offline-write');
    const seen: unknown[] = [];
    db.ref(path).on('value', (snap) => seen.push(snap.val()));

    db.goOffline();
    const write = db.ref(path).set('written offline');
    expect(seen[seen.length - 1]).toBe('written offline');
    expect(await settled(write, 1000)).toBe('pending');

    const reader = newDb();
    expect((await reader.ref(path).once('value')).val()).toBe(null);

    db.goOnline();
    await write;
    expect((await reader.ref(path).once('value')).val()).toBe('written offline');
  });

  it('listens from goOnline() when on() is called while offline', async () => {
    const db = newDb();
    await db.connect();
    const path = testPath('offline-listen');
    const writer = newDb();
    await writer.ref(path).set('before');

    db.goOffline();
    const seen: unknown[] = [];
    db.ref(path).on('value', (snap) => seen.push(snap.val()));
    db.goOnline();

    await expect.poll(() => seen[seen.length - 1], { timeout: 5000 }).toBe('before');
    await writer.ref(path).set('after');
    await expect.poll(() => seen[seen.length - 1], { timeout: 5000 }).toBe('after');
  });

  it('rejects a read it has no cached data for', async () => {
    const db = newDb();
    await db.connect();
    db.goOffline();
    const error = await db
      .ref(testPath('offline-read'))
      .once('value')
      .catch((e) => e);
    expect(error.code).toBe('not_connected');
  });
});
