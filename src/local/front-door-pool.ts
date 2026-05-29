/**
 * Issue #86 v1 — in-process pool of host-reachable replica endpoints behind a
 * local ALB front-door. The service runner registers one entry per replica
 * (the `127.0.0.1:<ephemeralHostPort>` the replica's target container port was
 * published on) as replicas boot, and unregisters on restart / shutdown. The
 * front-door server reads `next()` per request to round-robin across the live
 * set.
 *
 * Modeled on `CloudMapRegistry`: synchronous Map mutations so a `next()` read
 * concurrent with a `register()` / `unregister()` returns a consistent
 * snapshot — never a partially-mutated one. No async / mutex needed.
 *
 * Entries are keyed by `ownerKey` (typically `<serviceLogicalId>:r<index>`) so
 * a replica restart re-registers idempotently and shutdown can drop a single
 * replica without disturbing its peers.
 */

export interface FrontDoorEndpoint {
  /** Host the replica's target container port was published on (e.g. `127.0.0.1`). */
  host: string;
  /** Docker-assigned ephemeral host port forwarding to the replica container. */
  port: number;
}

interface PoolEntry extends FrontDoorEndpoint {
  ownerKey: string;
}

export class FrontDoorEndpointPool {
  private entries: PoolEntry[] = [];
  /** Monotonic counter; `next()` rotates over the current entries by index. */
  private cursor = 0;

  /**
   * Register (or idempotently replace) the endpoint for `ownerKey`. A replica
   * restart calls this again with the same key and the new ephemeral port; the
   * prior entry for that key is replaced rather than duplicated.
   */
  register(ownerKey: string, endpoint: FrontDoorEndpoint): void {
    if (!ownerKey) throw new Error('FrontDoorEndpointPool.register: ownerKey must be non-empty.');
    const next = this.entries.filter((e) => e.ownerKey !== ownerKey);
    next.push({ ownerKey, host: endpoint.host, port: endpoint.port });
    this.entries = next;
  }

  /** Drop the endpoint for `ownerKey`. Idempotent; returns whether one was removed. */
  unregister(ownerKey: string): boolean {
    const next = this.entries.filter((e) => e.ownerKey !== ownerKey);
    const removed = next.length !== this.entries.length;
    this.entries = next;
    return removed;
  }

  /**
   * Round-robin the next live endpoint, or `undefined` when the pool is empty
   * (the front-door server replies 503 in that case). The cursor advances per
   * call; modulo by the current length tolerates entries being added / removed
   * between calls.
   */
  next(): FrontDoorEndpoint | undefined {
    if (this.entries.length === 0) return undefined;
    const entry = this.entries[this.cursor % this.entries.length]!;
    this.cursor = (this.cursor + 1) % Number.MAX_SAFE_INTEGER;
    return { host: entry.host, port: entry.port };
  }

  /** Snapshot of the current endpoints (for diagnostics / tests). */
  list(): ReadonlyArray<FrontDoorEndpoint> {
    return this.entries.map((e) => ({ host: e.host, port: e.port }));
  }

  /** Number of live endpoints. */
  size(): number {
    return this.entries.length;
  }
}
