import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect as netConnect } from 'node:net';
import type { Duplex } from 'node:stream';
import { getLogger } from '../utils/logger.js';
import { stripHopByHopHeaders, writeRawHttpError } from './front-door-server.js';
import { MICROVM_DEFAULT_INGRESS_PORT } from './microvm-image.js';
import type { HookEndpoint } from './microvm-hooks.js';

/** The reserved path prefix of a MicroVM front door's local control endpoint. */
export const MICROVM_CONTROL_PATH = '/_cdkl/microvm';

/** The header that picks the container port a request is forwarded to. */
export const PROXY_PORT_HEADER = 'x-aws-proxy-port';

/** The WebSocket subprotocol every MicroVM WebSocket client offers. */
export const MICROVM_WS_BASE_PROTOCOL = 'lambda-microvms';

/** A MicroVM's lifecycle state, as its front door sees it. */
export type MicrovmState =
  | 'running'
  | 'suspending'
  | 'suspended'
  | 'resuming'
  | 'terminating'
  | 'terminated';

/** What a front door needs from the MicroVM it fronts. */
export interface MicrovmProxyTarget {
  readonly microvmId: string;
  state(): MicrovmState;
  /** The host endpoint a container port is published on, or `undefined` when it is not. */
  upstreamFor(containerPort: number): HookEndpoint | undefined;
  /** The container ports that are published (for the 403 message and the status body). */
  routablePorts(): number[];
  suspend(): Promise<void>;
  resume(): Promise<void>;
  terminate(): Promise<void>;
}

/** Options for {@link startMicrovmFrontDoor}. */
export interface MicrovmFrontDoorOptions {
  host: string;
  /** `0` lets the OS pick. */
  port: number;
  target: MicrovmProxyTarget;
  /** Resume a suspended MicroVM on an inbound request (the idle policy's `autoResumeEnabled`). */
  autoResume: boolean;
}

export interface RunningMicrovmFrontDoor {
  /** The bound port. */
  port: number;
  close(): Promise<void>;
}

/** The outcome of reading a request's target port. */
export type PortSelection =
  | { ok: true; port: number }
  | { ok: false; status: 400; message: string };

/**
 * The container port a request targets, in the order the cloud's endpoint
 * applies: the `X-aws-proxy-port` header, else a WebSocket's
 * `lambda-microvms.port.N` subprotocol, else 8080. A value that is not an
 * integer 1-65535 is a 400, as the cloud's endpoint answers.
 */
export function selectTargetPort(headers: IncomingMessage['headers']): PortSelection {
  const fromHeader = firstHeader(headers[PROXY_PORT_HEADER]);
  const fromProtocol =
    fromHeader === undefined
      ? subprotocols(headers).find((p) => p.startsWith(`${MICROVM_WS_BASE_PROTOCOL}.port.`))
      : undefined;
  const raw =
    fromHeader ??
    (fromProtocol !== undefined
      ? fromProtocol.slice(`${MICROVM_WS_BASE_PROTOCOL}.port.`.length)
      : undefined);
  if (raw === undefined) return { ok: true, port: MICROVM_DEFAULT_INGRESS_PORT };
  const trimmed = raw.trim();
  const n = /^\d{1,5}$/.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    const source =
      fromHeader === undefined ? 'WebSocket subprotocol lambda-microvms.port.' : 'X-aws-proxy-port';
    return {
      ok: false,
      status: 400,
      message: `Invalid ${source} value '${trimmed.slice(0, 32)}': it must be a port number 1-65535.`,
    };
  }
  return { ok: true, port: n };
}

/**
 * Remove what the cloud endpoint strips before a request reaches the app:
 * every `X-aws-proxy-*` header, and the MicroVM-specific WebSocket
 * subprotocols (`lambda-microvms`, `lambda-microvms.authentication.*`,
 * `lambda-microvms.port.*`). Any other subprotocol is kept. Mutates `headers`.
 * Returns whether the client offered the base `lambda-microvms` protocol.
 */
export function stripMicrovmProxyHeaders(headers: NodeJS.Dict<string | string[]>): boolean {
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase().startsWith('x-aws-proxy-')) delete headers[name];
  }
  const offered = subprotocols(headers as IncomingMessage['headers']);
  if (offered.length === 0) return false;
  const kept = offered.filter((p) => !isMicrovmProtocol(p));
  if (kept.length > 0) headers['sec-websocket-protocol'] = kept.join(', ');
  else delete headers['sec-websocket-protocol'];
  return offered.includes(MICROVM_WS_BASE_PROTOCOL);
}

function isMicrovmProtocol(p: string): boolean {
  return p === MICROVM_WS_BASE_PROTOCOL || p.startsWith(`${MICROVM_WS_BASE_PROTOCOL}.`);
}

