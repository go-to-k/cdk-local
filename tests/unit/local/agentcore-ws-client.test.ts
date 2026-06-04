import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { WebSocketServer, type WebSocket } from 'ws';
import { invokeAgentCoreWs, bridgeAgentCoreWs } from '../../../src/local/agentcore-ws-client.js';
import { AGENTCORE_SESSION_ID_HEADER } from '../../../src/local/agentcore-client.js';

/**
 * These tests drive the real `ws` client against a real in-process
 * `WebSocketServer` on an ephemeral port — no mocking of the transport, so the
 * upgrade headers + framing behavior are exercised end to end.
 */

let servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  );
  servers = [];
});

interface StartedServer {
  port: number;
  /** Upgrade headers seen on the most recent connection. */
  lastHeaders: () => Record<string, string | string[] | undefined>;
}

/** Start a `/ws` server; `onConn` decides how the server replies/closes. */
async function startServer(
  onConn: (ws: WebSocket, firstFrame: string) => void
): Promise<StartedServer> {
  const wss = new WebSocketServer({ port: 0, path: '/ws' });
  servers.push(wss);
  let headers: Record<string, string | string[] | undefined> = {};
  wss.on('connection', (ws, req) => {
    headers = req.headers;
    ws.once('message', (data) => onConn(ws, data.toString()));
  });
  await new Promise<void>((resolve) => wss.on('listening', () => resolve()));
  const port = (wss.address() as AddressInfo).port;
  return { port, lastHeaders: () => headers };
}

/**
 * Variant of {@link startServer} that handles EVERY received frame (not just
 * the first). Used by the `frameSource` REPL-loop tests where the client sends
 * multiple frames and the server echoes each.
 */
async function startMultiFrameServer(
  onFrame: (ws: WebSocket, frame: string, index: number) => void
): Promise<StartedServer> {
  const wss = new WebSocketServer({ port: 0, path: '/ws' });
  servers.push(wss);
  let headers: Record<string, string | string[] | undefined> = {};
  wss.on('connection', (ws, req) => {
    headers = req.headers;
    let index = 0;
    ws.on('message', (data) => {
      onFrame(ws, data.toString(), index);
      index += 1;
    });
  });
  await new Promise<void>((resolve) => wss.on('listening', () => resolve()));
  const port = (wss.address() as AddressInfo).port;
  return { port, lastHeaders: () => headers };
}

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

