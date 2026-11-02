/**
 * PendingWriteManager - tracks pending write operations for optimistic updates.
 *
 * Each write operation is assigned a unique operation ID (oid). The manager tracks
 * pending writes until they are acknowledged by the server. On reconnect, pending
 * writes can be retried to ensure data consistency.
 */

export type WriteOperation = 'set' | 'update' | 'delete' | 'transaction';

export interface PendingWrite {
  oid: string;
  operation: WriteOperation;
  path: string;
  value?: unknown;
  /** The message as first built, resent unchanged if the write is still pending. */
  message?: object;
  timestamp: number;
}

export class PendingWriteManager {
  private pending = new Map<string, PendingWrite>();

  /**
   * Track a new pending write operation.
   * Uses the request ID as the tracking key.
   */
  trackWrite(
    requestId: string,
    operation: WriteOperation,
    path: string,
    value?: unknown,
    message?: object
  ): void {
    this.pending.set(requestId, {
      oid: requestId,
      operation,
      path,
      value,
      message,
      timestamp: Date.now(),
    });
  }

  /**
   * Called when a write is acknowledged by the server.
   * Removes the write from pending tracking.
   */
  onAck(oid: string): boolean {
    return this.pending.delete(oid);
  }

  /**
   * Called when a write is rejected by the server.
   * Removes the write from pending tracking.
   */
  onNack(oid: string): boolean {
    return this.pending.delete(oid);
  }

  /**
   * Get all pending writes for retry on reconnect.
   * Returns writes in order of their timestamps (oldest first).
   */
  getPendingWrites(): PendingWrite[] {
    const writes = Array.from(this.pending.values());
    writes.sort((a, b) => a.timestamp - b.timestamp);
    return writes;
  }

  /**
   * Check if a specific operation is still pending.
   */
  isPending(oid: string): boolean {
    return this.pending.has(oid);
  }

  /**
   * Get the number of pending writes.
   */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Clear all pending writes (e.g., on disconnect when not retrying).
   */
  clear(): void {
    this.pending.clear();
  }

  /**
   * Remove writes older than a specified age (in milliseconds).
   * Useful for cleaning up stale pending writes that may never be acked.
   */
  removeStale(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;

    for (const [oid, write] of this.pending) {
      if (write.timestamp < cutoff) {
        this.pending.delete(oid);
        removed++;
      }
    }

    return removed;
  }
}