function subprotocols(headers: IncomingMessage['headers']): string[] {
  const raw = headers['sec-websocket-protocol'];
  const joined = Array.isArray(raw) ? raw.join(',') : raw;
  if (!joined) return [];
  return joined
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  if (typeof value === 'string') return value.split(',')[0];
  return undefined;
}

/**
 * Serve ONE MicroVM's endpoint on a local port: route each request to the
 * container port it names, strip what the cloud strips, answer 400 / 403 / 502
 * as the cloud endpoint does, and expose the local control endpoint under
 * {@link MICROVM_CONTROL_PATH}:
 *
 * - `GET  /_cdkl/microvm`           — `{ microvmId, state, ports }`
 * - `POST /_cdkl/microvm/suspend`   — `/suspend` hook, then `docker pause`
 * - `POST /_cdkl/microvm/resume`    — `docker unpause`, then `/resume` hook
 * - `POST /_cdkl/microvm/terminate` — `/terminate` hook, then the container is removed
 *
 * A request reaching a suspending / suspended / resuming MicroVM gets 503
 * unless `autoResume` is set, in which case it is held while the MicroVM
 * resumes (every held request shares the one resume; 502 when it fails), as
 * the cloud's auto-resume does.
 *
 * The control path refuses (403) a request a browser page could send from
 * another origin: a `Sec-Fetch-Site` other than `same-origin` / `none`, an
 * `Origin` that is not this front door, or a `Host` that is not this front
 * door's own authority (DNS rebinding). Proxied app traffic is not checked.
 */
