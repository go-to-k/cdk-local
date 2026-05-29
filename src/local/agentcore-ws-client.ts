import { WebSocket } from 'ws';
import { AGENTCORE_SESSION_ID_HEADER } from './agentcore-client.js';

/**
 * WebSocket client for the Bedrock AgentCore Runtime HTTP-protocol `/ws`
 * endpoint (bidirectional streaming, on the same 8080 container as
 * `POST /invocations` + `GET /ping`).
 *
 * v1 is a one-shot send-and-stream transparent pipe: connect to
 * `ws://host:8080/ws`, send the `--event` as the first frame, then stream every
 * received frame to the sink until the server closes the connection. The wire
 * framing over `/ws` is agent-defined (AWS pipes bytes transparently), so this
 * mirrors that — it does not interpret the frames. The AgentCore session id is
 * sent on the upgrade as {@link AGENTCORE_SESSION_ID_HEADER}, the way the cloud
 * front door does. An interactive stdin<->ws loop is a follow-up.
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

    ws.on('open', () => {
      ws.send(body);
    });
    ws.on('message', (data: unknown) => {
      frames += 1;
      options.onMessage(typeof data === 'string' ? data : String(data));
    });
    ws.on('close', () => {
      finish(() => resolve({ frames }));
    });
    ws.on('error', (err: Error) => {
      finish(() => reject(err));
    });
  });
}
