/**
 * LarkDatabase - the main entry point for connecting to a Lark database.
 */

import { createTransport, TransportType } from './connection/createTransport';
import { AuthCompleteResponse, JoinCompleteResponse, MessageQueue } from './connection/MessageQueue';
import { PendingWriteManager, type PendingWrite } from './connection/PendingWriteManager';
import { SubscriptionManager, SnapshotCallback } from './connection/SubscriptionManager';
import { Transport } from './connection/Transport';
import { DatabaseReference } from './DatabaseReference';
import { DataSnapshot } from './DataSnapshot';
import { LarkError } from './LarkError';
import { DEFAULT_LARK_DOMAIN, EventType, ErrorCode } from './protocol/constants';
import {
  AuthMessage,
  ClientMessage,
  JoinMessage,
  ServerMessage,
  UnauthMessage,
  isAckMessage,
  isAuthCompleteMessage,
  isEventMessage,
  isNackMessage,
  QueryParams,
  TxOperation,
  TransactionMessage,
} from './protocol/messages';
import { hashValue, isPrimitive } from './utils/hash';
import { normalizePath } from './utils/path';
import { validatePath, validateWriteData, validateWriteSize, validateVolatileWriteSize } from './utils/validation';
import { isVolatilePath } from './utils/volatile';

export interface ConnectOptions {
  /** User's auth token (from your auth system) */
  token?: string;

  /** Connect anonymously (server assigns a UID) */
  anonymous?: boolean;

  /** Lark domain (default: larkdb.net). May include a port (e.g. "localhost:8080"). */
  domain?: string;

  /**
   * Whether to use secure protocols (wss/https) vs insecure (ws/http).
   * Useful for local development against a non-TLS server.
   *
   * Default behavior:
   * - If explicitly set, use it.
   * - Else if running in a browser, derive from `window.location.protocol === 'https:'`.
   * - Else default to `true`.
   */
  secure?: boolean;

  /**
   * Transport type preference.
   * - 'websocket': WebSocket only (default)
   * - 'auto': Try WebTransport first, fall back to WebSocket
   * - 'webtransport': Force WebTransport only (fails if unavailable)
   */
  transport?: TransportType;

  /**
   * Timeout for WebTransport connection attempt in milliseconds.
   * If WebTransport doesn't connect within this time, falls back to WebSocket.
   * Only applies when transport is 'auto'.
   * Default: 2000 (2 seconds)
   */
  webtransportTimeout?: number;
}

export interface AuthInfo {
  uid: string;
  provider: string;
  token: Record<string, unknown>;
}

// ============================================
// Transaction Types (Public API)
// ============================================

/** A set operation in a transaction */
export interface TransactionSetOp {
  op: 'set';
  path: string;
  value: unknown;
}

/** An update (merge) operation in a transaction */
export interface TransactionUpdateOp {
  op: 'update';
  path: string;
  value: Record<string, unknown>;
}

/** A delete operation in a transaction */
export interface TransactionDeleteOp {
  op: 'delete';
  path: string;
}

/** A condition check in a transaction (for compare-and-swap) */
export interface TransactionConditionOp {
  op: 'condition';
  path: string;
  /** The expected value. Pass a DataSnapshot to automatically use raw data (preserves priority metadata for correct hashing). */
  value: unknown | DataSnapshot;
}

/** A single operation in a transaction (array syntax) */
export type TransactionOp =
  | TransactionSetOp
  | TransactionUpdateOp
  | TransactionDeleteOp
  | TransactionConditionOp;

/** Object syntax for transactions: path -> value (null = delete) */
export type TransactionObject = Record<string, unknown>;

/**
 * Connection state machine:
 * - 'disconnected': Not connected
 * - 'connecting': Initial connection in progress
 * - 'connected': WebSocket open
 * - 'joined': Join complete (database identified)
 * - 'authenticated': Auth complete (ready to operate)
 * - 'reconnecting': Attempting to reconnect after disconnect
 */
type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'joined' | 'authenticated' | 'reconnecting';

/** Callback for .info path subscriptions */
type InfoCallback = (snapshot: DataSnapshot) => void;

/** Subscription info for .info paths */
interface InfoSubscription {
  path: string;
  callback: InfoCallback;
}

// Reconnection constants
const RECONNECT_BASE_DELAY_MS = 1000; // Start with 1 second
const RECONNECT_MAX_DELAY_MS = 30000; // Cap at 30 seconds
const RECONNECT_JITTER_FACTOR = 0.5; // Add up to 50% random jitter

/**
 * Resolve the `secure` option to a concrete boolean.
 * Explicit value wins; in a browser, derive from page protocol; otherwise default to true.
 */
function resolveSecure(explicit: boolean | undefined): boolean {
  if (typeof explicit === 'boolean') {
    return explicit;
  }
  if (typeof window !== 'undefined' && window.location && typeof window.location.protocol === 'string') {
    return window.location.protocol === 'https:';
  }
  return true;
}

/**
 * Check if a value is a ServerValue placeholder.
 */
function isServerValue(value: unknown): value is { '.sv': unknown } {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    '.sv' in value
  );
}

/**
 * Resolve ServerValue placeholders locally for optimistic updates.
 * - TIMESTAMP: replaced with Date.now()
 * - increment(delta): replaced with currentValue + delta (or delta if no current value)
 *
 * @param value - The value to resolve
 * @param currentValue - The current value at the path (for increment resolution)
 * @returns The value with ServerValues resolved locally
 */
function resolveServerValuesLocally(value: unknown, currentValue?: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  // Check for ServerValue placeholder
  if (isServerValue(value)) {
    const sv = value['.sv'];

    // TIMESTAMP
    if (sv === 'timestamp') {
      return Date.now();
    }

    // increment
    if (typeof sv === 'object' && sv !== null && 'increment' in sv) {
      const delta = (sv as { increment: number }).increment;
      if (typeof currentValue === 'number') {
        return currentValue + delta;
      }
      // If current value is not a number, increment treats it as 0
      return delta;
    }

    // Unknown server value, return as-is (will be resolved by server)
    return value;
  }

  // Recursively process objects
  if (typeof value === 'object' && !Array.isArray(value)) {
    const result: Record<string, unknown> = {};
    const currentObj = currentValue !== null && typeof currentValue === 'object' && !Array.isArray(currentValue)
      ? currentValue as Record<string, unknown>
      : {};

    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = resolveServerValuesLocally(val, currentObj[key]);
    }
    return result;
  }

  // Recursively process arrays
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      const currentArr = Array.isArray(currentValue) ? currentValue : [];
      return resolveServerValuesLocally(item, currentArr[index]);
    });
  }

  // Primitive values pass through unchanged
  return value;
}

/**
 * Server values that are resolved by the server when a write is committed.
 * Use these with set(), update(), or push() to have the server fill in values.
 */
