exports.handler = async (event) => {
  const payload = {
    message: process.env.GREETING ?? 'Hello from cdk-local!',
  };
  // HTTP API v2 / REST v1 / Function URL events carry `requestContext`.
  // When invoked via `cdkl start-api` the response must be in the API
  // Gateway shape (statusCode + body string). For plain `cdkl invoke`
  // calls the event has no `requestContext`, so we return the payload
  // verbatim alongside the raw event for visibility.
  if (event && event.requestContext) {
    // POST /echo reflects what the caller sent (used by the studio request
    // composer demo to show a body + header round-tripping); other routes
    // return the plain greeting.
    const method = event.requestContext.http && event.requestContext.http.method;
    const isEcho = (event.rawPath || '').endsWith('/echo') || method === 'POST';
    const out = isEcho
      ? { message: payload.message, youSent: { headers: event.headers, body: event.body } }
      : payload;
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(out),
    };
  }
  return { ...payload, receivedEvent: event };
};
