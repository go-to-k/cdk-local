// A dependency-free Lambda Web Function server for the
// `cdkl start-web-function --from-cfn-stack` integ test. `GET /` echoes the
// ServiceConfig env vars it received (null when absent); `GET /whoami` calls
// STS GetCallerIdentity with the credentials in the container env, through the
// SDK the Lambda nodejs:24 image ships, to prove which role is in effect.
const http = require('node:http');

const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT || '').split(':');
if (!host || !port) {
  console.error('AWS_LAMBDA_HTTP_ENDPOINT is not set');
  process.exit(1);
}

const env = (k) => (process.env[k] === undefined ? null : process.env[k]);

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

http
  .createServer(async (req, res) => {
    if (req.url === '/whoami') {
      try {
        const sts = require('/var/runtime/node_modules/@aws-sdk/client-sts');
        const out = await new sts.STSClient({}).send(new sts.GetCallerIdentityCommand({}));
        return send(res, 200, { arn: out.Arn });
      } catch (err) {
        return send(res, 500, { error: String(err && err.message ? err.message : err) });
      }
    }
    return send(res, 200, {
      staticValue: env('STATIC_VALUE'),
      refValue: env('REF_VALUE'),
      importedValue: env('IMPORTED_VALUE'),
      getattValue: env('GETATT_VALUE'),
    });
  })
  .listen(Number(port), host, () => {
    console.error(`web function listening on ${host}:${port}`);
  });
