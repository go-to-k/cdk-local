// Minimal Bedrock AgentCore Runtime agent for the cdkl invoke-agentcore integ
// test. Serves the AgentCore HTTP contract on 0.0.0.0:8080:
//   GET  /ping        -> 200 {"status":"Healthy", ...}
//   POST /invocations -> echoes the request body, the received session-id
//                        header, the received Authorization header, and the
//                        injected GREETING env var.
// Startup logs go to stderr so the host's stdout carries only the cdkl
// result line.
const http = require('node:http');

const SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id';

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'Healthy', time_of_last_update: Math.floor(Date.now() / 1000) }));
    return;
  }

  if (req.method === 'POST' && req.url === '/invocations') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let echoed;
      try {
        echoed = JSON.parse(body || '{}');
      } catch {
        echoed = body;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          echoed,
          sessionId: req.headers[SESSION_HEADER] ?? null,
          authorization: req.headers['authorization'] ?? null,
          greeting: process.env.GREETING ?? 'unset',
        })
      );
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(8080, '0.0.0.0', () => {
  console.error('agent listening on 0.0.0.0:8080');
});
