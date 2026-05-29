// Minimal Bedrock AgentCore Runtime agent for the cdkl invoke-agentcore
// --from-cfn-stack integ. Serves the AgentCore HTTP contract on 0.0.0.0:8080:
//   GET  /ping        -> 200 {"status":"Healthy", ...}
//   POST /invocations -> echoes the injected GREETING / API_KEY / STATIC_VALUE
//                        env vars so verify.sh can assert --from-cfn-stack
//                        resolved them (String + SecureString SSM params).
// Compact JSON (no spaces) to match verify.sh's grep assertions. Startup
// logs go to stderr so the host's stdout carries only the cdkl result.
const http = require('node:http');

function send(res, status, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(data.length) });
  res.end(data);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/ping') {
    send(res, 200, { status: 'Healthy', time_of_last_update: Math.floor(Date.now() / 1000) });
    return;
  }
  if (req.method === 'POST' && req.url === '/invocations') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      send(res, 200, {
        greeting: process.env.GREETING ?? 'unset',
        apiKey: process.env.API_KEY ?? 'unset',
        staticValue: process.env.STATIC_VALUE ?? 'unset',
        runtime: 'agentcore-from-cfn',
      });
    });
    return;
  }
  send(res, 404, { error: 'not found' });
});

server.listen(8080, '0.0.0.0', () => {
  console.error('agentcore from-cfn agent listening on 0.0.0.0:8080');
});
