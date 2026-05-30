// StackA Ping handler. verify.sh greps for `"stack":"a"` to confirm
// the curl reached this Lambda (and not StackB's PongHandler).
exports.handler = async (event) => ({
  statusCode: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    stack: 'a',
    path: event.rawPath || event.path || null,
  }),
});
