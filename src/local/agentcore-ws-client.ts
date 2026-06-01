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
