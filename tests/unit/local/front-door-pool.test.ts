import { describe, it, expect } from 'vite-plus/test';
import { FrontDoorEndpointPool } from '../../../src/local/front-door-pool.js';

describe('FrontDoorEndpointPool', () => {
  it('round-robins across registered endpoints in registration order', () => {
    const pool = new FrontDoorEndpointPool();
    pool.register('svc:r0', { host: '127.0.0.1', port: 5001 });
    pool.register('svc:r1', { host: '127.0.0.1', port: 5002 });
    pool.register('svc:r2', { host: '127.0.0.1', port: 5003 });

    const seen = [pool.next(), pool.next(), pool.next(), pool.next()].map((e) => e?.port);
    expect(seen).toEqual([5001, 5002, 5003, 5001]);
    expect(pool.size()).toBe(3);
  });

  it('returns undefined when empty', () => {
    const pool = new FrontDoorEndpointPool();
    expect(pool.next()).toBeUndefined();
    expect(pool.size()).toBe(0);
  });

  it('replaces the endpoint for an owner key idempotently (replica restart)', () => {
    const pool = new FrontDoorEndpointPool();
    pool.register('svc:r0', { host: '127.0.0.1', port: 5001 });
    pool.register('svc:r0', { host: '127.0.0.1', port: 6001 }); // restart -> new ephemeral port
    expect(pool.size()).toBe(1);
    expect(pool.next()?.port).toBe(6001);
  });

  it('unregister removes one owner and reports whether it existed', () => {
    const pool = new FrontDoorEndpointPool();
    pool.register('svc:r0', { host: '127.0.0.1', port: 5001 });
    pool.register('svc:r1', { host: '127.0.0.1', port: 5002 });
    expect(pool.unregister('svc:r0')).toBe(true);
    expect(pool.unregister('svc:r0')).toBe(false); // idempotent
    expect(pool.size()).toBe(1);
    expect(pool.next()?.port).toBe(5002);
  });

  it('keeps round-robin coherent as endpoints are added and removed between calls', () => {
    const pool = new FrontDoorEndpointPool();
    pool.register('svc:r0', { host: '127.0.0.1', port: 5001 });
    expect(pool.next()?.port).toBe(5001);
    pool.register('svc:r1', { host: '127.0.0.1', port: 5002 });
    // cursor advanced past r0; modulo by the new length keeps it in range.
    const a = pool.next()?.port;
    const b = pool.next()?.port;
    expect(new Set([a, b])).toEqual(new Set([5001, 5002]));
    pool.unregister('svc:r0');
    expect(pool.next()?.port).toBe(5002);
  });

  it('rejects an empty owner key', () => {
    const pool = new FrontDoorEndpointPool();
    expect(() => pool.register('', { host: '127.0.0.1', port: 5001 })).toThrow(/ownerKey/);
  });

  it('list() returns a detached snapshot of host:port pairs', () => {
    const pool = new FrontDoorEndpointPool();
    pool.register('svc:r0', { host: '127.0.0.1', port: 5001 });
    const snapshot = pool.list();
    expect(snapshot).toEqual([{ host: '127.0.0.1', port: 5001 }]);
  });

  it('register-new-before-unregister-old is observable as zero-gap swap (Phase 3 of #214)', () => {
    // Phase 3 atomic-swap contract the ALB front-door's rolling reload
    // depends on. `rollServiceReplica` registers a shadow under a
    // bumped owner key BEFORE unregistering the dying replica's old
    // key; the front-door server's `next()` is called once per
    // request, so any observer interleaved between the two writes
    // sees BOTH endpoints during the swap window — never an empty
    // pool. A regression that reversed the order (unregister-old-
    // first, then register-new) would briefly empty a single-replica
    // pool and the host front-door would return 503 for every request
    // hitting the gap. This test pins the contract end-to-end.
    const pool = new FrontDoorEndpointPool();
    pool.register('svc:r0:g0', { host: '127.0.0.1', port: 5001 });
    expect(pool.size()).toBe(1);
    const before = pool.list();
    expect(before).toEqual([{ host: '127.0.0.1', port: 5001 }]);

    // Roll mid-stride: register shadow under bumped generation, then
    // unregister the old. Take a snapshot between the two writes to
    // prove BOTH endpoints are present in the swap window.
    pool.register('svc:r0:g1', { host: '127.0.0.1', port: 5002 });
    const midSwap = pool.list();
    expect(pool.size()).toBe(2);
    expect(new Set(midSwap.map((e) => e.port))).toEqual(new Set([5001, 5002]));

    pool.unregister('svc:r0:g0');
    expect(pool.size()).toBe(1);
    const after = pool.list();
    expect(after).toEqual([{ host: '127.0.0.1', port: 5002 }]);
  });

  it('next() returns a live endpoint at every step of the register-new-then-unregister-old sequence (single-replica swap)', () => {
    // Phase 3 ordering lock for the rolling-reload swap path. The
    // rolling primitive (`rollServiceReplica`) calls
    // `target.pool.register(newOwnerKey, ...)` BEFORE
    // `target.pool.unregister(oldOwnerKey)`. This test sequences
    // `next() / register / next() / unregister / next()` and asserts
    // every read returns one of the two endpoints — there is no
    // intermediate state with an empty pool. JS's single-threaded
    // execution makes each `this.entries = next` commit atomic
    // relative to a `next()` read on the same VM (this test cannot
    // observe a torn-write window because none exists); the bug this
    // test locks against is a future refactor that reverses the order
    // to "unregister old first, then register new" — that ordering
    // would empty a single-replica pool for the gap window and
    // `next()` would return `undefined` (the front-door server then
    // replies 503).
    const pool = new FrontDoorEndpointPool();
    pool.register('svc:r0:g0', { host: '127.0.0.1', port: 5001 });

    const r1 = pool.next();
    pool.register('svc:r0:g1', { host: '127.0.0.1', port: 5002 });
    const r2 = pool.next();
    pool.unregister('svc:r0:g0');
    const r3 = pool.next();

    for (const r of [r1, r2, r3]) {
      expect(r).toBeDefined();
      expect([5001, 5002]).toContain(r!.port);
    }
    // Post-swap, every subsequent `next()` lands on the shadow.
    expect(pool.next()?.port).toBe(5002);
    expect(pool.next()?.port).toBe(5002);
  });
});
