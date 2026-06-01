#!/usr/bin/env node
// Mock HTTP upstream for the local-start-api-http-proxy integ test.
//
// Boots a tiny Node HTTP server on 127.0.0.1:<port> that echoes the
// incoming method, path, the X-Integ-Trace header (when present), and
// the request body as a single JSON document. The cdkl start-api
// HTTP_PROXY integration forwards every /echo request here so the
// integ can assert header + body + method + path pass-through.
//
// Usage:
//   node mock-upstream.mjs [port]
// Defaults to port 18091, which matches the URI the fixture stack
// declares on the HTTP_PROXY integration.

import { createServer } from 'node:http';

function main() {
  const port = Number.parseInt(process.argv[2] ?? '18091', 10);
  const host = '127.0.0.1';

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      const payload = {
        upstream: 'mock-upstream',
        method: req.method,
        url: req.url,
        traceHeader: req.headers['x-integ-trace'] ?? null,
        body,
      };
      const buf = Buffer.from(JSON.stringify(payload), 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': String(buf.length),
        'X-Mock-Upstream': 'cdkl-integ',
      });
      res.end(buf);
    });
  });

  server.listen(port, host, () => {
    process.stdout.write(`mock-upstream listening on http://${host}:${port}\n`);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      server.close(() => process.exit(0));
    });
  }
}

main();
