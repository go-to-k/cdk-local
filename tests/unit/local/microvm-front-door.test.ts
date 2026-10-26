import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import {
  MicrovmStateError,
  rewriteUpgradeResponseHead,
  selectTargetPort,
  startMicrovmFrontDoor,
  stripMicrovmProxyHeaders,
  type MicrovmProxyTarget,
  type MicrovmState,
  type RunningMicrovmFrontDoor,
} from '../../../src/local/microvm-front-door.js';

describe('selectTargetPort', () => {
  it('defaults to 8080, reads X-aws-proxy-port, and lets the ws port subprotocol win', () => {
    expect(selectTargetPort({})).toEqual({ ok: true, port: 8080 });
    expect(selectTargetPort({ 'x-aws-proxy-port': '9000' })).toEqual({ ok: true, port: 9000 });
    expect(
      selectTargetPort({
        'x-aws-proxy-port': '9000',
        'sec-websocket-protocol': 'lambda-microvms, lambda-microvms.port.7000',
      })
    ).toEqual({ ok: true, port: 7000 });
  });

  it('answers 400 for a value that is not a port', () => {
    for (const bad of ['abc', '0', '65536', '-1', '80.5', '']) {
      const r = selectTargetPort({ 'x-aws-proxy-port': bad });
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.status).toBe(400);
    }
    const ws = selectTargetPort({ 'sec-websocket-protocol': 'lambda-microvms.port.x' });
    expect(ws).toMatchObject({ ok: false, message: expect.stringMatching(/subprotocol/) });
  });
});

describe('stripMicrovmProxyHeaders', () => {
  it('drops every X-aws-proxy-* header and the MicroVM subprotocols, keeping the rest', () => {
    const headers: Record<string, string> = {
      'x-aws-proxy-port': '9000',
      'x-aws-proxy-auth': 'jwe',
      'x-aws-proxy-anything': '1',
      'x-other': 'keep',
      'sec-websocket-protocol':
        'lambda-microvms, lambda-microvms.authentication.tok, lambda-microvms.port.9000, chat',
    };
    expect(stripMicrovmProxyHeaders(headers)).toBe(true);
    expect(headers).toEqual({ 'x-other': 'keep', 'sec-websocket-protocol': 'chat' });
  });

  it('removes the subprotocol header when only MicroVM protocols were offered', () => {
    const headers: Record<string, string> = { 'sec-websocket-protocol': 'lambda-microvms' };
    stripMicrovmProxyHeaders(headers);
    expect(headers).toEqual({});
  });
});

describe('rewriteUpgradeResponseHead', () => {
  const head = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket';
  it('selects lambda-microvms on a 101 that selected nothing', () => {
    expect(rewriteUpgradeResponseHead(head, true)).toBe(
      `${head}\r\nSec-WebSocket-Protocol: lambda-microvms`
    );
  });
  it('leaves a selected protocol, a non-101 and an opted-out head alone', () => {
    const selected = `${head}\r\nSec-WebSocket-Protocol: chat`;
    expect(rewriteUpgradeResponseHead(selected, true)).toBe(selected);
    expect(rewriteUpgradeResponseHead('HTTP/1.1 400 Bad', true)).toBe('HTTP/1.1 400 Bad');
    expect(rewriteUpgradeResponseHead(head, false)).toBe(head);
  });
});

