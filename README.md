# @lark-sh/client

JavaScript/TypeScript client for [Lark](https://lark.sh) - a real-time database with a Firebase-like API.

> **Early Alpha**: This library is under active development. APIs may change.

## Features

- **Firebase v8-style API** - Familiar `ref()`, `set()`, `on()`, `once()` patterns
- **Real-time subscriptions** - Live updates with `child_added`, `child_changed`, `child_removed`, `child_moved`
- **Full query support** - `orderByChild()`, `limitToFirst()`, `startAt()`, `endAt()`, and more
- **Transactions** - Atomic updates with optimistic concurrency
- **Local-first writes** - Optimistic updates appear instantly
- **Works everywhere** - Browsers and Node.js
- **TypeScript support** - Full type definitions included
- **~20KB gzipped** - Lightweight bundle

## Installation

```bash
npm install @lark-sh/client
```

## Quick Start

```typescript
import { LarkDatabase } from '@lark-sh/client';

// Create with anonymous auth
const db = new LarkDatabase('my-project/my-database', { anonymous: true });
// Or use a JWT token
// const db = new LarkDatabase('my-project/my-database', { token: 'your-jwt-token' });

await db.connect();

// Write data
await db.ref('users/alice').set({ name: 'Alice', score: 100 });

// Read data once
const snapshot = await db.ref('users/alice').once('value');
console.log(snapshot.val()); // { name: 'Alice', score: 100 }

// Subscribe to real-time updates
const unsubscribe = db.ref('users').on('value', (snapshot) => {
  console.log('Users changed:', snapshot.val());
});

// Child events with previousChildKey
db.ref('messages').orderByKey().on('child_added', (snapshot, prevKey) => {
  console.log('New message:', snapshot.key, 'after:', prevKey);
});

// Clean up
unsubscribe();
await db.disconnect();
```

## API Overview

### Connection Management

```typescript
const db = new LarkDatabase('project/database', { anonymous: true });

// Connect
await db.connect();
// or with token: { token: 'jwt-token' }

// Check connection state
db.connected;     // true if authenticated
db.state;         // 'disconnected' | 'connecting' | 'connected' | 'joined' | 'authenticated'

// Connection events
db.onConnect(() => console.log('Connected'));
db.onDisconnect(() => console.log('Disconnected'));
db.onError((err) => console.error(err));

// Pause/resume connection (preserves cache)
db.goOffline();
db.goOnline();

// Full disconnect (clears all state)
await db.disconnect();
```

### Reading & Writing Data

```typescript
const ref = db.ref('users/alice');

// Write
await ref.set({ name: 'Alice', score: 100 });
await ref.update({ score: 150 });  // Partial update
await ref.remove();

// Read once
const snapshot = await ref.once('value');
snapshot.val();      // The data
snapshot.key;        // 'alice'
snapshot.exists();   // true/false

// Push (auto-generated key)
const newRef = await db.ref('messages').push({ text: 'Hello!' });
console.log(newRef.key);  // '-N1a2b3c4d5e6f'

// Priority
await ref.setWithPriority({ name: 'Alice' }, 10);
await ref.setPriority(20);
```

### Real-time Subscriptions

```typescript
// on() returns an unsubscribe function
const unsubscribe = db.ref('users').on('value', (snapshot) => {
  console.log(snapshot.val());
});

// Child events
db.ref('messages').on('child_added', (snap, prevKey) => { /* ... */ });
db.ref('messages').on('child_changed', (snap, prevKey) => { /* ... */ });
db.ref('messages').on('child_removed', (snap) => { /* ... */ });
db.ref('messages').on('child_moved', (snap, prevKey) => { /* ... */ });

// Unsubscribe
unsubscribe();
```

### Queries

```typescript
// Ordering
db.ref('users').orderByChild('score');
db.ref('users').orderByKey();
db.ref('users').orderByValue();
db.ref('users').orderByPriority();

// Limiting
db.ref('users').orderByChild('score').limitToFirst(10);
db.ref('users').orderByChild('score').limitToLast(5);

// Range queries
db.ref('users').orderByChild('age').startAt(18).endAt(65);
db.ref('users').orderByChild('name').equalTo('Alice');

// Chaining
const topPlayers = await db.ref('players')
  .orderByChild('score')
  .limitToLast(10)
  .once('value');
```

### Transactions

```typescript
// Callback style (optimistic concurrency)
const result = await db.ref('counter').transaction((current) => {
  return (current || 0) + 1;
});
console.log(result.committed, result.snapshot.val());

// Multi-path atomic updates
await db.transaction({
  '/users/alice/score': 100,
  '/users/bob/score': 200,
  '/temp/data': null,  // null = delete
});

// Array style with conditions
await db.transaction([
  { op: 'condition', path: '/counter', value: 5 },  // CAS check
  { op: 'set', path: '/counter', value: 6 },
]);
```

### OnDisconnect

```typescript
// Set data when client disconnects
await db.ref('users/alice/online').onDisconnect().set(false);
await db.ref('users/alice/lastSeen').onDisconnect().set(ServerValue.TIMESTAMP);

// Remove data on disconnect
await db.ref('presence/alice').onDisconnect().remove();

// Cancel pending onDisconnect
await db.ref('users/alice/online').onDisconnect().cancel();
```

### Authentication

```typescript
// Initial connection
await db.connect();

// Switch to authenticated user
await db.signIn('new-jwt-token');

// Sign out (become anonymous)
await db.signOut();

// Listen for auth changes
db.onAuthStateChanged((auth) => {
  if (auth) {
    console.log('Signed in as:', auth.uid);
  } else {
    console.log('Signed out');
  }
});
```

### Lazy Connect

You don't need to wait for `connect()` to finish before using the database. Operations called during connection are automatically queued and execute once authenticated:

```typescript
const db = new LarkDatabase('project/db', { anonymous: true });

// Start connecting (don't await)
const connectPromise = db.connect();

// These queue and run after auth completes
db.ref('users').on('value', callback);
const writePromise = db.ref('data').set({ hello: 'world' });

await connectPromise;
await writePromise;
```

### Volatile Paths

Lark supports volatile paths for high-frequency data like player positions or cursors. Volatile paths are defined in your server rules with `.volatile: true` and use fire-and-forget writes for lower latency:

```typescript
// Check which paths are volatile (set by server rules)
db.volatilePaths; // e.g. ['players/*/position', 'cursors']

// Writes to volatile paths resolve immediately (no server ack)
await db.ref('players/abc/position').set({ x: 10, y: 20 });

// Volatile events include a server timestamp for interpolation
db.ref('players').on('value', (snapshot) => {
  if (snapshot.isVolatile()) {
    const ts = snapshot.getServerTimestamp(); // Unix epoch ms
    // Use deltas between timestamps for smooth interpolation
  }
});
```

When using WebTransport, volatile writes are sent via UDP datagrams for even lower latency. The server batches volatile events at 20Hz over WebTransport vs 7Hz over WebSocket.

## Firebase v8 Compatibility

For users migrating from Firebase who need exact v8 API behavior, use the `fb-v8` sub-package:

```typescript
import { LarkDatabase, DatabaseReference } from '@lark-sh/client/fb-v8';

const db = new LarkDatabase('project/database', { anonymous: true });
await db.connect();

const ref = db.ref('players');

// Firebase v8 style: on() returns the callback (not unsubscribe)
const callback = ref.on('value', (snap) => console.log(snap.val()));

// Remove by callback reference
ref.off('value', callback);

// Context binding
ref.on('value', this.handleValue, this);
ref.off('value', this.handleValue, this);

// once() with callbacks
ref.once('value', successCallback, cancelCallback, context);
```

**Differences from modern API:**
| Feature | Modern API | fb-v8 |
|---------|------------|-------|
| `on()` return | Unsubscribe function | The callback |
| `off()` | Optional | Required for cleanup |
| Context param | Not supported | Supported |

## Transport Options

Lark uses WebSocket by default. You can opt in to WebTransport for lower latency in supported browsers (Chrome 97+, Edge 97+, Firefox 114+).

```typescript
const db = new LarkDatabase('project/db', {
  anonymous: true,
  // transport: 'websocket',   // Default: WebSocket only
  // transport: 'auto',        // Try WebTransport first, fall back to WebSocket
  // transport: 'webtransport' // Force WebTransport (fails if unavailable)
});

await db.connect();

// Check which transport is in use
console.log(db.transportType);  // 'websocket' | 'webtransport'
```

## Server Time

```typescript
import { ServerValue } from '@lark-sh/client';

// Use server timestamp
await db.ref('messages').push({
  text: 'Hello',
  createdAt: ServerValue.TIMESTAMP,
});

// Get server time offset
const offset = db.serverTimeOffset;  // ms difference from local time
```

## Error Handling

```typescript
import { LarkError } from '@lark-sh/client';

try {
  await db.ref('protected').set({ data: 'test' });
} catch (err) {
  if (err instanceof LarkError) {
    console.log(err.code);    // 'permission_denied', 'not_connected', etc.
    console.log(err.message);
  }
}
```

## License

Apache-2.0
