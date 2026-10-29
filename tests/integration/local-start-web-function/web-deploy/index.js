// The BucketDeployment (extract: false) arm's bundle. It is a directory of its
// own, so its asset differs from the `Code` asset and a reply naming entry
// "deploy-bundle" proves the revision ran the deployment's source asset.
const http = require('node:http');

const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT || '').split(':');
if (!host || !port) {
  console.error('AWS_LAMBDA_HTTP_ENDPOINT is not set');
  process.exit(1);
}

http
  .createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        method: req.method,
        path: req.url,
        entry: 'deploy-bundle',
        revision: process.env.REVISION_LABEL,
      })
    );
  })
  .listen(Number(port), host, () => {
    console.error(`web function (deploy-bundle) listening on ${host}:${port}`);
  });
