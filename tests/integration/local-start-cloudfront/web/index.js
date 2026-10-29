// Minimal, dependency-free Lambda Web Function server for the
// `cdkl start-cloudfront` Web Function endpoint origin phase. It listens on
// the host:port the runtime hands it in AWS_LAMBDA_HTTP_ENDPOINT and echoes
// what the origin request carried (method, path, Host, X-Forwarded-For, body)
// plus the revision's ServiceConfig env, as JSON.
const http = require('node:http');

const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT || '').split(':');
if (!host || !port) {
  console.error('AWS_LAMBDA_HTTP_ENDPOINT is not set');
  process.exit(1);
}

http
  .createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'web-session=1; Path=/',
        // Origin headers the ResponseHeadersPolicy replaces (Override: true),
        // keeps (Override: false) and removes.
        'x-frame-options': 'SAMEORIGIN',
        'referrer-policy': 'origin',
        'x-powered-by': 'cdkl-web',
      });
      res.end(
        JSON.stringify({
          method: req.method,
          path: req.url,
          host: req.headers.host,
          forwardedFor: req.headers['x-forwarded-for'],
          body: Buffer.concat(chunks).toString('utf8'),
          revision: process.env.REVISION_LABEL,
          greeting: process.env.GREETING,
        })
      );
    });
  })
  .listen(Number(port), host, () => {
    console.error(`web function listening on ${host}:${port}`);
  });
