import { request as httpRequest } from 'node:http';

/**
 * A keep-alive-FREE HTTP test client (`agent: false`) — an alternative to
 * global `fetch` (undici) for tests that hit a local `http.Server` they
 * later close.
 *
 * Why this exists: undici pools the idle keep-alive socket after a `fetch`;
 * when the test then closes its server with `server.closeAllConnections()`
 * (studio-server, start-api's HTTP server, the studio proxy all do), that
 * pooled socket is destroyed from the SERVER side and undici raises an
 * UNHANDLED rejection on the client side. Node exits the worker on an
 * unhandled rejection, which crashes the vitest forks pool (`[vitest-pool]:
 * Worker forks emitted error`, exit 1) on a loaded CI box — even though
 * every test passed. It turned `main` red repeatedly across the studio
 * slices (#290, #297). `agent: false` opens a fresh socket per request that
 * closes on response end, so nothing is ever pooled and
 * `closeAllConnections()` has no client socket to destroy.
 */
export interface AgentlessResponse {
  status: number;
  /** Mirrors the `fetch` `Headers` subset the tests use. */
  headers: { get: (k: string) => string | null; getSetCookie: () => string[] };
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

/** Perform one keep-alive-free request. Mirrors a minimal `fetch`. */
export function http(
  url: string,
  opts: { method?: string; body?: string; headers?: Record<string, string> } = {}
): Promise<AgentlessResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers: Record<string, string> =
      opts.body != null ? { 'content-type': 'application/json', ...opts.headers } : { ...opts.headers };
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: opts.method ?? 'GET',
        agent: false,
        headers,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        const finish = (): void =>
          resolve({
            status: res.statusCode ?? 0,
            headers: {
              // `fetch`'s `Headers.get` returns `null` (not undefined) for a
              // missing header, and joins a multi-value header with ', '.
              get: (k) => {
                const v = res.headers[k.toLowerCase()];
                if (v === undefined) return null;
                return Array.isArray(v) ? v.join(', ') : v;
              },
              // `fetch` exposes multi-valued Set-Cookie via getSetCookie().
              getSetCookie: () => {
                const v = res.headers['set-cookie'];
                return Array.isArray(v) ? v : v ? [v] : [];
              },
            },
            json: () => Promise.resolve(JSON.parse(data)),
            text: () => Promise.resolve(data),
          });
        res.on('end', finish);
        res.on('error', finish);
      }
    );
    req.on('error', reject);
    if (opts.body != null) req.write(opts.body);
    req.end();
  });
}
