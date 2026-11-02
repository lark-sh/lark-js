/**
 * Wire protocol message types.
 * All communication uses JSON over WebSocket with shortened keys.
 */

import { EventType } from './constants';

// ============================================
// Client -> Server Messages
// ============================================

export interface JoinMessage {
  o: 'j'; // operation: join
  d: string; // database ID (e.g., "project/database")
  r: string; // request ID
  pcid?: string; // previous connection ID (for reconnect deduplication)
}

export interface AuthMessage {
  o: 'au'; // operation: auth
  t: string; // token (empty string for anonymous)
  r: string; // request ID
}

export interface UnauthMessage {
  o: 'ua'; // operation: unauth (sign out)
  r: string; // request ID
}

export interface SetMessage {
  o: 's'; // operation: set
  p: string; // path
  v: unknown; // value (priority is included as .priority if set)
  r?: string; // request ID (optional for volatile/fire-and-forget writes)
  pw?: string[]; // pending write IDs for same View (for local-first recovery)
}

export interface UpdateMessage {
  o: 'u'; // operation: update
  p: string; // path
  v: Record<string, unknown>; // values to merge
  r?: string; // request ID (optional for volatile/fire-and-forget writes)
  pw?: string[]; // pending write IDs for same View (for local-first recovery)
}

export interface DeleteMessage {
  o: 'd'; // operation: delete
  p: string; // path
  r?: string; // request ID (optional for volatile/fire-and-forget writes)
  pw?: string[]; // pending write IDs for same View (for local-first recovery)
}

export interface SubscribeMessage {
  o: 'sb'; // operation: subscribe
  p: string; // path
  r: string; // request ID
  tag?: number; // client-local tag for routing events to correct View (non-default queries)
  // Query parameters (optional) - at top level per VIEW_REFACTOR.md
  orderBy?: string;
  orderByChild?: string;
  limitToFirst?: number;
  limitToLast?: number;
  startAt?: unknown;
  startAtKey?: string;
  startAfter?: unknown;
  startAfterKey?: string;
  endAt?: unknown;
  endAtKey?: string;
  endBefore?: unknown;
  endBeforeKey?: string;
  equalTo?: unknown;
  equalToKey?: string;
}

export interface QueryParams {
  orderBy?: 'key' | 'priority' | 'child' | 'value';
  orderByChild?: string; // child path (when orderBy='child')
  limitToFirst?: number;
  limitToLast?: number;
  startAt?: unknown; // startAt value
  startAtKey?: string; // startAt key tie-breaker
  startAfter?: unknown; // startAfter value (exclusive)
  startAfterKey?: string; // startAfter key tie-breaker
  endAt?: unknown; // endAt value
  endAtKey?: string; // endAt key tie-breaker
  endBefore?: unknown; // endBefore value (exclusive)
  endBeforeKey?: string; // endBefore key tie-breaker
  equalTo?: unknown; // equalTo value
  equalToKey?: string; // equalTo key tie-breaker
}

export interface UnsubscribeMessage {
  o: 'us'; // operation: unsubscribe
  p: string; // path
  r: string; // request ID
  tag?: number; // client-local tag (same as sent on subscribe)
  // Query parameters (optional) - same format as SubscribeMessage
  // Server uses these to identify which specific subscription to remove
  orderBy?: string;
  orderByChild?: string;
  limitToFirst?: number;
  limitToLast?: number;
  startAt?: unknown;
  startAtKey?: string;
  startAfter?: unknown;
  startAfterKey?: string;
  endAt?: unknown;
  endAtKey?: string;
  endBefore?: unknown;
  endBeforeKey?: string;
  equalTo?: unknown;
  equalToKey?: string;
}

export interface OnceMessage {
  o: 'o'; // operation: once
  p: string; // path
  r: string; // request ID
  // Query parameters (optional) - at top level (same as SubscribeMessage)
  orderBy?: string;
  orderByChild?: string;
  limitToFirst?: number;
  limitToLast?: number;
  startAt?: unknown;
  startAtKey?: string;
  startAfter?: unknown;
  startAfterKey?: string;
  endAt?: unknown;
  endAtKey?: string;
  endBefore?: unknown;
  endBeforeKey?: string;
  equalTo?: unknown;
  equalToKey?: string;
}

export interface OnDisconnectMessage {
  o: 'od'; // operation: onDisconnect
  p: string; // path
  a: 's' | 'u' | 'd' | 'c'; // action: set, update, delete, cancel
  v?: unknown; // value (for set/update, priority is included as .priority if set)
  r: string; // request ID
}

export interface LeaveMessage {
  o: 'l'; // operation: leave
  r: string; // request ID
}

export interface PongMessage {
  o: 'po'; // operation: pong (response to server ping)
}

// Transaction operation types (used in ops array)
export interface TxSetOp {
  o: 's'; // set
  p: string; // path
  v: unknown; // value
}

export interface TxUpdateOp {
  o: 'u'; // update (merge)
  p: string; // path
  v: Record<string, unknown>; // values to merge
}