export const ServerValue = {
  /**
   * A placeholder value for auto-populating the current server timestamp.
   * The server will replace this with the actual Unix timestamp in milliseconds.
   *
   * @example
   * ```javascript
   * import { ServerValue } from '@lark-sh/client';
   * await ref.set({ createdAt: ServerValue.TIMESTAMP });
   * // Server stores: { createdAt: 1704067200000 }
   * ```
   */
  TIMESTAMP: { '.sv': 'timestamp' } as const,

  /**
   * Returns a placeholder value for atomically incrementing a numeric field.
   * If the field doesn't exist or isn't a number, it's treated as 0.
   *
   * @param delta - The amount to increment by (can be negative to decrement)
   * @returns A server value placeholder
   *
   * @example
   * ```javascript
   * import { ServerValue } from '@lark-sh/client';
   * await ref.child('score').set(ServerValue.increment(10));
   * // Atomically adds 10 to the current score
   * ```
   */
  increment: (delta: number) => ({ '.sv': { increment: delta } }),
};

export class LarkDatabase {
  /**
   * Server values that are resolved by the server when a write is committed.
   * Alias for the exported ServerValue object.
   */
  static ServerValue = ServerValue;

  private _state: ConnectionState = 'disconnected';
  private _auth: AuthInfo | null = null;
  private _databaseId: string;
  private _domain: string;
  private _secure: boolean;
  private _volatilePaths: string[] = [];
  private _transportType: 'websocket' | 'webtransport' | null = null;

  // Auth state
  private _currentToken: string; // Token for auth (empty string = anonymous)
  private _isAnonymous: boolean; // True if connected anonymously

  // Reconnection state
  private _connectionId: string | null = null;
  private _connectOptions: ConnectOptions;
  private _intentionalDisconnect = false;
  private _reconnectAttempt = 0;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private transport: Transport | null = null;
  private messageQueue: MessageQueue;
  private subscriptionManager: SubscriptionManager;
  private pendingWrites: PendingWriteManager;

  // Event callbacks
  private connectCallbacks = new Set<() => void>();
  private disconnectCallbacks = new Set<() => void>();
  private errorCallbacks = new Set<(error: Error) => void>();
  private reconnectingCallbacks = new Set<() => void>();
  private authStateChangedCallbacks = new Set<(auth: AuthInfo | null) => void>();

  // .info path subscriptions (handled locally, not sent to server)
  private infoSubscriptions: InfoSubscription[] = [];

  // Connection promise - shared by connect() and lazy operations
  private _connectionPromise: Promise<void> | null = null;
  // Counts connection attempts, so a close event from an earlier transport (one
  // closed by goOffline() just before goOnline(), say) can be told apart.
  private _transportGeneration = 0;
  // Set by goOffline() and cleared by goOnline(). Writes made while offline are
  // held and sent when the connection comes back.
  private _offline = false;
  private _serverTimeOffset: number = 0;
  private _pingInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Create a new LarkDatabase instance.
   *
   * @param databaseId - Database ID in format "project/database"
   * @param options - Connection options (token, anonymous, domain, transport).
   *                  Defaults to anonymous auth if not specified.
   *
   * @example
   * ```typescript
   * // Lazy connection - connects on first operation
   * const db = new LarkDatabase('project/database', { anonymous: true });
   * db.ref('/users').on('value', cb); // Auto-connects here
   *
   * // Explicit connection - for UI feedback or error handling
   * const db = new LarkDatabase('project/database', { anonymous: true });
   * await db.connect(); // Explicitly await connection
   * db.ref('/users').on('value', cb);
   * ```
   */
  constructor(databaseId: string, options: ConnectOptions = {}) {
    this.messageQueue = new MessageQueue();
    this.subscriptionManager = new SubscriptionManager();
    this.pendingWrites = new PendingWriteManager();

    // Validate database ID
    const projectId = databaseId.split('/')[0];
    if (!projectId) {
      throw new Error('Invalid database ID: must be in format "projectId/databaseName"');
    }

    // Store config
    this._databaseId = databaseId;
    this._connectOptions = options;
    this._domain = options.domain || DEFAULT_LARK_DOMAIN;
    this._secure = resolveSecure(options.secure);
    this._currentToken = options.token || '';
    this._isAnonymous = !options.token && options.anonymous !== false;

    // Initialize subscription manager callbacks
    // This enables lazy connection - on()/once() will trigger connection via sendSubscribeMessage
    this.subscriptionManager.initialize({
      sendSubscribe: this.sendSubscribeMessage.bind(this),
      sendUnsubscribe: this.sendUnsubscribeMessage.bind(this),
      createSnapshot: this.createSnapshot.bind(this),
    });
  }

  // ============================================
  // Connection State
  // ============================================

  /**
   * Whether the database is fully connected and authenticated.
   * Returns true when ready to perform database operations.
   */
  get connected(): boolean {
    return this._state === 'authenticated';
  }

  /**
   * Whether the database is currently attempting to reconnect.
   */
  get reconnecting(): boolean {
    return this._state === 'reconnecting';
  }

  /**
   * Current connection state.
   */
  get state(): ConnectionState {
    return this._state;
  }

  /**
   * Current auth info, or null if not connected.
   */
  get auth(): AuthInfo | null {
    return this._auth;
  }

  /**
   * @internal Get the base URL for reference toString().
   */
  _getBaseUrl(): string {
    if (this._domain && this._databaseId) {
      const [projectId, databaseName] = this._databaseId.split('/');
      const scheme = this._secure ? 'https' : 'http';
      // REST host encodes both database and project as a single subdomain:
      // {databaseName}--{projectId}.{domain}. Fall back to the bare project
      // subdomain if no database name is present.
      const host = databaseName
        ? `${databaseName}--${projectId}.${this._domain}`
        : `${projectId}.${this._domain}`;
      return `${scheme}://${host}`;
    }
    return 'lark://';
  }

  /**
   * Get the volatile path patterns from the server.
   * These patterns indicate which paths should use unreliable transport.
   */
  get volatilePaths(): string[] {
    return this._volatilePaths;
  }

  /**
   * Get the current transport type.
   * Returns 'websocket' or 'webtransport', or null if not connected.
   */
  get transportType(): 'websocket' | 'webtransport' | null {
    return this._transportType;
  }

  /**
   * Get the estimated server time offset in milliseconds.
   * Add this to Date.now() to get approximate server time.
   */
  get serverTimeOffset(): number {
    return this._serverTimeOffset;
  }

  /**
   * Check if there are any pending writes waiting for acknowledgment.
   * Useful for showing "saving..." indicators in UI.
   */
  hasPendingWrites(): boolean {
    return this.pendingWrites.pendingCount > 0;
  }

  /**
   * Get the number of pending writes waiting for acknowledgment.
   */
  getPendingWriteCount(): number {
    return this.pendingWrites.pendingCount;
  }

  /**
   * Clear all pending writes.
   * Call this if you don't want to retry writes on reconnect.
   */
  clearPendingWrites(): void {
    this.pendingWrites.clear();
  }

