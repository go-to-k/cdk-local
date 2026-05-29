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
});
