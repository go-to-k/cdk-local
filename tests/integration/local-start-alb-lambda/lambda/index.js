// ALB Lambda-target handler (#123). Echoes the parts of the ALB event the
// integ harness asserts on, so verify.sh can confirm the HTTP -> ALB-event
// translation AND the response -> HTTP translation round-trip.
exports.handler = async (event) => {
  const body = JSON.stringify({
    role: 'lambda',
    // Confirms the front-door built the ALB Lambda-target event shape.
    hasElbContext: !!(event.requestContext && event.requestContext.elb),
    httpMethod: event.httpMethod,
    path: event.path,
    queryStringParameters: event.queryStringParameters ?? null,
    multiValueQueryStringParameters: event.multiValueQueryStringParameters ?? null,
    greeting: process.env.GREETING ?? 'unset',
  });
  return {
    statusCode: 200,
    statusDescription: '200 OK',
    isBase64Encoded: false,
    headers: {
      'Content-Type': 'application/json',
      'X-Handler': 'alb-lambda-fixture',
    },
    body,
  };
};
