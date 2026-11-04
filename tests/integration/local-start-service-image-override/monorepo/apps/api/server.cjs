// server.cjs — the same-stack-ECR service's local build (issues #847 / #848).
// Replies `<payload>|<DB_USER>`: the payload comes from the monorepo's
// `shared/` (so the build used the `--image-context` root) and DB_USER from
// the `--env-vars` override of a Secrets entry whose literal Secrets Manager
// ARN is never fetched. `.cjs` keeps the file out of the `*.js` gitignore.
const http = require('http');
const fs = require('fs');
const PAYLOAD = fs.readFileSync('/app/payload.txt', 'utf-8').trim();
http
  .createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`${PAYLOAD}|${process.env.DB_USER ?? '<unset>'}`);
  })
  .listen(8080, '0.0.0.0', () => {
    console.log(`same-stack ECR webapp serving on 8080`);
  });