export function startMicrovmFrontDoor(
  opts: MicrovmFrontDoorOptions
): Promise<RunningMicrovmFrontDoor> {
  const logger = getLogger().child('microvm');
  const bound = { port: opts.port };
  const server: Server = createServer((req, res) => {
    void handleRequest(req, res, opts, bound.port).catch((err) => {
      logger.debug(`microvm front door error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent)
        writeText(res, 502, 'The MicroVM front door failed to forward the request.');
      else res.destroy();
    });
  });
  server.on('upgrade', (req, socket: Duplex, head: Buffer) => {
    void handleUpgrade(req, socket, head, opts).catch((err) => {
      logger.debug(`microvm upgrade error: ${err instanceof Error ? err.message : String(err)}`);
      writeRawHttpError(socket, 502, 'The MicroVM front door failed to forward the upgrade.');
    });
  });
  return new Promise((resolveStart, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(opts.port, opts.host, () => {
      server.off('error', rejectStart);
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : opts.port;
      bound.port = port;
      resolveStart({
        port,
        close: () =>
          new Promise<void>((resolveClose) => {
            // Graceful first, so a control response being written (the last
            // `/terminate`) still reaches its caller; then cut what is left.
            server.close(() => resolveClose());
            server.closeIdleConnections();
            setTimeout(() => server.closeAllConnections(), 1000).unref();
          }),
      });
    });
  });
}

/** Gate a request on the MicroVM's state; returns a refusal to send, or `undefined` to forward. */
async function admit(
  opts: MicrovmFrontDoorOptions
): Promise<{ status: number; message: string } | undefined> {
  const id = opts.target.microvmId;
  let state = opts.target.state();
  if (
    (state === 'suspended' || state === 'suspending' || state === 'resuming') &&
    opts.autoResume
  ) {
    try {
      await opts.target.resume();
    } catch (err) {
      return {
        status: 502,
        message: `MicroVM ${id} could not be resumed for this request: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    state = opts.target.state();
  }
  if (state === 'running') return undefined;
  if (state === 'terminating' || state === 'terminated') {
    return { status: 503, message: `MicroVM ${id} is ${state}.` };
  }
  return {
    status: 503,
    message:
      `MicroVM ${id} is ${state}. Resume it with POST ${MICROVM_CONTROL_PATH}/resume ` +
      `(or start with --auto-resume to resume on the first request).`,
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: MicrovmFrontDoorOptions,
  boundPort: number
): Promise<void> {
  const path = (req.url ?? '/').split('?')[0]!;
  if (path === MICROVM_CONTROL_PATH || path.startsWith(`${MICROVM_CONTROL_PATH}/`)) {
    const refusal = controlRequestRefusal(req.headers, opts.host, boundPort);
    if (refusal !== undefined) {
      req.resume();
      writeText(res, 403, refusal);
      return;
    }
    await handleControl(req, res, path, opts);
    return;
  }
  const selection = selectTargetPort(req.headers);
  if (!selection.ok) {
    req.resume();
    writeText(res, selection.status, selection.message);
    return;
  }
  const upstream = opts.target.upstreamFor(selection.port);
  if (!upstream) {
    req.resume();
    writeText(res, 403, notRoutableMessage(selection.port, opts.target));
    return;
  }
  const refusal = await admit(opts);
  if (refusal) {
    req.resume();
    writeText(res, refusal.status, refusal.message);
    return;
  }

  const headers: NodeJS.Dict<string | string[]> = { ...req.headers };
  stripHopByHopHeaders(headers);
  stripMicrovmProxyHeaders(headers);
  await new Promise<void>((resolveForward) => {
    const proxyReq = httpRequest(
      { host: upstream.host, port: upstream.port, method: req.method, path: req.url, headers },
      (proxyRes) => {
        const resHeaders = { ...proxyRes.headers };
        stripHopByHopHeaders(resHeaders);
        res.writeHead(proxyRes.statusCode ?? 502, resHeaders);
        proxyRes.pipe(res);
        proxyRes.on('end', resolveForward);
        proxyRes.on('error', () => {
          if (!res.writableEnded) res.destroy();
          resolveForward();
        });
      }
    );
    proxyReq.on('error', () => {
      if (!res.headersSent) {
        writeText(
          res,
          502,
          `The application in MicroVM ${opts.target.microvmId} is not responding on port ${selection.port}.`
        );
      } else if (!res.writableEnded) {
        res.destroy();
      }
      resolveForward();
    });
    res.on('close', () => {
      if (!res.writableEnded) proxyReq.destroy();
      resolveForward();
    });
    req.pipe(proxyReq);
  });
}

async function handleControl(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  opts: MicrovmFrontDoorOptions
): Promise<void> {
  req.resume();
  const target = opts.target;
  const action = path.slice(MICROVM_CONTROL_PATH.length).replace(/^\//, '');
  if (action === '') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      writeText(res, 405, `Use GET ${MICROVM_CONTROL_PATH}.`);
      return;
    }
    writeJson(res, 200, {
      microvmId: target.microvmId,
      state: target.state(),
      ports: target.routablePorts(),
    });
    return;
  }
  if (action !== 'suspend' && action !== 'resume' && action !== 'terminate') {
    writeText(
      res,
      404,
      `Unknown control action '${action.slice(0, 32)}'. Use POST ${MICROVM_CONTROL_PATH}/suspend, /resume or /terminate.`
    );
    return;
  }
  if (req.method !== 'POST') {
    writeText(res, 405, `Use POST ${MICROVM_CONTROL_PATH}/${action}.`);
    return;
  }
  try {
    await (action === 'suspend'
      ? target.suspend()
      : action === 'resume'
        ? target.resume()
        : target.terminate());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeText(res, err instanceof MicrovmStateError ? 409 : 502, message);
    return;
  }
  writeJson(res, 200, { microvmId: target.microvmId, state: target.state() });
}

const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '[::1]'];

function isWildcard(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === '[::]';
}

function isIpLiteral(name: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || /^\[[0-9a-f:.]+\]$/i.test(name);
}

/**
 * Why a control request must be refused, or `undefined` to serve it. Exported
 * for unit testing. Allowed `Host` names: the bound host, the loopback names
 * when bound to a loopback or wildcard address, and (wildcard bind only) any
 * IP literal — a DNS name pointing here is what DNS rebinding sends.
 */
export function controlRequestRefusal(
  headers: IncomingMessage['headers'],
  boundHost: string,
  boundPort: number
): string | undefined {
  const fetchSite = firstHeader(headers['sec-fetch-site'])?.trim().toLowerCase();
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return `Refusing a ${fetchSite} request to the MicroVM control endpoint: it accepts requests from this origin only (curl, or a page this front door served).`;
  }
  const host = (Array.isArray(headers.host) ? headers.host[0] : headers.host)?.trim().toLowerCase();
  const m = host === undefined ? null : /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(host);
  const name = m?.[1];
  const port = m ? Number(m[2]) : NaN;
  const bindName =
    boundHost.includes(':') && !boundHost.startsWith('[') ? `[${boundHost}]` : boundHost;
  const loopbackBind = isWildcard(boundHost) || LOOPBACK_NAMES.includes(bindName.toLowerCase());
  const nameOk =
    name !== undefined &&
    (name === bindName.toLowerCase() ||
      (loopbackBind && LOOPBACK_NAMES.includes(name)) ||
      (isWildcard(boundHost) && isIpLiteral(name)));
  if (!nameOk || port !== boundPort) {
    return `Refusing a MicroVM control request whose Host header (${(host ?? '<none>').slice(0, 64)}) is not this front door's address.`;
  }
  const origin = firstHeader(headers.origin)?.trim().toLowerCase();
  if (origin !== undefined && origin !== `http://${host}`) {
    return `Refusing a MicroVM control request from origin ${origin.slice(0, 64)}: it accepts requests from this origin only.`;
  }
  return undefined;
}

/** A control action the MicroVM's current state does not allow (answered 409). */
export class MicrovmStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MicrovmStateError';
    Object.setPrototypeOf(this, MicrovmStateError.prototype);
  }
}