  // ============================================
  // Connection Management
  // ============================================

  /**
   * Explicitly connect to the database.
   *
   * This is optional - operations will auto-connect if needed.
   * Use this when you want to:
   * - Await connection completion for UI feedback
   * - Handle connection errors separately from operation errors
   * - Pre-warm the connection before first operation
   *
   * @returns Promise that resolves when fully authenticated
   */
  async connect(): Promise<void> {
    return this.ensureConnected();
  }

  /**
   * Ensure connection is established, triggering it if needed.
   * Multiple concurrent calls share the same connection promise.
   */
  private async ensureConnected(): Promise<void> {
    // Already authenticated - nothing to do
    if (this._state === 'authenticated') {
      return;
    }

    // Connection in progress - wait for it
    if (this._connectionPromise) {
      return this._connectionPromise;
    }

    if (this._offline) {
      throw new LarkError(ErrorCode.NOT_CONNECTED, 'Database is offline; call goOnline() to reconnect');
    }

    // Need to connect
    this._intentionalDisconnect = false;
    this._connectionPromise = this.performConnect(this._databaseId, this._connectOptions);

    try {
      await this._connectionPromise;
    } catch (error) {
      // Clear promise so next attempt can retry
      this._connectionPromise = null;
      throw error;
    }
  }

  /**
   * Internal connect implementation used by both initial connect and reconnect.
   * Implements the Join → Auth flow:
   * 1. Connect WebSocket
   * 2. Send join (identifies database)
   * 3. Send auth (authenticates user - required even for anonymous)
   */
  private async performConnect(
    databaseId: string,
    options: ConnectOptions,
    isReconnect = false
  ): Promise<void> {
    this._state = isReconnect ? 'reconnecting' : 'connecting';
    const generation = ++this._transportGeneration;

    try {
      // Construct server URL from database ID
      // Format: "projectId/databaseName" -> "wss://projectId.larkdb.net/ws"
      // When `secure: false`, use "ws://" instead (for local dev).
      const projectId = databaseId.split('/')[0];
      const wsScheme = this._secure ? 'wss' : 'ws';
      const wsUrl = `${wsScheme}://${projectId}.${this._domain}/ws`;

      // Step 2: Connect to the server via WebTransport or WebSocket
      const transportResult = await createTransport(
        wsUrl,
        {
          onMessage: this.handleMessage.bind(this),
          onOpen: () => {}, // Handled in connect flow
          onClose: (code: number, reason: string) => {
            if (generation === this._transportGeneration) this.handleClose(code, reason);
          },
          onError: this.handleError.bind(this),
        },
        {
          transport: options.transport,
          webtransportTimeout: options.webtransportTimeout,
        }
      );

      this.transport = transportResult.transport;
      this._transportType = transportResult.type;
      this._state = 'connected';

      // Step 3: Send join message (identifies the database, no token)
      const joinRequestId = this.messageQueue.nextRequestId();
      const joinMessage: JoinMessage = {
        o: 'j',
        d: databaseId,
        r: joinRequestId,
      };

      // Include previous connection ID for reconnect deduplication
      if (this._connectionId) {
        joinMessage.pcid = this._connectionId;
      }

      this.send(joinMessage);

      // Wait for join complete (returns volatile paths and connection ID)
      const joinResponse = (await this.messageQueue.registerRequest(joinRequestId)) as JoinCompleteResponse;
      this._volatilePaths = joinResponse.volatilePaths;
      this._connectionId = joinResponse.connectionId;

      // Calculate server time offset (for .info/serverTimeOffset)
      if (joinResponse.serverTime != null) {
        this._serverTimeOffset = joinResponse.serverTime - Date.now();
      }

      this._state = 'joined';

      // Step 4: Send auth message (REQUIRED - even for anonymous)
      const authRequestId = this.messageQueue.nextRequestId();
      const authMessage: AuthMessage = {
        o: 'au',
        t: this._currentToken ?? '',
        r: authRequestId,
      };

      this.send(authMessage);

      // Wait for auth complete (returns UID)
      const authResponse = (await this.messageQueue.registerRequest(authRequestId)) as AuthCompleteResponse;

      // Update auth info from auth response
      this._auth = {
        uid: authResponse.uid || '',
        provider: this._isAnonymous ? 'anonymous' : 'custom',
        token: {}, // Token claims would need to be decoded from the token if needed
      };

      // Send writes made before the connection was ready, in order, before any
      // write made from here on.
      this.sendPendingWrites();

      this._state = 'authenticated';
      this._reconnectAttempt = 0; // Reset reconnect attempt counter on success

      // Start client-side ping keepalive (every 10 seconds)
      this.startPingInterval();

      // Fire connection state change for .info/connected subscribers
      this.fireConnectionStateChange();

      // On reconnect, restore subscriptions and retry pending writes
      if (isReconnect) {
        await this.restoreAfterReconnect();
      }

      // Notify listeners
      this.connectCallbacks.forEach((cb) => cb());

      // Fire auth state change
      this.authStateChangedCallbacks.forEach((cb) => cb(this._auth));
    } catch (error) {
      // On reconnect failure, schedule another attempt
      if (isReconnect) {
        this._state = 'reconnecting';
        this.scheduleReconnect();
        return;
      }

      // On initial connect failure, clean up transport but keep config for retry
      this._state = 'disconnected';
      this._auth = null;
      this._connectionId = null;
      this._transportType = null;
      this.transport?.close();
      this.transport = null;

      // Writes waiting for this connection fail with it, and their local
      // changes are rolled back.
      this.rejectPendingWrites(error as Error);
      this.handleError(error as Error);
      throw error;
    }
  }

  /**
   * Disconnect from the database.
   * This triggers onDisconnect hooks on the server.
   */
  async disconnect(): Promise<void> {
    if (this._state === 'disconnected') {
      return;
    }

    // Check if we were fully authenticated or at least partially connected
    const wasAuthenticated = this._state === 'authenticated';
    const wasPartiallyConnected = this._state === 'connected' || this._state === 'joined';

    // Mark as intentional to prevent auto-reconnect
    this._intentionalDisconnect = true;

    // Cancel any pending reconnect
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    // Send leave message for graceful disconnect
    if ((wasAuthenticated || wasPartiallyConnected) && this.transport) {
      try {
        const requestId = this.messageQueue.nextRequestId();
        this.send({ o: 'l', r: requestId });
        // Wait briefly for ack, but don't block
        await Promise.race([
          this.messageQueue.registerRequest(requestId),
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ]);
      } catch {
        // Ignore errors during disconnect
      }
    }

    this.cleanupFull();

    // Fire disconnect callbacks
    if (wasAuthenticated || wasPartiallyConnected) {
      this.disconnectCallbacks.forEach((cb) => cb());
    }
  }

