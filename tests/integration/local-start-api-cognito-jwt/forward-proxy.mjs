// Minimal RECORDING FORWARD PROXY for the HTTP_PROXY integ phase (issue
// #647). Listens on an OS-ASSIGNED loopback port (never a hard-coded one —
// issue #591's disease), prints that port on stdout, and appends
// `<METHOD> <absolute-url>` for every proxied request to the log file given
// as argv[2].
//
// Unlike `local-invoke`'s `proxy-recorder.mjs`, which records a CONNECT and
// answers 502, this one actually FORWARDS. That is the point: the JWKS read
// has to still succeed through the proxy, so the phase can assert BOTH that
// the request was proxied (it appears in this log, in absolute form — the
// request line a direct client never sends) AND that JWT verification kept
// working (valid -> 200, expired -> 401). A 502-only recorder would push the
// verifier into its unreachable-JWKS pass-through mode, where an expired
// token is accepted and the assertion would be vacuous.
//
// Plain HTTP only. `CONNECT` is logged and refused: the fixture's issuer is
// an `http://` loopback sidecar, and a TLS tunnel would need a CA the
// fixture does not mint.
import http from 'node:http';
import fs from 'node:fs';

const logFile = process.argv[2];
if (!logFile) {
  console.error('usage: node forward-proxy.mjs <log-file>');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  fs.appendFileSync(logFile, `${req.method} ${req.url}\n`);
  let target;
  try {
    // A proxied client sends the request line in ABSOLUTE form, so `req.url`
    // parses as a full URL. Anything else was not addressed to a proxy.
    target = new URL(req.url);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('not an absolute-form proxy request');
    return;
  }
  const upstream = http.request(
    {
      hostname: target.hostname,
      port: target.port || 80,
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers: { ...req.headers, host: target.host },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    }
  );
  upstream.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`upstream error: ${err.message}`);
  });
  req.pipe(upstream);
});

server.on('connect', (req, socket) => {
  fs.appendFileSync(logFile, `CONNECT ${req.url}\n`);
  socket.end('HTTP/1.1 501 Not Implemented\r\n\r\n');
});

server.on('clientError', (_err, socket) => socket.destroy());

server.listen(0, '127.0.0.1', () => {
  console.log(String(server.address().port));
});
