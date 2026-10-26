// A dependency-free MicroVM application for `cdkl start-microvm
// --from-cfn-stack`'s integ fixture. It serves the /ready hook on 9001 (200 at
// once, so the cloud image build snapshots promptly) and echoes, on 8080, the
// EnvironmentVariables it received (null when absent).
const http = require('http');

const env = (k) => (process.env[k] === undefined ? null : process.env[k]);

http
  .createServer((req, res) => {
    req.resume();
    res.writeHead(req.url.startsWith('/aws/lambda-microvms/runtime/v1/') ? 200 : 404);
    res.end();
  })
  .listen(9001, '0.0.0.0');

http
  .createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        staticValue: env('STATIC_VALUE'),
        refValue: env('REF_VALUE'),
        importedValue: env('IMPORTED_VALUE'),
        getattValue: env('GETATT_VALUE'),
      })
    );
  })
  .listen(8080, '0.0.0.0');

console.log('app listening on 8080, hooks on 9001');