  /**
   * Temporarily disable the connection.
   * Disconnects from the server but preserves subscriptions for later reconnection via goOnline().
   */
  goOffline(): void {
    this._offline = true;
    if (this._state === 'authenticated' || this._state === 'joined' ||
        this._state === 'connected' || this._state === 'reconnecting') {
      this._intentionalDisconnect = true;
      // Clear any pending reconnect timer
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
      this.transport?.close();
      this.transport = null;
      this._state = 'disconnected';
      this._connectionPromise = null;
      // Keep cache intact so get()/once() can read from it while offline
      // Fire connection state change for .info/connected subscribers
      this.fireConnectionStateChange();
    }
  }

  /**
   * Re-enable the connection after goOffline().
   * Reconnects to the database and restores subscriptions.
   */
  goOnline(): void {
    this._intentionalDisconnect = false;
    this._offline = false;

    // If we're disconnected and have connection info, reconnect
    if (this._state === 'disconnected' && this._databaseId && this._connectOptions) {
      this._state = 'reconnecting';
      this.reconnectingCallbacks.forEach((cb) => cb());
      // Attempt to reconnect immediately (no backoff for intentional goOnline)
      this._reconnectAttempt = 0;
      this.attemptReconnect();
    }
  }

  /**
   * Full cleanup - clears connection state including subscriptions.
   * Used for intentional disconnect.
   * Preserves config (databaseId, domain, token) so connect() can be called again.
   */
  private cleanupFull(): void {
    const wasAuthenticated = this._state === 'authenticated';

    this.stopPingInterval();
    this.transport?.close();
    this.transport = null;
    this._state = 'disconnected';
    this._auth = null;
    this._volatilePaths = [];
    this._connectionId = null;
    this._transportType = null;
    this._reconnectAttempt = 0;
    this._connectionPromise = null;
    this.subscriptionManager.clear();
    this.messageQueue.rejectAll(new Error('Connection closed'));
    this.pendingWrites.clear();

    // Fire connection state change for .info/connected subscribers
    if (wasAuthenticated) {
      this.fireConnectionStateChange();
    }

    // Clear info subscriptions
    this.infoSubscriptions = [];
  }

  /**
   * Partial cleanup - preserves state needed for reconnect.
   * Used for unexpected disconnect.
   */
  private cleanupForReconnect(): void {
    this.stopPingInterval();
    this.transport?.close();
    this.transport = null;
    this._auth = null;
    // Keep: _databaseId, _domain, _connectionId, _connectOptions, _transportType
    // Keep: _currentToken, _isAnonymous (for re-auth on reconnect)
    // Keep: subscriptionManager subscriptions (but clear cache)
    // Keep: pendingWrites
    // Keep: infoSubscriptions (will fire again when reconnected)
    this.subscriptionManager.clearCacheOnly();
    // Pending writes are resent once reconnected, so their promises stay open.
    this.messageQueue.rejectAll(new Error('Connection closed'), (requestId) =>
      this.pendingWrites.isPending(requestId)
    );

    // Fire connection state change for .info/connected subscribers (now disconnected)
    this.fireConnectionStateChange();
  }

  // Use real timers for ping so fake timers in tests don't cause infinite loops
  private static _realSetInterval = globalThis.setInterval.bind(globalThis);
  private static _realClearInterval = globalThis.clearInterval.bind(globalThis);

  private startPingInterval(): void {
    this.stopPingInterval();
    this._pingInterval = LarkDatabase._realSetInterval(() => {
      this.transport?.send(JSON.stringify({ o: 'pi' }));
    }, 10_000);
    // Prevent the interval from keeping Node.js processes alive
    if (typeof this._pingInterval === 'object' && 'unref' in this._pingInterval) {
      this._pingInterval.unref();
    }
  }

  private stopPingInterval(): void {
    if (this._pingInterval) {
      LarkDatabase._realClearInterval(this._pingInterval);
      this._pingInterval = null;
    }
  }

  // ============================================
  // .info Path Handling
  // ============================================

  /**
   * Check if a path is a .info path (handled locally).
   */
  private isInfoPath(path: string): boolean {
    const normalizedPath = normalizePath(path) || '/';
    return normalizedPath === '/.info' || normalizedPath.startsWith('/.info/');
  }

  /**
   * Get the current value for a .info path.
   */
  private getInfoValue(path: string): unknown {
    const normalizedPath = normalizePath(path) || '/';

    if (normalizedPath === '/.info/connected') {
      return this._state === 'authenticated';
    }

    if (normalizedPath === '/.info/serverTimeOffset') {
      return this._serverTimeOffset;
    }

    // Unknown .info path - return null
    return null;
  }

  /**
   * Subscribe to a .info path.
   * Returns an unsubscribe function.
   */
  private subscribeToInfo(path: string, callback: InfoCallback): () => void {
    const normalizedPath = normalizePath(path) || '/';
    const subscription: InfoSubscription = { path: normalizedPath, callback };
    this.infoSubscriptions.push(subscription);

    // Fire initial value immediately
    const value = this.getInfoValue(normalizedPath);
    const snapshot = new DataSnapshot(value, normalizedPath, this);
    // Use setTimeout to ensure callback is called asynchronously (like real subscriptions)
    setTimeout(() => callback(snapshot), 0);

    // Return unsubscribe function
    return () => {
      const index = this.infoSubscriptions.indexOf(subscription);
      if (index !== -1) {
        this.infoSubscriptions.splice(index, 1);
      }
    };
  }

  /**
   * Fire events for .info path changes.
   */
  private fireInfoEvents(path: string): void {
    const normalizedPath = normalizePath(path) || '/';
    const value = this.getInfoValue(normalizedPath);

    for (const sub of this.infoSubscriptions) {
      if (sub.path === normalizedPath) {
        const snapshot = new DataSnapshot(value, normalizedPath, this);
        sub.callback(snapshot);
      }
    }
  }

