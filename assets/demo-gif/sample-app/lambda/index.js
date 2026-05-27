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
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    };
  }
  return { ...payload, receivedEvent: event };
};
