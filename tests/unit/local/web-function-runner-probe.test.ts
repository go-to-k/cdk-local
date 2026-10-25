import { describe, expect, it, vi } from 'vite-plus/test';
import { EventEmitter } from 'node:events';

// The probe's connect gate, against a fake `http.request`: a socket timeout
// BEFORE `connect` (a dropped SYN) is "refused", and only one AFTER `connect`
// is "accepted but slow". No packet leaves the machine.

const fake = vi.hoisted(() => ({ connectFirst: false }));

vi.mock('http', async (importActual) => {
  const { EventEmitter: EE } = await import('node:events');
  return {
    ...(await importActual<object>()),
    request: vi.fn(() => {
      const req = new EE() as EventEmitter & { end: () => void; destroy: () => void };
      const socket = new EE();
      req.destroy = () => {
        queueMicrotask(() => req.emit('error', new Error('socket hang up')));
      };
      req.end = () => {
        queueMicrotask(() => {
          req.emit('socket', socket);
          if (fake.connectFirst) socket.emit('connect');
          req.emit('timeout');
        });
      };
      return req;
    }),
  };
});

const { probeHttp } = await import('../../../src/local/web-function-runner.js');

describe('probeHttp connect gate', () => {
  it('is refused when the socket times out before connect', async () => {
    fake.connectFirst = false;
    expect(await probeHttp('127.0.0.1', 1, 100)).toBe('refused');
  });

  it('is a timeout when the socket connected and then timed out', async () => {
    fake.connectFirst = true;
    expect(await probeHttp('127.0.0.1', 1, 100)).toBe('timeout');
  });
});
