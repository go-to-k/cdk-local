import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { StudioEventBus, type StudioTargetKind } from './studio-events.js';

/** Config for {@link startStudioProxy}. */
export interface StudioProxyConfig {
  /** The shared event bus; `invocation` start/end events are emitted onto it. */
  bus: StudioEventBus;
  /** Serve target id the proxied traffic belongs to. */
  target: string;
  /** The served target's kind (the timeline row's per-kind affordance). */
  kind: StudioTargetKind;
  /** Upstream base URL to forward to, e.g. `http://127.0.0.1:51234`. */
  upstream: string;
  /** Listen host. Defaults to `127.0.0.1` (localhost-only). */
  host?: string;
  /** Clock (injectable for tests; defaults to `Date.now`). */
  clock?: () => number;
  /** Per-request id factory (injectable for tests). */
  idFactory?: () => string;
  /**
   * Max bytes of each captured request / response body retained for the
   * timeline (the FULL body is still streamed through untouched — only
   * the captured copy is bounded). Defaults to 64 KiB.
   */
  maxCaptureBytes?: number;
}

/** A running studio capture proxy. */
export interface RunningStudioProxy {
  /** The URL the proxy listens on (hand this to the user instead of upstream). */
  url: string;
  /** The actually-bound port. */
  port: number;
  /** Stop the proxy and release the port. */
  close: () => Promise<void>;
}

let proxyIdCounter = 0;

/**
 * True when `hostname` names this machine's loopback interface: `localhost`,
 * an IPv4 address in `127.0.0.0/8`, IPv6 `::1`, or an IPv4-mapped loopback
 * (`::ffff:127.0.0.1`, which `URL.hostname` renders in hex as
 * `[::ffff:7f00:1]`). Surrounding brackets, as `URL.hostname` keeps them for
 * an IPv6 literal, are tolerated. The match is EXACT — `localhost.example.com`
 * and `127.0.0.1.example.com` are ordinary DNS names that resolve wherever
 * their owner points them, and are NOT loopback.
 *
 * A `cdkl` serve child always listens on this machine, so this is the bound
 * studio puts on where it will ever forward a composer request (issue #578).
 * A destination that is not loopback did not come from a genuine serve, and
 * forwarding to it would carry the developer's request — headers and body —
 * off-box.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (h === 'localhost') return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  // IPv4-mapped IPv6 in hex form (`::ffff:7f00:1`): the high hextet's top
  // byte is the first IPv4 octet.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mapped) return parseInt(mapped[1]!, 16) >> 8 === 127;
  const dotted = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!dotted) return false;
  const octets = dotted.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return false;
  return octets[0] === 127;
}

/**
 * True when `hostname` is the UNSPECIFIED (wildcard) address: IPv4 `0.0.0.0`,
 * IPv6 `::` (`URL` normalises `0:0:0:0:0:0:0:0` to it), or the IPv4-mapped
 * `::ffff:0.0.0.0` (which `URL.hostname` renders as `[::ffff:0:0]`).
 *
 * A wildcard is a BIND address, not a destination — a server bound to it IS
 * reachable on loopback, and `--container-host 0.0.0.0` is an ordinary value
 * for `start-service` / `run-task` (default `127.0.0.1`) that `cdkl studio`
 * auto-renders in its "All options" section. So a wildcard is normalised to
 * loopback rather than refused; the security property is untouched, because a
 * line naming a real foreign host still names a real foreign host, and no
 * spelling of the wildcard reaches anywhere but this machine.
 */
export function isWildcardHostname(hostname: string): boolean {
  const h = hostname.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  return (
    h === '0.0.0.0' ||
    h === '::' ||
    h === '0:0:0:0:0:0:0:0' ||
    h === '::ffff:0.0.0.0' ||
    h === '::ffff:0:0'
  );
}

/**
 * Resolve an upstream URL a serve child named into the URL studio may
 * actually use, or `undefined` when it must be refused (issue #578).
 *
 * A wildcard host is REWRITTEN to `127.0.0.1` (see
 * {@link isWildcardHostname}) and the rewritten URL is what gets adopted as
 * the endpoint and handed to the proxy, so the destination really is
 * loopback rather than merely tolerated. Everything else must already be
 * loopback ({@link isLoopbackHostname}); a foreign host or an unparseable URL
 * resolves to `undefined`.
 *
 * Only the host token is rewritten — scheme, userinfo, port, path, query and
 * fragment are carried through byte-for-byte (rather than re-serialising the
 * `URL`, which would append a `/` the child never printed).
 */