describe('invokeAgentCoreWs', () => {
  it('sends the event as the first frame, streams received frames, and resolves with the frame count', async () => {
    const server = await startServer((ws, firstFrame) => {
      // Echo the event back, emit two more frames, then close.
      ws.send(`echo:${firstFrame}`);
      ws.send('frame-2');
      ws.send('frame-3');
      ws.close();
    });

    const received: string[] = [];
    const result = await invokeAgentCoreWs('127.0.0.1', server.port, { prompt: 'hi' }, {
      sessionId: 'sess-abc',
      timeoutMs: 5000,
      onMessage: (t) => received.push(t),
    });

    expect(received).toEqual(['echo:{"prompt":"hi"}', 'frame-2', 'frame-3']);
    expect(result.frames).toBe(3);
  });

  it('sends an empty-object first frame when the event is nullish', async () => {
    let firstFrame = '';
    const server = await startServer((ws, frame) => {
      firstFrame = frame;
      ws.close();
    });

    await invokeAgentCoreWs('127.0.0.1', server.port, undefined, {
      sessionId: 's',
      timeoutMs: 5000,
      onMessage: () => {},
    });

    expect(firstFrame).toBe('{}');
  });

  it('sends the AgentCore session-id header on the upgrade', async () => {
    const server = await startServer((ws) => ws.close());

    await invokeAgentCoreWs('127.0.0.1', server.port, {}, {
      sessionId: 'session-xyz',
      timeoutMs: 5000,
      onMessage: () => {},
    });

    expect(server.lastHeaders()[AGENTCORE_SESSION_ID_HEADER.toLowerCase()]).toBe('session-xyz');
  });

  it('forwards the Authorization header when supplied', async () => {
    const server = await startServer((ws) => ws.close());

    await invokeAgentCoreWs('127.0.0.1', server.port, {}, {
      sessionId: 's',
      timeoutMs: 5000,
      onMessage: () => {},
      authorization: 'Bearer the.jwt.token',
    });

    expect(server.lastHeaders()['authorization']).toBe('Bearer the.jwt.token');
  });

  it('omits the Authorization header when not supplied', async () => {
    const server = await startServer((ws) => ws.close());

    await invokeAgentCoreWs('127.0.0.1', server.port, {}, {
      sessionId: 's',
      timeoutMs: 5000,
      onMessage: () => {},
    });

    expect(server.lastHeaders()['authorization']).toBeUndefined();
  });

  it('rejects on a connection error (nothing listening)', async () => {
    // Port 1 is privileged + unbound in the test sandbox → ECONNREFUSED.
    await expect(
      invokeAgentCoreWs('127.0.0.1', 1, {}, {
        sessionId: 's',
        timeoutMs: 5000,
        onMessage: () => {},
      })
    ).rejects.toThrow();
  });

  it('rejects with a timeout error when the server never closes the stream', async () => {
    // Server accepts + sends one frame but never closes → the client must abort
    // on timeoutMs.
    const server = await startServer((ws) => {
      ws.send('one');
      // intentionally no close()
    });

    await expect(
      invokeAgentCoreWs('127.0.0.1', server.port, {}, {
        sessionId: 's',
        timeoutMs: 150,
        onMessage: () => {},
      })
    ).rejects.toThrow(/timed out after 150ms/);
  });

  describe('frameSource (interactive REPL)', () => {
    it('sends each yielded string as a follow-up text frame and gracefully closes when the iterable is exhausted', async () => {
      const received: string[] = [];
      const server = await startMultiFrameServer((ws, frame) => {
        received.push(frame);
        ws.send(`ack:${frame}`);
      });

      const fromClient: string[] = [];
      const result = await invokeAgentCoreWs(
        '127.0.0.1',
        server.port,
        { hello: true },
        {
          sessionId: 's',
          timeoutMs: 5000,
          onMessage: (t) => fromClient.push(t),
          frameSource: fromArray(['line-1', 'line-2', 'line-3']),
        }
      );

      // Server saw the initial event + 3 follow-up frames.
      expect(received).toEqual(['{"hello":true}', 'line-1', 'line-2', 'line-3']);
      // Client received an ack for each.
      expect(fromClient).toEqual([
        'ack:{"hello":true}',
        'ack:line-1',
        'ack:line-2',
        'ack:line-3',
      ]);
      expect(result.frames).toBe(4);
    });

    it('stops iterating the frameSource when the server closes first', async () => {
      // Server sends one ack then closes — the client iterator should be
      // released via its return() so a real stdin readline tears down.
      const server = await startMultiFrameServer((ws, frame, index) => {
        ws.send(`ack:${frame}`);
        if (index === 0) ws.close();
      });

      let yielded = 0;
      let returnedEarly = false;
      const iterable: AsyncIterable<string> = {
        async *[Symbol.asyncIterator](): AsyncIterator<string> {
          try {
            while (true) {
              yielded += 1;
              yield `frame-${yielded}`;
              // Slow the iteration so the server's close lands before we
              // produce the next frame.
              await new Promise((r) => setTimeout(r, 50));
            }
          } finally {
            returnedEarly = true;
          }
        },
      };

      const result = await invokeAgentCoreWs(
        '127.0.0.1',
        server.port,
        { hi: true },
        {
          sessionId: 's',
          timeoutMs: 5000,
          onMessage: () => {},
          frameSource: iterable,
        }
      );

      expect(result.frames).toBeGreaterThan(0);
      // The async generator is suspended in `await setTimeout(50)` when the
      // server closes; iterator.return() unblocks it on the next tick, which
      // runs the `finally`. Wait briefly past the pending setTimeout.
      await new Promise((r) => setTimeout(r, 100));
      // The iterator's finally ran — it was torn down on server close.
      expect(returnedEarly).toBe(true);
    });

    it('propagates an error thrown by the frameSource as the function rejection', async () => {
      const server = await startMultiFrameServer((ws, frame) => {
        ws.send(`ack:${frame}`);
      });

      const iterable: AsyncIterable<string> = {
        async *[Symbol.asyncIterator](): AsyncIterator<string> {
          yield 'first';
          throw new Error('boom from frame source');
        },
      };

      await expect(
        invokeAgentCoreWs('127.0.0.1', server.port, {}, {
          sessionId: 's',
          timeoutMs: 5000,
          onMessage: () => {},
          frameSource: iterable,
        })
      ).rejects.toThrow(/boom from frame source/);
    });
  });
});

/**
 * `bridgeAgentCoreWs` is the caller-driven relay primitive behind
 * `cdkl start-agentcore`. Unlike {@link invokeAgentCoreWs} it sends NO initial
 * frame — every frame is driven by the caller via the handle. Tested against a
 * real in-process `ws` server (the container stand-in) so the upgrade headers +
 * framing are exercised end to end.
 */
