import { WebSocket, type RawData } from 'ws';
import { AGENTCORE_SESSION_ID_HEADER } from './agentcore-client.js';

/**
 * WebSocket client for the Bedrock AgentCore Runtime HTTP-protocol `/ws`
 * endpoint (bidirectional streaming, on the same 8080 container as
 * `POST /invocations` + `GET /ping`).
 *
 * Connect to `ws://host:8080/ws`, send the `--event` as the first frame, and
 * stream every received frame to the sink. When a {@link
 * InvokeAgentCoreWsOptions.frameSource} is supplied (the auto-detected TTY
 * REPL path), additional frames from that async iterable are sent after the
 * initial event, and the client closes the stream when the iterable is
 * exhausted (or when the server closes first — whichever happens first). The
 * wire framing over `/ws` is agent-defined (AWS pipes bytes transparently),
 * so this mirrors that — it does not interpret the frames. The AgentCore
 * session id is sent on the upgrade as {@link AGENTCORE_SESSION_ID_HEADER},
 * the way the cloud front door does.
 */

const WS_PATH = '/ws';

export interface InvokeAgentCoreWsOptions {
  /** Value for the {@link AGENTCORE_SESSION_ID_HEADER} upgrade header. */
  sessionId: string;
  /** Sink for each received text frame, in arrival order. */
  onMessage: (text: string) => void;
  /** Abort the whole exchange (connect + stream) after this many ms. */
  timeoutMs: number;
  /**
   * `Authorization: Bearer <jwt>` to send on the upgrade when the runtime
   * declares a `customJwtAuthorizer` — forwarded the way the HTTP path
   * forwards it to `/invocations`, so an agent that reads the header behaves
   * as in the cloud.
   */
  authorization?: string;
  /**
   * Optional async iterable of additional text frames to send after the
   * initial `event`. The auto-detected TTY REPL path wires
   * `process.stdin` (line-buffered) here — each yielded string becomes one
   * text frame. The connection is closed gracefully when the iterable is
   * exhausted; if the server closes first, iteration is stopped via the
   * iterator's `return()` method. Errors thrown by the iterable propagate as
   * the function's rejection.
   */
  frameSource?: AsyncIterable<string>;
  /**
   * Issue #255 — optional `AbortSignal` the caller fires when an external
   * event (e.g. `--watch` reload) needs to tear down the WS exchange
   * before the agent closes it. On abort the client closes the WebSocket
   * cleanly + resolves the promise with the current frame count (NOT a
   * reject), mirroring the agent-close path so the `--watch` reload loop
   * can re-open against the rebuilt container without needing a separate
   * "was this a graceful abort?" branch. Pre-fired signals are honored
   * before `open` (the WS is closed immediately after construction).
   */
  abortSignal?: AbortSignal;
  /** Injected WebSocket implementation for tests. Defaults to `ws`. */
  webSocketImpl?: typeof WebSocket;
}

export interface AgentCoreWsResult {
  /** Number of frames streamed from the agent before it closed. */
  frames: number;
}

/**
 * Decode a `ws` {@link RawData} frame to UTF-8 text. `ws` delivers a Buffer by
 * default (binaryType 'nodebuffer'); handle the fragments / ArrayBuffer shapes
 * too so a frame is always decoded the same way regardless of source.
 */
function decodeWsFrame(data: RawData): string {
  const buf = Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data);
  return buf.toString('utf-8');
}

export interface BridgeAgentCoreWsOptions {
  /** Value for the {@link AGENTCORE_SESSION_ID_HEADER} upgrade header. */
  sessionId: string;
  /**
   * `Authorization: Bearer <jwt>` to send on the upgrade when the runtime
   * declares a `customJwtAuthorizer`, forwarded the way the HTTP path forwards
   * it to `/invocations`.
   */
  authorization?: string;
  /** Sink for each received text frame, in arrival order (container -> caller). */
  onMessage: (text: string) => void;
  /** Fired once the upgrade completes and buffered frames have been flushed. */
  onOpen?: () => void;
  /** Fired when the container `/ws` socket closes (carries the close code). */
  onClose?: (code?: number) => void;
  /** Fired on a connection / send error. */
  onError?: (err: Error) => void;
  /** Optional `AbortSignal`; firing it closes the WS cleanly. */
  abortSignal?: AbortSignal;
  /** Injected WebSocket implementation for tests. Defaults to `ws`. */
  webSocketImpl?: typeof WebSocket;
}

/**
 * A live, caller-driven bridge to the container `/ws` endpoint. Unlike {@link
 * invokeAgentCoreWs} (a fire-and-await-close promise that sends the `--event`
 * as the first frame), this opens the socket and sends NOTHING on its own — the
 * caller drives every frame via {@link AgentCoreWsBridgeHandle.send}. It is the
 * relay primitive behind `cdkl start-agentcore`: a browser (which cannot set
 * the session-id / Authorization upgrade headers) connects to a host bridge
 * server, and the bridge forwards its frames here with the headers injected.
 */
export interface AgentCoreWsBridgeHandle {
  /**
   * Forward a text frame to the container. Frames sent before the upgrade
   * completes are buffered and flushed in order on `open`.
   */
  send: (text: string) => void;
  /** Close the container `/ws` socket. Idempotent. */
  close: () => void;
}

/**
 * Open `ws://host:port/ws` with the AgentCore session-id (+ optional
 * `Authorization`) upgrade header and return a handle for bidirectional
 * frame relay. Sends NO initial frame — the caller drives every frame. Each
 * received frame is decoded to UTF-8 and passed to {@link
 * BridgeAgentCoreWsOptions.onMessage}.
 */
