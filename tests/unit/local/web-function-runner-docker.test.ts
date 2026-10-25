import { describe, expect, it, vi } from 'vite-plus/test';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:net';

// The Docker-child seams of web-function-runner (`docker wait`, `docker logs`)
// against fake child processes, and the HTTP probe against real sockets.

class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

const procs = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('child_process', async (importActual) => ({
  ...(await importActual<object>()),
  spawn: vi.fn(() => {
    const p = new FakeProc();
    procs.list.push(p);
    return p;
  }),
}));

const { watchContainerExit, readContainerLogTail, probeHttp } = await import(
  '../../../src/local/web-function-runner.js'
);

const last = (): FakeProc => procs.list[procs.list.length - 1] as FakeProc;
const settled = async <T>(p: Promise<T>): Promise<{ v?: T; pending: boolean }> =>
  Promise.race([
    p.then((v) => ({ v, pending: false })),
    new Promise<{ pending: boolean }>((r) => setTimeout(() => r({ pending: true }), 20)),
  ]);

describe('watchContainerExit', () => {
  it('resolves with the exit code docker wait prints', async () => {
    const w = watchContainerExit('cid');
    last().stdout.emit('data', Buffer.from('3\n'));
    last().emit('close', 0);
    expect(await w.exited).toBe(3);
  });

  it('resolves undefined for an unreadable exit code', async () => {
    const w = watchContainerExit('cid');
    last().stdout.emit('data', Buffer.from('not a number'));
    last().emit('close', 1);
    expect(await w.exited).toBeUndefined();
  });

  it('never resolves after stop(), even when the child then closes', async () => {
    const w = watchContainerExit('cid');
    const proc = last();
    w.stop();
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    proc.stdout.emit('data', Buffer.from('137\n'));
    proc.emit('close', 0);
    expect((await settled(w.exited)).pending).toBe(true);
  });
});

describe('readContainerLogTail', () => {
  it('merges stdout and stderr in arrival order, keeping the last N lines', async () => {
    const p = readContainerLogTail('cid', 3);
    const proc = last();
    proc.stdout.emit('data', Buffer.from('out-1\n'));
    proc.stderr.emit('data', Buffer.from('Error: boom-at-boot\r\n'));
    proc.stdout.emit('data', Buffer.from('out-2\n'));
    proc.stderr.emit('data', Buffer.from('    at index.js:3\n'));
    proc.emit('close', 0);
    expect(await p).toEqual(['Error: boom-at-boot', 'out-2', '    at index.js:3']);
  });

  it('rejects when docker logs fails', async () => {
    const p = readContainerLogTail('gone', 5);
    last().emit('close', 1);
    await expect(p).rejects.toThrow(/docker logs exited 1/);
  });
});

describe('probeHttp', () => {
  const listen = (onConn: (s: import('node:net').Socket) => void): Promise<{ server: Server; port: number }> =>
    new Promise((r) => {
      const server = createServer(onConn);
      server.listen(0, '127.0.0.1', () => {
        const a = server.address();
        r({ server, port: typeof a === 'object' && a ? a.port : 0 });
      });
    });

  it('is answered by any HTTP status', async () => {
    const { server, port } = await listen((s) => {
      s.on('data', () => s.end('HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n'));
    });
    expect(await probeHttp('127.0.0.1', port, 1000)).toBe('answered');
    server.close();
  });

  it('is a timeout only when the connection was accepted but not answered', async () => {
    const sockets: import('node:net').Socket[] = [];
    const { server, port } = await listen((s) => void sockets.push(s));
    expect(await probeHttp('127.0.0.1', port, 150)).toBe('timeout');
    for (const s of sockets) s.destroy();
    server.close();
  });

  it('is refused, not "accepted but slow", when the connect itself never completes', async () => {
    // A non-routable address: the SYN is dropped (or the route refused), so the
    // socket timeout fires before any `connect` event.
    expect(await probeHttp('10.255.255.1', 9, 150)).toBe('refused');
  });

  it('is refused when nothing listens', async () => {
    const { server, port } = await listen(() => undefined);
    await new Promise((r) => server.close(r));
    expect(await probeHttp('127.0.0.1', port, 500)).toBe('refused');
  });
});
