// ALB Lambda-target handler for the start-alb WebSocket Upgrade integ (#176).
// Returns a plain HTTP 200; the front-door is expected to short-circuit any
// inbound `Upgrade: websocket` request with a 502 BEFORE it reaches this
// handler (Lambda target groups do not support WebSocket; mirrors ALB itself).
exports.handler = async () => {
  return {
    statusCode: 200,
    statusDescription: '200 OK',
    isBase64Encoded: false,
    headers: {
      'Content-Type': 'text/plain',
      'X-Handler': 'alb-ws-lambda-fixture',
    },
    body: 'plain-http-response-not-a-ws-handshake\n',
  };
};