describe('startMicrovmFrontDoor', () => {
  const servers: Server[] = [];
  let fd: RunningMicrovmFrontDoor | undefined;
  let seen: { port: number; headers: IncomingMessage['headers']; url: string | undefined }[];
  let upstreamPorts: Map<number, number>;
  let target: MicrovmProxyTarget & { setState(s: MicrovmState): void; calls: string[] };

  const listen = (server: Server): Promise<number> =>
    new Promise((r) => {
      servers.push(server);
      server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port));
    });

  beforeEach(async () => {
    seen = [];
    upstreamPorts = new Map();
    for (const containerPort of [8080, 9000]) {
      const server = createServer((req, res) => {
        seen.push({ port: containerPort, headers: req.headers, url: req.url });
        res.writeHead(200, { 'content-type': 'text/plain' }).end(`from ${containerPort}`);
      });
      server.on('upgrade', (req, socket) => {
        seen.push({ port: containerPort, headers: req.headers, url: req.url });
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nFRAME'
        );
        socket.end();
      });
      upstreamPorts.set(containerPort, await listen(server));
    }
    // 7000 is "published" but nothing listens there.
    const dead = createServer();
    const deadPort = await listen(dead);
    await new Promise<void>((r) => dead.close(() => r()));
    servers.splice(servers.indexOf(dead), 1);
    upstreamPorts.set(7000, deadPort);

    let state: MicrovmState = 'running';
    const calls: string[] = [];
    target = {
      microvmId: 'mvm-test',
      calls,
      setState: (s) => (state = s),
      state: () => state,
      upstreamFor: (p) => {
        const port = upstreamPorts.get(p);
        return port === undefined ? undefined : { host: '127.0.0.1', port };
      },
      routablePorts: () => [...upstreamPorts.keys()],
      suspend: async () => {
        calls.push('suspend');
        if (state !== 'running') throw new MicrovmStateError('not running');
        state = 'suspended';
      },
      resume: async () => {
        calls.push('resume');
        if (state !== 'suspended') throw new MicrovmStateError('not suspended');
        state = 'running';
      },
      terminate: async () => {
        calls.push('terminate');
        state = 'terminated';
      },
    };
  });

  afterEach(async () => {
    await fd?.close();
    fd = undefined;
    for (const s of servers.splice(0)) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  const start = async (autoResume = false) =>
    (fd = await startMicrovmFrontDoor({ host: '127.0.0.1', port: 0, target, autoResume }));

  const send = (
    path: string,
    opts: { method?: string; headers?: Record<string, string> } = {}
  ): Promise<{ status: number; body: string }> =>
    new Promise((resolveSend, rejectSend) => {
      const req = request(
        { host: '127.0.0.1', port: fd!.port, path, method: opts.method ?? 'GET', headers: opts.headers },
        (res) => {
          let body = '';
          res.on('data', (c: Buffer) => (body += c.toString()));
          res.on('end', () => resolveSend({ status: res.statusCode ?? 0, body }));
        }
      );
      req.on('error', rejectSend);
      req.end();
    });

  it('forwards to 8080 by default and to the X-aws-proxy-port, stripping the proxy headers', async () => {
    await start();
    expect(await send('/a?x=1', { headers: { 'x-aws-proxy-auth': 'jwe', 'x-keep': 'y' } })).toEqual({
      status: 200,
      body: 'from 8080',
    });
    expect(await send('/b', { headers: { 'X-aws-proxy-port': '9000' } })).toEqual({
      status: 200,
      body: 'from 9000',
    });
    expect(seen.map((s) => [s.port, s.url])).toEqual([
      [8080, '/a?x=1'],
      [9000, '/b'],
    ]);
    for (const s of seen) {
      expect(Object.keys(s.headers).filter((h) => h.startsWith('x-aws-proxy-'))).toEqual([]);
    }
    expect(seen[0]!.headers['x-keep']).toBe('y');
  });

  it('answers 400 for an invalid port, 403 for an unpublished one, 502 when nothing listens', async () => {
    await start();
    expect((await send('/', { headers: { 'x-aws-proxy-port': 'abc' } })).status).toBe(400);
    const forbidden = await send('/', { headers: { 'x-aws-proxy-port': '9100' } });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toMatch(/Port 9100 of MicroVM mvm-test is not reachable locally.*--proxy-port; published: 8080, 9000, 7000/);
    const bad = await send('/', { headers: { 'x-aws-proxy-port': '7000' } });
    expect(bad.status).toBe(502);
    expect(bad.body).toMatch(/not responding on port 7000/);
    expect(seen).toEqual([]);
  });

  it('answers 503 while suspended, and the control endpoint suspends / resumes / reports', async () => {
    await start();
    expect(JSON.parse((await send('/_cdkl/microvm')).body)).toEqual({
      microvmId: 'mvm-test',
      state: 'running',
      ports: [8080, 9000, 7000],
    });
    expect(await send('/_cdkl/microvm/suspend', { method: 'POST' })).toEqual({
      status: 200,
      body: JSON.stringify({ microvmId: 'mvm-test', state: 'suspended' }),
    });
    const blocked = await send('/');
    expect(blocked.status).toBe(503);
    expect(blocked.body).toMatch(/is suspended\. Resume it with POST \/_cdkl\/microvm\/resume/);
    expect(seen).toEqual([]);
    expect((await send('/_cdkl/microvm/resume', { method: 'POST' })).status).toBe(200);
    expect((await send('/')).body).toBe('from 8080');
    expect(target.calls).toEqual(['suspend', 'resume']);
  });

  it('answers 409 for an action the state forbids, 405 for a wrong method, 404 for an unknown action', async () => {
    await start();
    const conflict = await send('/_cdkl/microvm/resume', { method: 'POST' });
    expect(conflict.status).toBe(409);
    expect((await send('/_cdkl/microvm/suspend')).status).toBe(405);
    expect((await send('/_cdkl/microvm/reboot', { method: 'POST' })).status).toBe(404);
    expect(target.calls).toEqual(['resume']);
  });

  it('terminate answers before the MicroVM is gone, and later requests get 503', async () => {
    await start();
    expect(await send('/_cdkl/microvm/terminate', { method: 'POST' })).toEqual({
      status: 200,
      body: JSON.stringify({ microvmId: 'mvm-test', state: 'terminated' }),
    });
    const after = await send('/');
    expect(after.status).toBe(503);
    expect(after.body).toMatch(/is terminated/);
  });

  it('--auto-resume holds a request to a suspended MicroVM until it is resumed', async () => {
    await start(true);
    target.setState('suspended');
    expect(await send('/held')).toEqual({ status: 200, body: 'from 8080' });
    expect(target.calls).toEqual(['resume']);
  });

  it('bridges a WebSocket upgrade to the subprotocol port, stripping MicroVM protocols', async () => {
    await start();
    const raw = await new Promise<string>((resolveWs) => {
      const sock = connect(fd!.port, '127.0.0.1', () => {
        sock.write(
          [
            'GET /ws HTTP/1.1',
            'Host: x',
            'Upgrade: websocket',
            'Connection: Upgrade',
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
            'Sec-WebSocket-Version: 13',
            'Sec-WebSocket-Protocol: lambda-microvms, lambda-microvms.authentication.tok, lambda-microvms.port.9000',
            'X-aws-proxy-auth: jwe',
            '',
            '',
          ].join('\r\n')
        );
      });
      let out = '';
      sock.on('data', (c: Buffer) => (out += c.toString('latin1')));
      sock.on('close', () => resolveWs(out));
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.port).toBe(9000);
    expect(seen[0]!.headers['sec-websocket-protocol']).toBeUndefined();
    expect(seen[0]!.headers['x-aws-proxy-auth']).toBeUndefined();
    expect(seen[0]!.headers['upgrade']).toBe('websocket');
    expect(raw).toMatch(/^HTTP\/1\.1 101 Switching Protocols\r\n/);
    expect(raw).toContain('\r\nSec-WebSocket-Protocol: lambda-microvms\r\n\r\nFRAME');
  });

  it('refuses an upgrade to an unpublished port with 403', async () => {
    await start();
    const raw = await new Promise<string>((resolveWs) => {
      const sock = connect(fd!.port, '127.0.0.1', () => {
        sock.write(
          'GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            'Sec-WebSocket-Protocol: lambda-microvms.port.9999\r\n\r\n'
        );
      });
      let out = '';
      sock.on('data', (c: Buffer) => (out += c.toString()));
      sock.on('close', () => resolveWs(out));
    });
    expect(raw).toMatch(/^HTTP\/1\.1 403 Forbidden/);
    expect(seen).toEqual([]);
  });
});
