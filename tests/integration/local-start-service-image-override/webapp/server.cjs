// server.cjs — override webapp for the local-start-service-image-override
// integ fixture (issues #238 / #240 / #244). Replies with a constant
// `OVERRIDE_OK` string so verify.sh can distinguish the local override
// build from the placeholder ECR image (which is unreachable and would
// fail to pull anyway). `.cjs` extension keeps the file out of
// tests/integration/.gitignore's `*.js` sweep.
const http = require('http');
const PAYLOAD = 'OVERRIDE_OK';
http
  .createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(PAYLOAD);
  })
  .listen(8080, '0.0.0.0', () => {
    console.log(`override webapp serving '${PAYLOAD}' on 8080`);
  });