async function handleUpgrade(
  req: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  opts: MicrovmFrontDoorOptions
): Promise<void> {
  const selection = selectTargetPort(req.headers);
  if (!selection.ok) {
    writeRawHttpError(clientSocket, selection.status, selection.message);
    return;
  }
  const upstream = opts.target.upstreamFor(selection.port);
  if (!upstream) {
    writeRawHttpError(clientSocket, 403, notRoutableMessage(selection.port, opts.target));
    return;
  }
  const refusal = await admit(opts);
  if (refusal) {
    writeRawHttpError(clientSocket, refusal.status, refusal.message);
    return;
  }
  const headers: NodeJS.Dict<string | string[]> = { ...req.headers };
  // Upgrade / Connection are the point of this path: keep the hop-by-hop set.
  const offeredBase = stripMicrovmProxyHeaders(headers);
  const appProtocolsLeft = headers['sec-websocket-protocol'] !== undefined;

  const upstreamSocket = netConnect({ host: upstream.host, port: upstream.port });
  upstreamSocket.setNoDelay(true);
  let connected = false;
  let responseHead: Buffer | undefined = Buffer.alloc(0);
  upstreamSocket.on('connect', () => {
    connected = true;
    const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/${req.httpVersion}`];
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue;
      for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
    }
    upstreamSocket.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) upstreamSocket.write(head);
    // Backpressure-aware, and a client FIN half-closes the upstream (end), not destroy.
    clientSocket.pipe(upstreamSocket);
  });
  // The 101 is relayed through ONE rewrite: a client that offered only the
  // MicroVM protocols must see `lambda-microvms` selected, or a client that
  // requires a subprotocol answer (as `ws` does) fails the handshake — the
  // app never saw that protocol, so it cannot select it itself.
  const onHead = (chunk: Buffer): void => {
    responseHead = Buffer.concat([responseHead!, chunk]);
    const end = responseHead.indexOf('\r\n\r\n');
    if (end === -1 && responseHead.length < 64 * 1024) return;
    // Head complete: stop reading by hand and hand the rest to pipe(), which
    // honours the client's backpressure and propagates the upstream's FIN.
    upstreamSocket.pause();
    upstreamSocket.off('data', onHead);
    const out =
      end === -1
        ? responseHead
        : Buffer.concat([
            Buffer.from(
              rewriteUpgradeResponseHead(
                responseHead.subarray(0, end).toString('latin1'),
                offeredBase && !appProtocolsLeft
              ) + '\r\n\r\n',
              'latin1'
            ),
            responseHead.subarray(end + 4),
          ]);
    responseHead = undefined;
    clientSocket.write(out);
    upstreamSocket.pipe(clientSocket);
  };
  upstreamSocket.on('data', onHead);
  const closeBoth = (): void => {
    if (!clientSocket.destroyed) clientSocket.destroy();
    if (!upstreamSocket.destroyed) upstreamSocket.destroy();
  };
  upstreamSocket.on('error', () => {
    if (!connected && !clientSocket.destroyed) {
      writeRawHttpError(
        clientSocket,
        502,
        `The application in MicroVM ${opts.target.microvmId} is not responding on port ${selection.port}.`
      );
      return;
    }
    closeBoth();
  });
  // A clean close travels as an `end` through pipe(); only an abrupt one
  // (an error or a reset) tears the other side down.
  upstreamSocket.on('close', (hadError) => {
    if (hadError) closeBoth();
  });
  clientSocket.on('error', closeBoth);
  clientSocket.on('close', () => {
    if (!upstreamSocket.destroyed && !upstreamSocket.writableEnded) upstreamSocket.end();
  });
}

/**
 * Add `Sec-WebSocket-Protocol: lambda-microvms` to a `101` response that
 * selected no protocol, when `addBase` (the client offered only MicroVM
 * protocols). Any other head passes through unchanged. Exported for unit testing.
 */
export function rewriteUpgradeResponseHead(head: string, addBase: boolean): string {
  if (!addBase) return head;
  const lines = head.split('\r\n');
  if (!/^HTTP\/1\.[01] 101\b/.test(lines[0] ?? '')) return head;
  if (lines.some((l) => /^sec-websocket-protocol\s*:/i.test(l))) return head;
  return [...lines, `Sec-WebSocket-Protocol: ${MICROVM_WS_BASE_PROTOCOL}`].join('\r\n');
}

function notRoutableMessage(port: number, target: MicrovmProxyTarget): string {
  return (
    `Port ${port} of MicroVM ${target.microvmId} is not reachable locally. cdk-local publishes ` +
    `8080, Hooks.Port, the image's EXPOSE ports and every --proxy-port; published: ` +
    `${target.routablePorts().join(', ')}.`
  );
}

function writeText(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`${message}\n`);
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