  /**
   * Fire connection state change events to .info/connected subscribers.
   */
  private fireConnectionStateChange(): void {
    this.fireInfoEvents('/.info/connected');
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   */
  private scheduleReconnect(): void {
    this._reconnectAttempt++;

    // Calculate delay with exponential backoff and jitter
    const baseDelay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, this._reconnectAttempt - 1),
      RECONNECT_MAX_DELAY_MS
    );
    const jitter = baseDelay * RECONNECT_JITTER_FACTOR * Math.random();
    const delay = baseDelay + jitter;

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.attemptReconnect();
    }, delay);
  }

  /**
   * Attempt to reconnect to the database.
   */
  private async attemptReconnect(): Promise<void> {
    if (this._intentionalDisconnect) {
      return;
    }

    // Set up connection promise for reconnect - operations can await this
    this._connectionPromise = this.performConnect(this._databaseId, this._connectOptions, true);

    try {
      await this._connectionPromise;
    } catch {
      // performConnect already handles scheduling next attempt on failure
      this._connectionPromise = null;
    }
  }

  /**
   * Restore subscriptions and retry pending writes after reconnect.
   */
  private async restoreAfterReconnect(): Promise<void> {
    // Re-subscribe to all active subscriptions. Pending writes were already
    // resent by sendPendingWrites().
    await this.subscriptionManager.resubscribeAll();
  }

  /**
   * Send every pending write, oldest first: writes made before the connection
   * was ready or while offline, and writes the server may not have received
   * before a reconnect. The server ignores a request ID it has already applied.
   */
  private sendPendingWrites(): void {
    for (const write of this.pendingWrites.getPendingWrites()) {
      try {
        // Volatile paths are only known once joined. A set to one sent before
        // then would wait for an ack the server never sends, so send it as volatile.
        if (write.operation === 'set' && this.isVolatilePath(write.path)) {
          this.subscriptionManager.applyOptimisticWrite(write.path, write.value, '', 'set');
          this.transport?.sendVolatile(JSON.stringify({ o: 's', p: write.path, v: write.value }));
          this.pendingWrites.onAck(write.oid);
          this.subscriptionManager.clearPendingWrite(write.oid);
          this.messageQueue.handleMessage({ a: write.oid });
          continue;
        }
        this.send((write.message ?? this.buildWriteMessage(write)) as ClientMessage);
      } catch (error) {
        // If we fail to send, the connection might have dropped again
        // The next reconnect will retry
        console.error('Failed to send pending write:', error);
      }
    }
  }

  /** Rebuilds the message for a pending write tracked without one. */
  private buildWriteMessage(write: PendingWrite): ClientMessage | TransactionMessage {
    switch (write.operation) {
      case 'set':
        return { o: 's', p: write.path, v: write.value, r: write.oid };
      case 'update':
        return { o: 'u', p: write.path, v: write.value as Record<string, unknown>, r: write.oid };
      case 'delete':
        return { o: 'd', p: write.path, r: write.oid };
      case 'transaction':
        return { o: 'tx', ops: write.value as TxOperation[], r: write.oid };
    }
  }

  /** Fails every pending write with `error` and rolls back its local change. */
  private rejectPendingWrites(error: Error): void {
    for (const write of this.pendingWrites.getPendingWrites()) {
      this.messageQueue.rejectLocally(write.oid, error);
      this.subscriptionManager.handleWriteNack(write.oid);
    }
    this.pendingWrites.clear();
  }

  /**
   * Send a tracked write and wait for its ack. A write made before the
   * connection is ready, or while offline, is held: the connect flow sends it
   * with any other pending writes, in order, so it waits without a timeout.
   */
  private async deliverWrite(requestId: string, message: ClientMessage | TransactionMessage): Promise<void> {
    if (this._state === 'authenticated' && this.transport?.connected) {
      this.send(message);
      await this.messageQueue.registerRequest(requestId);
      return;
    }
    const ack = this.messageQueue.registerRequest(requestId, Infinity);
    if (!this._offline) {
      // A failed connect rejects held writes through rejectPendingWrites().
      this.ensureConnected().catch(() => {});
    }
    await ack;
  }

  // ============================================
  // Reference Access
  // ============================================

  /**
   * Get a reference to a path in the database.
   */
  ref(path: string = ''): DatabaseReference {
    return new DatabaseReference(this, path);
  }

  // ============================================
  // Transactions
  // ============================================

  /**
   * Execute an atomic transaction with multiple operations.
   *
   * Supports two syntaxes:
   *
   * **Object syntax** (multi-path update):
   * ```javascript
   * await db.transaction({
   *   '/users/alice/name': 'Alice',
   *   '/users/alice/score': 100,
   *   '/temp/data': null  // null = delete
   * });
   * ```
   *
   * **Array syntax** (explicit operations):
   * ```javascript
   * await db.transaction([
   *   { op: 'set', path: '/users/alice/name', value: 'Alice' },
   *   { op: 'update', path: '/metadata', value: { lastUpdated: '...' } },
   *   { op: 'delete', path: '/temp/data' },
   *   { op: 'condition', path: '/counter', value: 5 }  // CAS check
   * ]);
   * ```
   *
   * All operations are atomic: either all succeed or all fail.
   * Conditions are checked first; if any fail, the transaction is rejected
   * with error code 'condition_failed'.
   */
  async transaction(operations: TransactionOp[] | TransactionObject): Promise<void> {
    let txOps: TxOperation[];

    if (Array.isArray(operations)) {
      // Array syntax - convert to wire format (async for hash computation)
      txOps = await Promise.all(operations.map((op) => this.convertToTxOp(op)));
    } else {
      // Object syntax - convert paths to set/delete operations
      txOps = this.convertObjectToTxOps(operations);
    }

    await this._sendTransaction(txOps);
  }

  /**
   * Convert a public TransactionOp to wire format TxOperation.
   * Async because condition operations may require hash computation.
   */
  private async convertToTxOp(op: TransactionOp): Promise<TxOperation> {
    const path = normalizePath(op.path) || '/';
    validatePath(op.path, 'transaction');

    switch (op.op) {
      case 'set':
        validateWriteData(op.value, 'transaction');
        return { o: 's', p: path, v: op.value };
      case 'update':
        validateWriteData(op.value, 'transaction');
        return { o: 'u', p: path, v: op.value };
      case 'delete':
        return { o: 'd', p: path };
      case 'condition': {
        // If a DataSnapshot is passed, use raw data (preserves priority metadata)
        const conditionValue = op.value instanceof DataSnapshot ? op.value.exportVal() : op.value;
        // Condition values are for comparison, not writing, but still validate
        if (conditionValue !== undefined && conditionValue !== null) {
          validateWriteData(conditionValue, 'transaction condition');
        }
        // Use direct value for primitives, hash for complex objects
        if (isPrimitive(conditionValue)) {
          return { o: 'c', p: path, v: conditionValue };
        } else {
          const hash = await hashValue(conditionValue);
          return { o: 'c', p: path, h: hash };
        }
      }
      default:
        throw new Error(`Unknown transaction operation: ${(op as TransactionOp).op}`);
    }
  }

  /**
   * Convert object syntax to wire format TxOperations.
   * Each path becomes a set operation, null values become deletes.
   */
  private convertObjectToTxOps(obj: TransactionObject): TxOperation[] {
    const ops: TxOperation[] = [];

    for (const [path, value] of Object.entries(obj)) {
      validatePath(path, 'transaction');
      const normalizedPath = normalizePath(path) || '/';

      if (value === null) {
        // null = delete
        ops.push({ o: 'd', p: normalizedPath });
      } else {
        // set the value
        validateWriteData(value, 'transaction');
        ops.push({ o: 's', p: normalizedPath, v: value });
      }
    }

    return ops;
  }

  /**
   * @internal Send a transaction to the server.
   */
  async _sendTransaction(ops: TxOperation[]): Promise<void> {
    const requestId = this.messageQueue.nextRequestId();
    const message: TransactionMessage = {
      o: 'tx',
      ops,
      r: requestId,
    };

    // Track the pending write using request ID (store ops as value for potential retry)
    this.pendingWrites.trackWrite(requestId, 'transaction', '/', ops, message);
    await this.deliverWrite(requestId, message);
  }

  // ============================================
  // Connection Events
  // ============================================

  /**
   * Register a callback for when connection is established.
   * Returns an unsubscribe function.
   */
  onConnect(callback: () => void): () => void {
    this.connectCallbacks.add(callback);
    return () => this.connectCallbacks.delete(callback);
  }

  /**
   * Register a callback for when connection is lost.
   * Returns an unsubscribe function.
   */
  onDisconnect(callback: () => void): () => void {
    this.disconnectCallbacks.add(callback);
    return () => this.disconnectCallbacks.delete(callback);
  }

  /**
   * Register a callback for connection errors.
   * Returns an unsubscribe function.
   */
  onError(callback: (error: Error) => void): () => void {
    this.errorCallbacks.add(callback);
    return () => this.errorCallbacks.delete(callback);
  }

  /**
   * Register a callback for when reconnection attempts begin.
   * This fires when an unexpected disconnect occurs and auto-reconnect starts.
   * Returns an unsubscribe function.
   */
  onReconnecting(callback: () => void): () => void {
    this.reconnectingCallbacks.add(callback);
    return () => this.reconnectingCallbacks.delete(callback);
  }

  /**
   * Register a callback for auth state changes.
   * Fires when user signs in, signs out, or auth changes.
   * Returns an unsubscribe function.
   */
  onAuthStateChanged(callback: (auth: AuthInfo | null) => void): () => void {
    this.authStateChangedCallbacks.add(callback);
    return () => this.authStateChangedCallbacks.delete(callback);
  }

  // ============================================
  // Authentication Management
  // ============================================

  /**
   * Sign in with a new auth token while connected.
   * Changes the authenticated user without disconnecting.
   *
   * Note: Some subscriptions may be revoked if the new user doesn't have
   * permission. Listen for 'permission_denied' errors on your subscriptions.
   *
   * @param token - The auth token for the new user
   * @throws Error if not connected (must call connect() first)
   */
  async signIn(token: string): Promise<void> {
    if (this._state !== 'authenticated' && this._state !== 'joined') {
      throw new LarkError('not_connected', 'Must be connected first - call connect()');
    }

    // Send auth with new token
    const authRequestId = this.messageQueue.nextRequestId();
    const authMessage: AuthMessage = {
      o: 'au',
      t: token,
      r: authRequestId,
    };

    this.send(authMessage);

    // Wait for auth complete
    const authResponse = (await this.messageQueue.registerRequest(authRequestId)) as AuthCompleteResponse;

    // Update auth state
    this._currentToken = token;
    this._isAnonymous = false;
    this._auth = {
      uid: authResponse.uid || '',
      provider: 'custom',
      token: {},
    };

    // Fire auth state change
    this.authStateChangedCallbacks.forEach((cb) => cb(this._auth));
  }

  /**
   * Sign out the current user.
   * Reverts to anonymous authentication.
   *
   * Note: Some subscriptions may be revoked if anonymous users don't have
   * permission. Listen for 'permission_denied' errors on your subscriptions.
   */
  async signOut(): Promise<void> {
    if (this._state !== 'authenticated') {
      return; // Already signed out or not connected
    }

    // Send unauth message
    const unauthRequestId = this.messageQueue.nextRequestId();
    const unauthMessage: UnauthMessage = {
      o: 'ua',
      r: unauthRequestId,
    };

    this.send(unauthMessage);

    // Wait for auth complete (server responds with ac even for unauth)
    const authResponse = (await this.messageQueue.registerRequest(unauthRequestId)) as AuthCompleteResponse;

    // Update auth state (now anonymous)
    this._currentToken = '';
    this._isAnonymous = true;
    this._auth = {
      uid: authResponse.uid || '',
      provider: 'anonymous',
      token: {},
    };

    // Fire auth state change
    this.authStateChangedCallbacks.forEach((cb) => cb(this._auth));
  }

  // ============================================
  // Internal: Message Handling
  // ============================================

  private handleMessage(data: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(data) as ServerMessage;
    } catch {
      console.error('Failed to parse message:', data);
      return;
    }

    // DEBUG: Log all incoming messages
    if (typeof process !== 'undefined' && process.env?.LARK_DEBUG) {
      console.log('[LARK] <<< SERVER:', JSON.stringify(message, null, 2));
    }

    // Clear pending writes on ack/nack using request ID
    if (isAckMessage(message)) {
      this.pendingWrites.onAck(message.a);
      // Also clear from View-level pending write tracking
      this.subscriptionManager.clearPendingWrite(message.a);
    } else if (isNackMessage(message)) {
      this.pendingWrites.onNack(message.n);

      // Handle subscription revocation due to auth change
      if (message.e === 'permission_denied' && message.sp) {
        const path = message.sp;
        console.warn(`Subscription revoked at ${path}: permission_denied`);
        // Clean up local subscription state
        this.subscriptionManager.handleSubscriptionRevoked(path);
        return;
      }

      // Log the error (except for condition_failed which is expected in transactions)
      if (message.e !== 'condition_failed') {
        console.error(`Write failed (${message.e}): ${message.m || message.e}`);
      }

      // Remove the pending write from affected Views
      // With dual-cache, this automatically reverts to server truth and fires callbacks if needed
      this.subscriptionManager.handleWriteNack(message.n);
    }

    // Check if this is a response to a pending request
    if (this.messageQueue.handleMessage(message)) {
      return;
    }

    // Otherwise, check if it's an event
    if (isEventMessage(message)) {
      this.subscriptionManager.handleEvent(message);
    }
  }

  private handleClose(code: number, reason: string): void {
    // Already disconnected (e.g., through disconnect() method) - nothing to do
    if (this._state === 'disconnected') {
      return;
    }

    // Check if we were fully authenticated (ready to operate)
    const wasAuthenticated = this._state === 'authenticated';
    const wasReconnecting = this._state === 'reconnecting';
    // Also consider partial connection states (connected, joined) as needing callbacks
    const wasPartiallyConnected = this._state === 'connected' || this._state === 'joined';

    // Check if this was an intentional disconnect
    // (disconnect() already handled cleanup and callbacks, but the ws close event
    // may fire later - just clean up any remaining state)
    if (this._intentionalDisconnect) {
      this.cleanupFull();
      if (wasAuthenticated || wasPartiallyConnected) {
        this.disconnectCallbacks.forEach((cb) => cb());
      }
      return;
    }

    // Only attempt to reconnect if we have the necessary state
    // (databaseId and connectOptions from a previous successful connection)
    const canReconnect = this._databaseId && this._connectOptions;

    // Unexpected disconnect - attempt to reconnect if we can
    if ((wasAuthenticated || wasPartiallyConnected || wasReconnecting) && canReconnect) {
      this._state = 'reconnecting';
      this.cleanupForReconnect();

      // Notify listeners that we're reconnecting
      this.reconnectingCallbacks.forEach((cb) => cb());
      if (wasAuthenticated || wasPartiallyConnected) {
        this.disconnectCallbacks.forEach((cb) => cb());
      }

      // Schedule reconnection
      this.scheduleReconnect();
    } else {
      // Can't reconnect - do full cleanup
      this.cleanupFull();
      if (wasAuthenticated || wasPartiallyConnected) {
        this.disconnectCallbacks.forEach((cb) => cb());
      }
    }
  }

  private handleError(error: Error): void {
    this.errorCallbacks.forEach((cb) => cb(error));
  }

  // ============================================
  // Internal: Sending Messages
  // ============================================

  private send(message: ClientMessage): void {
    if (!this.transport || !this.transport.connected) {
      throw new LarkError('not_connected', 'Not connected to database');
    }
    // DEBUG: Log all outgoing messages
    if (typeof process !== 'undefined' && process.env?.LARK_DEBUG) {
      console.log('[LARK] >>> CLIENT:', JSON.stringify(message, null, 2));
    }
    this.transport.send(JSON.stringify(message));
  }

  /**
   * @internal Send a set operation.
   * Note: Priority is now part of the value (as .priority), not a separate field.
   */
  async _sendSet(path: string, value: unknown): Promise<void> {
    const normalizedPath = normalizePath(path) || '/';

    // Validate data before sending
    validateWriteData(value, normalizedPath);
    validateWriteSize(value, normalizedPath);

    const requestId = this.messageQueue.nextRequestId();

    // Get pending write IDs for this path (from subscribed Views)
    const pendingWriteIds = this.subscriptionManager.getPendingWriteIdsForPath(normalizedPath);

    const message: ClientMessage = {
      o: 's',
      p: normalizedPath,
      v: value, // Send original value with ServerValue placeholders to server
      r: requestId,
      pw: pendingWriteIds.length > 0 ? pendingWriteIds : undefined,
    };

    // Track the pending write using request ID
    this.pendingWrites.trackWrite(requestId, 'set', normalizedPath, value, message);

    // Also track in SubscriptionManager for View-level pending write tracking
    this.subscriptionManager.trackPendingWrite(normalizedPath, requestId);

    // Resolve ServerValues locally for optimistic update
    // Get current cached value for increment resolution
    const { value: currentValue } = this.subscriptionManager.getCachedValue(normalizedPath);
    const resolvedValue = resolveServerValuesLocally(value, currentValue);

    // Apply optimistically to local cache and fire events before sending
    this.subscriptionManager.applyOptimisticWrite(normalizedPath, resolvedValue, requestId, 'set');
    await this.deliverWrite(requestId, message);
  }

  /**
   * @internal Send an update operation.
   */
  async _sendUpdate(path: string, values: Record<string, unknown>): Promise<void> {
    const normalizedPath = normalizePath(path) || '/';

    // Validate each value being updated
    for (const [key, value] of Object.entries(values)) {
      const fullPath = key.startsWith('/') ? key : `${normalizedPath}/${key}`;
      validateWriteData(value, fullPath);
    }
    // Validate total size of the update
    validateWriteSize(values, normalizedPath);

    const requestId = this.messageQueue.nextRequestId();

    // Get pending write IDs for this path (from subscribed Views)
    const pendingWriteIds = this.subscriptionManager.getPendingWriteIdsForPath(normalizedPath);

    const message: ClientMessage = {
      o: 'u',
      p: normalizedPath,
      v: values, // Send original value with ServerValue placeholders to server
      r: requestId,
      pw: pendingWriteIds.length > 0 ? pendingWriteIds : undefined,
    };

    // Track the pending write using request ID
    this.pendingWrites.trackWrite(requestId, 'update', normalizedPath, values, message);

    // Also track in SubscriptionManager for View-level pending write tracking
    this.subscriptionManager.trackPendingWrite(normalizedPath, requestId);

    // Resolve ServerValues locally for optimistic update
    // For update, we need to resolve each value with its own current value at the appropriate path
    const resolvedValues: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      const fullPath = key.startsWith('/') ? key : `${normalizedPath}/${key}`;
      const { value: currentValue } = this.subscriptionManager.getCachedValue(fullPath);
      resolvedValues[key] = resolveServerValuesLocally(value, currentValue);
    }

    // Apply optimistically to local cache and fire events before sending
    this.subscriptionManager.applyOptimisticWrite(normalizedPath, resolvedValues, requestId, 'update');
    await this.deliverWrite(requestId, message);
  }

  /**
   * @internal Send a delete operation.
   */
  async _sendDelete(path: string): Promise<void> {
    const normalizedPath = normalizePath(path) || '/';

    const requestId = this.messageQueue.nextRequestId();

    // Get pending write IDs for this path (from subscribed Views)
    const pendingWriteIds = this.subscriptionManager.getPendingWriteIdsForPath(normalizedPath);

    const message: ClientMessage = {
      o: 'd',
      p: normalizedPath,
      r: requestId,
      pw: pendingWriteIds.length > 0 ? pendingWriteIds : undefined,
    };

    // Track the pending write using request ID
    this.pendingWrites.trackWrite(requestId, 'delete', normalizedPath, undefined, message);

    // Also track in SubscriptionManager for View-level pending write tracking
    this.subscriptionManager.trackPendingWrite(normalizedPath, requestId);

    // Apply optimistically to local cache and fire events before sending
    this.subscriptionManager.applyOptimisticWrite(normalizedPath, null, requestId, 'delete');
    await this.deliverWrite(requestId, message);
  }

  // ============================================
  // Volatile Write Operations (Fire-and-Forget)
  // ============================================

  /**
   * @internal Send a volatile set operation (fire-and-forget).
   *
   * Volatile writes skip:
   * - Recovery checks (volatile paths don't participate in recovery)
   * - Request ID generation (no ack expected)
   * - Pending write tracking (no retry on reconnect)
   * - pw field (no dependency tracking)
   *
   * The write is applied optimistically to local cache for UI feedback,
   * but we don't await server confirmation.
   *
   * When using WebTransport, volatile writes are sent via datagrams (UDP).
   */
  _sendVolatileSet(path: string, value: unknown): void {
    const normalizedPath = normalizePath(path) || '/';

    // Validate volatile write size (2 KB limit)
    validateVolatileWriteSize(value, normalizedPath);

    // Apply optimistically to local cache (for UI feedback)
    this.subscriptionManager.applyOptimisticWrite(normalizedPath, value, '', 'set');

    if (this._state !== 'authenticated' || !this.transport || !this.transport.connected) {
      // Silent fail for volatile writes when not authenticated or disconnected
      return;
    }

    // Fire-and-forget: no request ID, no pending tracking, no await
    // Uses sendVolatile which goes via datagrams on WebTransport
    const message: ClientMessage = {
      o: 's',
      p: normalizedPath,
      v: value,
    };
    this.transport.sendVolatile(JSON.stringify(message));
  }

  /**
   * @internal Send a volatile update operation (fire-and-forget).
   */
  _sendVolatileUpdate(path: string, values: Record<string, unknown>): void {
    const normalizedPath = normalizePath(path) || '/';

    // Validate volatile write size (2 KB limit)
    validateVolatileWriteSize(values, normalizedPath);

    // Apply optimistically to local cache (for UI feedback)
    this.subscriptionManager.applyOptimisticWrite(normalizedPath, values, '', 'update');

    if (this._state !== 'authenticated' || !this.transport || !this.transport.connected) {
      // Silent fail for volatile writes when not authenticated or disconnected
      return;
    }

    // Fire-and-forget via datagram on WebTransport
    const message: ClientMessage = {
      o: 'u',
      p: normalizedPath,
      v: values,
    };
    this.transport.sendVolatile(JSON.stringify(message));
  }

  /**
   * @internal Send a volatile delete operation (fire-and-forget).
   */
  _sendVolatileDelete(path: string): void {
    const normalizedPath = normalizePath(path) || '/';

    // Apply optimistically to local cache (for UI feedback)
    this.subscriptionManager.applyOptimisticWrite(normalizedPath, null, '', 'delete');

    if (this._state !== 'authenticated' || !this.transport || !this.transport.connected) {
      // Silent fail for volatile writes when not authenticated or disconnected
      return;
    }

    // Fire-and-forget via datagram on WebTransport
    const message: ClientMessage = {
      o: 'd',
      p: normalizedPath,
    };
    this.transport.sendVolatile(JSON.stringify(message));
  }

  /**
   * Check if a path is a volatile path (high-frequency, fire-and-forget).
   */
  isVolatilePath(path: string): boolean {
    return isVolatilePath(path, this._volatilePaths);
  }

  /**
   * @internal Send a once (read) operation.
   *
   * This method first checks if the data is available in the local cache
   * (from an active subscription). If so, it returns the cached value
   * immediately without a server round-trip.
   *
   * Cache is only used when:
   * - No query parameters are specified (queries may filter/order differently)
   * - The path is covered by an active 'value' subscription
   * - We have cached data available
   */
  async _sendOnce(path: string, query?: QueryParams): Promise<DataSnapshot> {
    const normalizedPath = normalizePath(path) || '/';

    // Handle .info paths locally (they're synthetic, not on the server)
    if (this.isInfoPath(normalizedPath)) {
      const value = this.getInfoValue(normalizedPath);
      return new DataSnapshot(value, path, this);
    }

    // Try cache first (only for non-query requests)
    if (!query) {
      const cached = this.subscriptionManager.getCachedValue(normalizedPath);
      if (cached.found) {
        return new DataSnapshot(cached.value, path, this);
      }
    }

    // Cache miss or query specified - fetch from server
    if (this._state !== 'authenticated') await this.ensureConnected();
    const requestId = this.messageQueue.nextRequestId();
    const message: ClientMessage = {
      o: 'o',
      p: normalizedPath,
      r: requestId,
      // Spread query params at top level (not nested in 'q')
      ...query,
    };
    this.send(message);
    const value = await this.messageQueue.registerRequest(requestId);
    return new DataSnapshot(value, path, this, { queryParams: query ?? null });
  }

  /**
   * @internal Send an onDisconnect operation.
   */
  async _sendOnDisconnect(
    path: string,
    action: string,
    value?: unknown
  ): Promise<void> {
    if (this._state !== 'authenticated') await this.ensureConnected();
    const requestId = this.messageQueue.nextRequestId();
    const message: ClientMessage = {
      o: 'od',
      p: normalizePath(path) || '/',
      a: action as 's' | 'u' | 'd' | 'c',
      r: requestId,
    };
    if (value !== undefined) {
      message.v = value;
    }
    this.send(message);
    await this.messageQueue.registerRequest(requestId);
  }

  /**
   * @internal Get a cached value from the subscription manager.
   * Used for optimistic writes where we need the current value without a network fetch.
   */
  _getCachedValue(path: string): { value: unknown; found: boolean } {
    const normalizedPath = normalizePath(path) || '/';
    return this.subscriptionManager.getCachedValue(normalizedPath);
  }

  /**
   * @internal Send a subscribe message to server.
   * Includes tag for non-default queries to enable proper event routing.
   */
  private async sendSubscribeMessage(path: string, queryParams?: QueryParams, tag?: number): Promise<void> {
    // While offline, goOnline() subscribes every view when it reconnects.
    if (this._offline) return;
    if (this._state !== 'authenticated') await this.ensureConnected();
    const requestId = this.messageQueue.nextRequestId();
    const message: ClientMessage = {
      o: 'sb',
      p: normalizePath(path) || '/',
      r: requestId,
      ...queryParams,
      ...(tag !== undefined ? { tag } : {}),
    };
    this.send(message);
    await this.messageQueue.registerRequest(requestId);
  }

  /**
   * @internal Send an unsubscribe message to server.
   * Includes query params and tag so server can identify which specific subscription to remove.
   */
  private async sendUnsubscribeMessage(path: string, queryParams?: QueryParams, tag?: number): Promise<void> {
    // The server dropped every subscription when the connection closed.
    if (this._offline) return;
    if (this._state !== 'authenticated') await this.ensureConnected();
    const requestId = this.messageQueue.nextRequestId();
    const message: ClientMessage = {
      o: 'us',
      p: normalizePath(path) || '/',
      r: requestId,
      ...queryParams,
      ...(tag !== undefined ? { tag } : {}),
    };
    this.send(message);
    await this.messageQueue.registerRequest(requestId);
  }

  /**
   * @internal Create a DataSnapshot from event data.
   */
  private createSnapshot(
    path: string,
    value: unknown,
    volatile: boolean,
    serverTimestamp?: number,
    orderedKeys?: string[]
  ): DataSnapshot {
    return new DataSnapshot(value, path, this, {
      volatile,
      serverTimestamp: serverTimestamp ?? null,
      orderedKeys: orderedKeys ?? null,
    });
  }

  // ============================================
  // Internal: Subscription Management
  // ============================================

  /**
   * @internal Subscribe to events at a path.
   */
  _subscribe(path: string, eventType: EventType, callback: SnapshotCallback, queryParams?: QueryParams, queryIdentifier?: string): () => void {
    // Handle .info paths locally (not sent to server)
    if (this.isInfoPath(path)) {
      return this.subscribeToInfo(path, callback);
    }
    return this.subscriptionManager.subscribe(path, eventType, callback, queryParams, queryIdentifier);
  }

  /**
   * @internal Unsubscribe from a specific event type at a path.
   */
  _unsubscribeEventType(path: string, eventType: EventType): void {
    this.subscriptionManager.unsubscribeEventType(path, eventType);
  }

  /**
   * @internal Unsubscribe from all events at a path.
   */
  _unsubscribeAll(path: string): void {
    this.subscriptionManager.unsubscribeAll(path);
  }
}