export function normalizeLocalUpstream(upstream: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(upstream);
  } catch {
    return undefined;
  }
  if (!isWildcardHostname(parsed.hostname)) {
    return isLoopbackHostname(parsed.hostname) ? upstream : undefined;
  }
  const schemeEnd = upstream.indexOf('://');
  if (schemeEnd === -1) return undefined;
  const head = upstream.slice(0, schemeEnd + 3);
  const rest = upstream.slice(schemeEnd + 3);
  const cut = rest.search(/[/?#]/);
  const authority = cut === -1 ? rest : rest.slice(0, cut);
  const tail = cut === -1 ? '' : rest.slice(cut);
  const at = authority.lastIndexOf('@');
  const userinfo = at === -1 ? '' : authority.slice(0, at + 1);
  const hostPort = at === -1 ? authority : authority.slice(at + 1);
  const portAt = hostPort.startsWith('[') ? hostPort.indexOf(']') + 1 : hostPort.indexOf(':');
  const port = portAt > 0 ? hostPort.slice(portAt) : '';
  return `${head}${userinfo}127.0.0.1${port}${tail}`;
}

/**
 * Render an UNTRUSTED endpoint string for a human-readable message. The
 * string reached studio from a child's stdout, so it can carry control
 * characters (ANSI escapes, a bare CR) that would forge extra output, and it
 * can be arbitrarily long. Non-printable-ASCII bytes become `?` and the result
 * is length-capped, the same shape `credential-error` applies to a relayed
 * service message.
 */
export function describeEndpointForMessage(value: string): string {
  const flat = value.replace(/[^\x20-\x7e]/g, '?');
  return flat.length > 120 ? `${flat.slice(0, 120)}...` : flat;
}

/**
 * Start a capturing reverse proxy in front of a studio serve target
 * (decision D4a: because every request to the served port flows through
 * `cdkl studio`, the timeline observes them regardless of source —
 * browser, curl, or the in-UI pad alike).
 *
 * Each HTTP request is forwarded to `upstream` and, in parallel,
 * captured (method / path / headers / bounded body) and emitted as an
 * `invocation` start event; when the upstream response completes, an end
 * event carries the status / headers / bounded body / duration. The full
 * bodies stream through untouched — only the captured copies are bounded.
 * `Upgrade` (WebSocket) requests are bridged raw to the upstream without
 * capture so they keep working.
 *
 * Studio is a control plane over the CLI, so this proxy sits in front of
 * the long-running `cdkl start-api` child the serve manager spawned; it
 * does NOT re-implement any routing — it forwards verbatim.
 *
 * Throws SYNCHRONOUSLY (rather than rejecting) when `upstream` is unparseable
 * or names a non-loopback host (issue #578) — a refusal to attempt the proxy
 * at all, rather than a runtime failure of one. A wildcard bind address
 * (`0.0.0.0` / `::`) is not a refusal: it is rewritten to `127.0.0.1` and
 * forwarded there ({@link normalizeLocalUpstream}).
 */
export function startStudioProxy(config: StudioProxyConfig): Promise<RunningStudioProxy> {
  const host = config.host ?? '127.0.0.1';
  const clock = config.clock ?? Date.now;
  const maxCapture = config.maxCaptureBytes ?? 64 * 1024;
  const idFactory =
    config.idFactory ??
    (() => {
      proxyIdCounter += 1;
      return `req-${clock()}-${proxyIdCounter}`;
    });

  // Defence in depth (issue #578). The serve manager already resolves a ready
  // URL before it ever reaches a proxy, but this proxy is the component that
  // actually forwards the developer's request, so it enforces the same bound
  // itself: every caller — now and later — has to name a local upstream. A
  // wildcard BIND address is rewritten to loopback (so the forwarded request
  // goes to 127.0.0.1, not 0.0.0.0); anything else non-loopback is refused,
  // which also means the guard cannot be lost by a future call site that
  // forgets it.
  const resolvedUpstream = normalizeLocalUpstream(config.upstream);
  if (resolvedUpstream === undefined) {
    throw new Error(
      `studio proxy refuses the non-loopback upstream '${describeEndpointForMessage(config.upstream)}': ` +
        'a serve child always listens on this machine, so a request forwarded there would leave it.'
    );
  }
  const upstreamUrl = new URL(resolvedUpstream);
  const upstreamHost = upstreamUrl.hostname;
  const upstreamPort = Number(upstreamUrl.port) || 80;

  const server = createServer((clientReq, clientRes) => {
    const id = idFactory();
    const startedAt = clock();
    const path = clientReq.url ?? '/';
    const method = clientReq.method ?? 'GET';
    const label = `${method} ${path.split('?')[0]}`;

    // Capture the request body (bounded) while it streams to the upstream.
    const reqBody = boundedCollector(maxCapture);

    config.bus.emit('invocation', {
      id,
      ts: startedAt,
      target: config.target,
      kind: config.kind,
      label,
      request: { method, path, headers: { ...clientReq.headers } },
    });

    // Exactly ONE end event per request — whether it ends via the upstream
    // response, an upstream error, or a client abort. A second terminal
    // event (e.g. upstream socket erroring AFTER the response started) would
    // overwrite the real status on the timeline.
    let ended = false;
    const emitEnd = (status: number, response: unknown): void => {
      if (ended) return;
      ended = true;
      config.bus.emit('invocation', {
        id,
        ts: startedAt,
        target: config.target,
        kind: config.kind,
        label,
        request: { method, path, headers: { ...clientReq.headers }, body: reqBody.text() },
        response,
        status,
        durationMs: clock() - startedAt,
      });
    };

    const upstreamReq = httpRequest(
      {
        host: upstreamHost,
        port: upstreamPort,
        method,
        path,
        headers: clientReq.headers,
      },
      (upstreamRes) => {
        const respBody = boundedCollector(maxCapture);
        // Strip hop-by-hop headers before forwarding: `transfer-encoding` /
        // `connection` describe THIS connection, not the entity, and Node's
        // client already decoded a chunked body — re-declaring it (or a
        // stale `content-length`) can hang the client. `content-length` is
        // end-to-end and kept.
        clientRes.writeHead(upstreamRes.statusCode ?? 502, stripHopByHop(upstreamRes.headers));
        upstreamRes.on('data', (chunk: Buffer) => respBody.push(chunk));
        upstreamRes.pipe(clientRes);
        upstreamRes.on('end', () =>
          emitEnd(upstreamRes.statusCode ?? 502, {
            status: upstreamRes.statusCode,
            headers: { ...upstreamRes.headers },
            body: respBody.text(),
          })
        );
        upstreamRes.on('error', () => {
          // The upstream died mid-response: terminate the client response so
          // it does not hang half-open (a dangling client socket that the
          // server's later closeAllConnections would destroy, surfacing as an
          // unhandled error). pipe() does not auto-close the destination on a
          // source error, so do it explicitly.
          if (!clientRes.writableEnded) clientRes.destroy();
          emitEnd(502, 'upstream response stream error');
        });
      }
    );

    upstreamReq.on('error', (err) => {
      if (!clientRes.headersSent) clientRes.writeHead(502, { 'content-type': 'text/plain' });
      clientRes.end(`studio proxy: upstream error: ${err.message}`);
      emitEnd(502, `upstream error: ${err.message}`);
    });

    clientReq.on('data', (chunk: Buffer) => reqBody.push(chunk));
    clientReq.on('error', () => {
      // The client hung up mid-flight — tear down the upstream and close the
      // timeline row (499, the "client closed request" convention) so it
      // does not dangle as pending forever.
      upstreamReq.destroy();
      emitEnd(499, 'client aborted the request');
    });
    clientReq.pipe(upstreamReq);
  });

  // WebSocket / other `Upgrade` requests: bridge the raw socket to the
  // upstream without capture so they keep working through the proxy.
  // Hijacked upgrade sockets are detached from the server's request flow,
  // so track them and destroy them on close() (otherwise a live WebSocket
  // keeps the server from closing).
  const upgradeSockets = new Set<Socket>();
  server.on('upgrade', (req, clientSocket, head) => {
    const sock = clientSocket as Socket;
    upgradeSockets.add(sock);
    sock.on('close', () => upgradeSockets.delete(sock));
    bridgeUpgrade(req, sock, head, upstreamHost, upstreamPort);
  });

  return new Promise<RunningStudioProxy>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.removeListener('error', reject);
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://${host}:${port}`,
        port,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            for (const sock of upgradeSockets) sock.destroy();
            upgradeSockets.clear();
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

/** RFC 7230 hop-by-hop headers — never forwarded across a proxy. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Copy `headers` without the hop-by-hop ones (which describe one connection). */
function stripHopByHop(
  headers: Record<string, string | string[] | undefined>
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/** A bounded byte collector that decodes to a (possibly truncated) utf8 string. */
function boundedCollector(maxBytes: number): { push: (c: Buffer) => void; text: () => string } {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  return {
    push: (c: Buffer): void => {
      if (size >= maxBytes) {
        truncated = true;
        return;
      }
      const room = maxBytes - size;
      if (c.length > room) {
        chunks.push(c.subarray(0, room));
        size = maxBytes;
        truncated = true;
      } else {
        chunks.push(c);
        size += c.length;
      }
    },
    text: (): string => {
      const s = Buffer.concat(chunks).toString('utf8');
      return truncated ? `${s}… (truncated)` : s;
    },
  };
}

/** Raw-bridge an `Upgrade` request (e.g. WebSocket) to the upstream. */
function bridgeUpgrade(
  req: IncomingMessage,
  clientSocket: Socket,
  head: Buffer,
  upstreamHost: string,
  upstreamPort: number
): void {
  const upstream = netConnect(upstreamPort, upstreamHost, () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    raw += '\r\n';
    upstream.write(raw);
    if (head && head.length > 0) upstream.write(head);
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  });
  const teardown = (): void => {
    clientSocket.destroy();
    upstream.destroy();
  };
  // Tear down BOTH sockets when either errors OR closes — a clean half-open
  // close (FIN, no error) on one side must not leave the peer dangling.
  upstream.on('error', teardown);
  upstream.on('close', teardown);
  clientSocket.on('error', teardown);
  clientSocket.on('close', teardown);
}