export interface TxDeleteOp {
  o: 'd'; // delete
  p: string; // path
}

// Condition with direct value comparison (for primitives)
export interface TxConditionValueOp {
  o: 'c'; // condition (compare-and-swap check)
  p: string; // path
  v: unknown; // expected value (for primitives: null, boolean, number, string)
}

// Condition with hash comparison (for complex objects/arrays)
export interface TxConditionHashOp {
  o: 'c'; // condition (compare-and-swap check)
  p: string; // path
  h: string; // SHA-256 hash of JCS-canonicalized value
}

export type TxConditionOp = TxConditionValueOp | TxConditionHashOp;

export type TxOperation = TxSetOp | TxUpdateOp | TxDeleteOp | TxConditionOp;

export interface TransactionMessage {
  o: 'tx'; // operation: transaction
  ops: TxOperation[]; // array of operations
  r: string; // request ID
}

export type ClientMessage =
  | JoinMessage
  | AuthMessage
  | UnauthMessage
  | SetMessage
  | UpdateMessage
  | DeleteMessage
  | SubscribeMessage
  | UnsubscribeMessage
  | OnceMessage
  | OnDisconnectMessage
  | LeaveMessage
  | PongMessage
  | TransactionMessage;

// ============================================
// Server -> Client Messages
// ============================================

export interface AckMessage {
  a: string; // ack with request ID
}

export interface NackMessage {
  n: string; // nack with request ID
  e: string; // error code
  m?: string; // human-readable message
  sp?: string; // subscription path (for subscription revocation due to auth change)
}

// New delta-based event format
// Server sends 'put' for single-path changes, 'patch' for multi-path changes
// Client generates child_* events locally from these deltas

export interface PutEventMessage {
  ev: 'put'; // event type: single-path delta
  sp: string; // subscription path (absolute) - identifies which subscription
  p: string; // delta path (relative to sp), "/" means full snapshot
  v?: unknown; // value, null for deletion
  x?: boolean; // volatile flag
  ts?: number; // server timestamp in ms (for volatile events)
  tag?: number; // tag for routing to specific View (non-default queries)
}

export interface PatchEventMessage {
  ev: 'patch'; // event type: multi-path delta
  sp: string; // subscription path (absolute)
  p: string; // base path (usually "/")
  v?: Record<string, unknown>; // multiple path:value pairs (relative to sp+p)
  x?: boolean; // volatile flag
  ts?: number; // server timestamp in ms (for volatile events)
  tag?: number; // tag for routing to specific View (non-default queries)
}

export type EventMessage = PutEventMessage | PatchEventMessage;

export interface OnceResponseMessage {
  oc: string; // once response with request ID
  ov: unknown; // value
}

export interface JoinCompleteMessage {
  jc: string; // join complete with request ID
  vp?: string[] | null; // volatile path patterns (e.g., ["players/*/position"])
  cid?: string; // connection ID (for reconnect deduplication)
  st?: number; // server time in ms (for calculating serverTimeOffset)
}

export interface AuthCompleteMessage {
  ac: string; // auth complete with request ID
  au: string; // UID (empty string for anonymous)
}

/** The token was rejected. Sent in place of AuthCompleteMessage. */
export interface AuthErrorMessage {
  ae: string; // auth error with request ID
  err: string; // human-readable reason
}

export interface PingMessage {
  o: 'pi'; // operation: ping (keepalive from server)
}

export type ServerMessage =
  | AckMessage
  | NackMessage
  | EventMessage
  | OnceResponseMessage
  | JoinCompleteMessage
  | AuthCompleteMessage
  | AuthErrorMessage
  | PingMessage;

// ============================================
// Helper functions
// ============================================

export function isAckMessage(msg: ServerMessage): msg is AckMessage {
  return 'a' in msg;
}

export function isJoinCompleteMessage(msg: ServerMessage): msg is JoinCompleteMessage {
  return 'jc' in msg;
}

export function isAuthCompleteMessage(msg: ServerMessage): msg is AuthCompleteMessage {
  return 'ac' in msg;
}

export function isAuthErrorMessage(msg: ServerMessage): msg is AuthErrorMessage {
  return 'ae' in msg;
}

export function isNackMessage(msg: ServerMessage): msg is NackMessage {
  return 'n' in msg;
}

export function isEventMessage(msg: ServerMessage): msg is EventMessage {
  return 'ev' in msg;
}

export function isPutEventMessage(msg: ServerMessage): msg is PutEventMessage {
  return 'ev' in msg && (msg as EventMessage).ev === 'put';
}

export function isPatchEventMessage(msg: ServerMessage): msg is PatchEventMessage {
  return 'ev' in msg && (msg as EventMessage).ev === 'patch';
}

export function isOnceResponseMessage(msg: ServerMessage): msg is OnceResponseMessage {
  return 'oc' in msg;
}

export function isPingMessage(msg: ServerMessage): msg is PingMessage {
  return 'o' in msg && (msg as PingMessage).o === 'pi';
}
