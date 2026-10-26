import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { Duplex } from 'node:stream';

// The WebSocket relay against a FAKE upstream socket, so the timing that a
// real TCP pair hides is deterministic: the upstream delivers its whole answer
// in one push and is destroyed in the same tick, while the real client is not
// reading yet.

const SIZE = 64 * 1024 * 1024;
const FAKE_PORT = 65001;
const HEAD_101 = Buffer.from(
  'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'
);

const h = vi.hoisted(() => ({
  fakes: [] as {
    destroyCalls: number;
    ended: boolean;
    mode: 'burst' | 'idle' | 'fin';
  }[],
  mode: 'burst' as 'burst' | 'idle' | 'fin',
}));

vi.mock('node:net', async (importActual) => {
  const actual = await importActual<typeof import('node:net')>();
  const { Duplex: D } = await import('node:stream');
  return {
    ...actual,
    connect: (...args: unknown[]) => {
      const o = args[0] as { port?: number };
      if (typeof o !== 'object' || o === null || o.port !== FAKE_PORT) {
        return (actual.connect as (...a: unknown[]) => unknown)(...args);
      }
      const record = { destroyCalls: 0, ended: false, mode: h.mode };
      h.fakes.push(record);
      let first = true;
      const fake = new D({
        // Only an explicit destroy() counts, never stream auto-destruction.
        autoDestroy: false,
        read() {},
        write(_c, _e, cb) {
          if (first && record.mode === 'burst') {
            first = false;
            fake.push(Buffer.concat([HEAD_101, Buffer.alloc(SIZE, 0x61)]));
            fake.push(null);
            fake.destroy();
          } else if (first) {
            first = false;
            fake.push(HEAD_101);
            // 'fin': the app answers, then half-closes (FIN) right away.
            if (record.mode === 'fin') fake.push(null);
          }
          cb();
        },
        final(cb) {
          record.ended = true;
          cb();
        },
      }) as Duplex & { setNoDelay: () => void };
      const origDestroy = fake.destroy.bind(fake);
      fake.destroy = ((err?: Error) => {
        record.destroyCalls++;
        return origDestroy(err);
      }) as typeof fake.destroy;
      fake.setNoDelay = () => undefined;
      setImmediate(() => fake.emit('connect'));
      return fake;
    },
  };
});

const net = await import('node:net');
const { startMicrovmFrontDoor } = await import('../../../src/local/microvm-front-door.js');
type FrontDoor = Awaited<ReturnType<typeof startMicrovmFrontDoor>>;

const target = {
  microvmId: 'mvm-relay',
  state: () => 'running' as const,
  upstreamFor: (p: number) => (p === 8080 ? { host: '127.0.0.1', port: FAKE_PORT } : undefined),
  routablePorts: () => [8080],
  suspend: async () => undefined,
  resume: async () => undefined,
  terminate: async () => undefined,
};

const UPGRADE = [
  'GET /ws HTTP/1.1',
  'Host: x',
  'Upgrade: websocket',
  'Connection: Upgrade',
  'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
  'Sec-WebSocket-Version: 13',
  '',
  '',
].join('\r\n');

describe('microvm front door WebSocket relay (fake upstream)', () => {
  let fd: FrontDoor | undefined;
  afterEach(async () => {
    await fd?.close();
    fd = undefined;
    h.fakes = [];
  });

  it('delivers every byte to a client that is not reading when the upstream is destroyed', async () => {
    h.mode = 'burst';
    fd = await startMicrovmFrontDoor({ host: '127.0.0.1', port: 0, target, autoResume: false });
    const body = await new Promise<number>((resolveBody) => {
      const sock = net.connect(fd!.port, '127.0.0.1', () => sock.write(UPGRADE));
      let headSeen = false;
      let pending = Buffer.alloc(0);
      let total = 0;
      const done = (): void => {
        sock.destroy();
        resolveBody(total);
      };
      // Not reading for 200 ms: the relay must hold the data, not drop it.
      sock.pause();
      setTimeout(() => sock.resume(), 200);
      sock.on('data', (c: Buffer) => {
        if (!headSeen) {
          pending = Buffer.concat([pending, c]);
          const i = pending.indexOf('\r\n\r\n');
          if (i === -1) return;
          headSeen = true;
          total += pending.length - i - 4;
        } else {
          total += c.length;
        }
        if (total >= SIZE) done();
      });
      sock.on('error', () => undefined);
      sock.on('close', () => resolveBody(total));
    });
    expect(body).toBe(SIZE);
  }, 30_000);

  const openWs = (fdPort: number): Promise<import('node:net').Socket> =>
    new Promise((r) => {
      const sock = net.connect({ port: fdPort, host: '127.0.0.1', allowHalfOpen: true }, () =>
        sock.write(UPGRADE)
      );
      sock.on('error', () => undefined);
      sock.once('data', () => r(sock));
    });
  const settle = () => new Promise((r) => setTimeout(r, 100));

  it("a client half-close (FIN, 'end') only ends the upstream", async () => {
    h.mode = 'idle';
    fd = await startMicrovmFrontDoor({ host: '127.0.0.1', port: 0, target, autoResume: false });
    const sock = await openWs(fd.port);
    sock.end();
    await settle();
    expect(h.fakes[0]).toMatchObject({ ended: true, destroyCalls: 0 });
    sock.destroy();
  });

  it("a full client close ('close' after both FINs) destroys the upstream", async () => {
    h.mode = 'fin';
    fd = await startMicrovmFrontDoor({ host: '127.0.0.1', port: 0, target, autoResume: false });
    const sock = await openWs(fd.port);
    await settle(); // the upstream FIN reached the client through the relay
    sock.end();
    await settle();
    expect(h.fakes[0]!.destroyCalls).toBeGreaterThan(0);
    sock.destroy();
  });
});
