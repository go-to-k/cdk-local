// StackB Pong handler. verify.sh greps for `"stack":"b"` to confirm
// the curl reached this Lambda (and not StackA's PingHandler).
exports.handler = async (event) => ({
  statusCode: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    stack: 'b',
    path: event.rawPath || event.path || null,
  }),
});