describe('bridgeAgentCoreWs', () => {
  let liveHandles: Array<{ close: () => void }> = [];
  afterEach(() => {
    for (const h of liveHandles) {
      try {
        h.close();
      } catch {
        /* ignore */
      }
    }
    liveHandles = [];
  });
  const track = <T extends { close: () => void }>(h: T): T => {
    liveHandles.push(h);
    return h;
  };

  /** Start a server that records every frame it receives + the upgrade headers. */
  async function startRecordingServer(
    onConn?: (ws: WebSocket) => void
  ): Promise<{
    port: number;
    received: string[];
    lastHeaders: () => Record<string, string | string[] | undefined>;
    sendToClient: (text: string) => void;
    closeClient: () => void;
  }> {
    const wss = new WebSocketServer({ port: 0, path: '/ws' });
    servers.push(wss);
    const received: string[] = [];
    let headers: Record<string, string | string[] | undefined> = {};
    let live: WebSocket | undefined;
    wss.on('connection', (ws, req) => {
      headers = req.headers;
      live = ws;
      ws.on('message', (data) => received.push(data.toString()));
      onConn?.(ws);
    });
    await new Promise<void>((resolve) => wss.on('listening', () => resolve()));
    const port = (wss.address() as AddressInfo).port;
    return {
      port,
      received,
      lastHeaders: () => headers,
      sendToClient: (text) => live?.send(text),
      closeClient: () => live?.close(),
    };
  }

  const tick = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it('does NOT auto-send any initial frame on open', async () => {
    const server = await startRecordingServer();
    const opened = new Promise<void>((resolve) => {
      track(
        bridgeAgentCoreWs('127.0.0.1', server.port, {
          sessionId: 's1',
          onMessage: () => {},
          onOpen: () => resolve(),
        })
      );
    });
    await opened;
    await tick();
    expect(server.received).toEqual([]);
  });

  it('sets the session-id (+ Authorization) on the upgrade and forwards a frame to the container', async () => {
    const server = await startRecordingServer();
    const handle = track(
      bridgeAgentCoreWs('127.0.0.1', server.port, {
        sessionId: 'sess-42',
        authorization: 'Bearer tok',
        onMessage: () => {},
      })
    );
    // Sent before open — must be buffered and flushed in order on open.
    handle.send('first');
    handle.send('second');
    await tick(120);
    // Node lowercases incoming header names.
    expect(server.lastHeaders()[AGENTCORE_SESSION_ID_HEADER.toLowerCase()]).toBe('sess-42');
    expect(server.lastHeaders()['authorization']).toBe('Bearer tok');
    expect(server.received).toEqual(['first', 'second']);
    handle.close();
  });

  it('forwards each container frame to onMessage', async () => {
    const frames: string[] = [];
    const server = await startRecordingServer((ws) => {
      ws.send('from-container-1');
      ws.send('from-container-2');
    });
    await new Promise<void>((resolve) => {
      let n = 0;
      track(
        bridgeAgentCoreWs('127.0.0.1', server.port, {
          sessionId: 's',
          onMessage: (t) => {
            frames.push(t);
            if (++n === 2) resolve();
          },
        })
      );
    });
    expect(frames).toEqual(['from-container-1', 'from-container-2']);
  });

  it('fires onClose when the container closes the socket', async () => {
    const server = await startRecordingServer((ws) => ws.close());
    const closed = await new Promise<boolean>((resolve) => {
      track(
        bridgeAgentCoreWs('127.0.0.1', server.port, {
          sessionId: 's',
          onMessage: () => {},
          onClose: () => resolve(true),
        })
      );
    });
    expect(closed).toBe(true);
  });

  it('close() tears the container socket down (onClose fires, later sends are dropped)', async () => {
    const server = await startRecordingServer();
    const events: string[] = [];
    const handle = track(
      bridgeAgentCoreWs('127.0.0.1', server.port, {
        sessionId: 's',
        onMessage: () => {},
        onOpen: () => events.push('open'),
        onClose: () => events.push('close'),
      })
    );
    await tick(80);
    handle.close();
    await tick(80);
    handle.send('after-close'); // dropped — must not reach the server
    await tick(60);
    expect(events).toEqual(['open', 'close']);
    expect(server.received).toEqual([]);
  });

  it('fires onError when the container connection cannot be established', async () => {
    // Point at a port with no listener — the `ws` connect fails, surfacing
    // onError (the failure path the bridge server turns into a browser notice).
    const err = await new Promise<Error>((resolve) => {
      track(
        bridgeAgentCoreWs('127.0.0.1', 1, {
          sessionId: 's',
          onMessage: () => {},
          onError: (e) => resolve(e),
        })
      );
    });
    expect(err).toBeInstanceOf(Error);
  });

  it('closes cleanly when a pre-fired abort signal is supplied', async () => {
    const server = await startRecordingServer();
    const controller = new AbortController();
    controller.abort();
    const handle = track(
      bridgeAgentCoreWs('127.0.0.1', server.port, {
        sessionId: 's',
        onMessage: () => {},
        abortSignal: controller.signal,
      })
    );
    await tick(80);
    handle.send('never'); // closed already → dropped
    await tick(60);
    expect(server.received).toEqual([]);
  });
});
