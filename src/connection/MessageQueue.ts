/**
 * MessageQueue - handles request/response correlation for WebSocket messages.
 *
 * Every reliable operation gets a unique request ID. When we send a message,
 * we create a promise and store it. When we receive an ack/nack, we resolve/reject
 * the corresponding promise.
 */

import { LarkError } from '../LarkError';
import { ErrorCode } from '../protocol/constants';
import {
  ServerMessage,
  isAckMessage,
  isAuthCompleteMessage,
  isAuthErrorMessage,
  isJoinCompleteMessage,
  isNackMessage,
  isOnceResponseMessage,
} from '../protocol/messages';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | undefined;
}

/** Response from join complete message */
export interface JoinCompleteResponse {
  volatilePaths: string[];
  connectionId: string | null;
  serverTime: number | null;
}

/** Response from auth complete message */
export interface AuthCompleteResponse {
  uid: string | null; // null for anonymous (empty string from server)
}

export class MessageQueue {
  private nextId = 1;
  private pending = new Map<string, PendingRequest>();
  private defaultTimeout: number;

  constructor(defaultTimeout: number = 30000) {
    this.defaultTimeout = defaultTimeout;
  }

  /**
   * Generate a new unique request ID.
   */
  nextRequestId(): string {
    return String(this.nextId++);
  }

  /**
   * Register a pending request that expects a response.
   * Returns a promise that resolves when ack is received, or rejects on nack/timeout.
   * A timeout of `Infinity` waits without a limit, for a write held until the
   * connection is ready.
   */
  registerRequest(requestId: string, timeout?: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeoutMs = timeout ?? this.defaultTimeout;

      const timeoutHandle = Number.isFinite(timeoutMs)
        ? setTimeout(() => {
            this.pending.delete(requestId);
            reject(new LarkError('timeout', `Request ${requestId} timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : undefined;

      this.pending.set(requestId, {
        resolve,
        reject,
        timeout: timeoutHandle,
      });
    });
  }

  /**
   * Handle an incoming server message. If it's a response to a pending request,
   * resolve or reject the corresponding promise.
   *
   * @returns true if the message was handled (was a response), false otherwise
   */
  handleMessage(message: ServerMessage): boolean {
    // Join complete (includes volatile paths and connection ID)
    if (isJoinCompleteMessage(message)) {
      const pending = this.pending.get(message.jc);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(message.jc);
        // Resolve with full join response
        const response: JoinCompleteResponse = {
          volatilePaths: message.vp || [],
          connectionId: message.cid || null,
          serverTime: message.st ?? null,
        };
        pending.resolve(response);
        return true;
      }
    }

    // Auth complete (includes UID)
    if (isAuthCompleteMessage(message)) {
      const pending = this.pending.get(message.ac);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(message.ac);
        // Resolve with auth response (empty string from server means anonymous)
        const response: AuthCompleteResponse = {
          uid: message.au || null,
        };
        pending.resolve(response);
        return true;
      }
    }

    // Auth rejected (bad or expired token)
    if (isAuthErrorMessage(message)) {
      const pending = this.pending.get(message.ae);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(message.ae);
        pending.reject(new LarkError(ErrorCode.AUTH_FAILED, message.err));
        return true;
      }
    }

    // Regular ack
    if (isAckMessage(message)) {
      const pending = this.pending.get(message.a);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(message.a);
        pending.resolve(undefined);
        return true;
      }
    }

    // Nack (error)
    if (isNackMessage(message)) {
      const pending = this.pending.get(message.n);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(message.n);
        pending.reject(new LarkError(message.e, message.m));
        return true;
      }
    }

    // Once response
    if (isOnceResponseMessage(message)) {
      const pending = this.pending.get(message.oc);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(message.oc);
        // Normalize undefined to null (null = no data at path)
        pending.resolve(message.ov ?? null);
        return true;
      }
    }

    return false;
  }

  /**
   * Reject a specific pending request locally (without server message).
   * Used for client-side taint propagation when a write fails and
   * dependent writes need to be rejected.
   *
   * @returns true if the request was pending and rejected, false otherwise
   */
  rejectLocally(requestId: string, error: Error): boolean {
    const pending = this.pending.get(requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pending.delete(requestId);
      pending.reject(error);
      return true;
    }
    return false;
  }

  /**
   * Reject all pending requests (e.g., on disconnect), except those `keep`
   * returns true for.
   */
  rejectAll(error: Error, keep?: (requestId: string) => boolean): void {
    for (const [requestId, pending] of this.pending) {
      if (keep?.(requestId)) continue;
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(requestId);
    }
  }

  /**
   * Get the number of pending requests.
   */
  get pendingCount(): number {
    return this.pending.size;
  }
}
