// A dependency-free MicroVM application for `cdkl start-microvm`'s integ
// fixture. It serves the lifecycle hooks on 9001 and echoes what it saw on
// 8080 and 9000, so verify.sh can assert the hook order, the run payload and
// the port routing from the outside.
const http = require('http');

const HOOK_PREFIX = '/aws/lambda-microvms/runtime/v1/';
const state = {
  readyAttempts: 0,
  hooks: [],
  microvmId: null,
  runHookPayload: null,
  greeting: process.env.GREETING || null,
};

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

http
  .createServer(async (req, res) => {
    const body = await readBody(req);
    if (req.method !== 'POST' || !req.url.startsWith(HOOK_PREFIX)) return send(res, 404, {});
    const hook = req.url.slice(HOOK_PREFIX.length);
    if (hook === 'ready') {
      state.readyAttempts += 1;
      // NEVER_READY images stay "not yet" forever; the others become ready on
      // the third poll, so the 503 retry path is exercised.
      if (process.env.NEVER_READY === '1' || state.readyAttempts < 3) {
        console.log(`HOOK ready -> 503 (attempt ${state.readyAttempts})`);
        return send(res, 503, { ready: false });
      }
    }
    if (hook === 'run') {
      const parsed = JSON.parse(body || '{}');
      state.microvmId = parsed.microvmId ?? null;
      state.runHookPayload = parsed.runHookPayload ?? null;
    }
    state.hooks.push(hook);
    console.log(`HOOK ${hook} -> 200 microvm=${state.microvmId ?? '-'}`);
    return send(res, 200, { ok: true });
  })
  .listen(9001, '0.0.0.0');

for (const port of [8080, 9000]) {
  http
    .createServer(async (req, res) => {
      await readBody(req);
      send(res, 200, {
        port,
        path: req.url,
        microvmId: state.microvmId,
        runHookPayload: state.runHookPayload,
        greeting: state.greeting,
        readyAttempts: state.readyAttempts,
        hooks: state.hooks,
        proxyHeaders: Object.keys(req.headers).filter((h) => h.startsWith('x-aws-proxy-')),
      });
    })
    .listen(port, '0.0.0.0');
}

console.log('app listening on 8080, 9000 and hooks on 9001');