export function bridgeAgentCoreWs(
  host: string,
  port: number,
  options: BridgeAgentCoreWsOptions
): AgentCoreWsBridgeHandle {
  const Impl = options.webSocketImpl ?? WebSocket;
  const url = `ws://${host}:${port}${WS_PATH}`;
  const ws = new Impl(url, {
    headers: {
      [AGENTCORE_SESSION_ID_HEADER]: options.sessionId,
      ...(options.authorization && { Authorization: options.authorization }),
    },
  });

  let open = false;
  let closed = false;
  const pending: string[] = [];

  const close = (): void => {
    if (closed) return;
    closed = true;
    options.abortSignal?.removeEventListener('abort', close);
    try {
      ws.close();
    } catch {
      /* already closing */
    }
  };

  if (options.abortSignal) {
    if (options.abortSignal.aborted) {
      close();
    } else {
      options.abortSignal.addEventListener('abort', close, { once: true });
    }
  }

  const sendFrame = (text: string): void => {
    try {
      ws.send(text);
    } catch (err) {
      options.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  };

  ws.on('open', () => {
    open = true;
    // A close() that raced the upgrade: honor it now that the socket is open.
    if (closed) {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      return;
    }
    options.onOpen?.();
    for (const frame of pending.splice(0)) sendFrame(frame);
  });
  ws.on('message', (data: RawData) => options.onMessage(decodeWsFrame(data)));
  ws.on('close', (code?: number) => {
    closed = true;
    // The container closing first (the common case — the agent ends the
    // stream) must also detach the abort listener so a long-lived signal
    // (e.g. a future --watch reload controller) does not retain this handle.
    options.abortSignal?.removeEventListener('abort', close);
    options.onClose?.(code);
  });
  ws.on('error', (err: Error) => options.onError?.(err));

  return {
    send: (text: string): void => {
      // Post-close sends are intentionally dropped silently: the bridge
      // server's browser `message` can fire between the container `close` and
      // the browser-close propagation, and those frames have nowhere to go.
      if (closed) return;
      if (!open) {
        pending.push(text);
        return;
      }
      sendFrame(text);
    },
    close,
  };
}

/**
 * Open `/ws`, send the event as the first frame, stream received frames to
 * `onMessage`, and resolve when the server closes. Rejects on a connection
 * error or when `timeoutMs` elapses before the server closes.
 */
export async function invokeAgentCoreWs(
  host: string,
  port: number,
  event: unknown,
  options: InvokeAgentCoreWsOptions
): Promise<AgentCoreWsResult> {
  const Impl = options.webSocketImpl ?? WebSocket;
  const url = `ws://${host}:${port}${WS_PATH}`;
  const body = JSON.stringify(event ?? {});

  return new Promise<AgentCoreWsResult>((resolve, reject) => {
    const ws = new Impl(url, {
      headers: {
        [AGENTCORE_SESSION_ID_HEADER]: options.sessionId,
        ...(options.authorization && { Authorization: options.authorization }),
      },
    });
    let frames = 0;
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        stopIterator();
        try {
          ws.terminate();
        } catch {
          /* already closing */
        }
        reject(
          new Error(
            `AgentCore /ws at ${url} timed out after ${options.timeoutMs}ms. ` +
              `The agent may be hung or may not close the stream; check container logs.`
          )
        );
      });
    }, options.timeoutMs);

    // Issue #255 — abort path. The signal is fired by the `--watch` reload
    // loop when a source change needs the running container torn down.
    // Resolve (don't reject) so the loop can re-open against the rebuilt
    // container without needing a "graceful abort?" branch.
    const onAbort = (): void => {
      finish(() => {
        stopIterator();
        try {
          ws.close();
        } catch {
          /* already closing */
        }
        resolve({ frames });
      });
    };
    if (options.abortSignal) {
      if (options.abortSignal.aborted) {
        onAbort();
      } else {
        options.abortSignal.addEventListener('abort', onAbort, { once: true });
      }
    }

    let iterator: AsyncIterator<string> | undefined;
    const stopIterator = (): void => {
      if (iterator?.return) {
        try {
          // Fire-and-forget: a return() that rejects is fine, we are tearing down.
          void iterator.return();
        } catch {
          /* iterator already exhausted */
        }
      }
      iterator = undefined;
    };

    ws.on('open', () => {
      ws.send(body);
      if (!options.frameSource) return;
      // Kick off the additional-frames pump in the background. Each yielded
      // string becomes one text frame; when the iterable is exhausted we close
      // the WS gracefully so the agent sees a clean close.
      void (async (): Promise<void> => {
        try {
          iterator = options.frameSource![Symbol.asyncIterator]();
          while (!settled) {
            const next = await iterator.next();
            if (settled || next.done) break;
            // `ws.send` is async via the OS socket buffer; the callback is the
            // only way to surface a queue write error before the next iteration.
            await new Promise<void>((res, rej) => {
              ws.send(next.value, (err) => (err ? rej(err) : res()));
            });
          }
          if (!settled) ws.close();
        } catch (err) {
          finish(() => {
            try {
              ws.terminate();
            } catch {
              /* already closing */
            }
            reject(err instanceof Error ? err : new Error(String(err)));
          });
        }
      })();
    });
    ws.on('message', (data: RawData) => {
      frames += 1;
      // `ws` delivers a Buffer by default (binaryType 'nodebuffer'); handle the
      // fragments / ArrayBuffer shapes too so a frame is always decoded as UTF-8.
      const buf = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      options.onMessage(buf.toString('utf-8'));
    });
    ws.on('close', () => {
      finish(() => {
        stopIterator();
        resolve({ frames });
      });
    });
    ws.on('error', (err: Error) => {
      finish(() => {
        stopIterator();
        reject(err);
      });
    });
  });
}
