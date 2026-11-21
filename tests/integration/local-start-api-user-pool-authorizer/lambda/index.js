// Returns the verified JWT claims cdkl forwards in
// event.requestContext.authorizer.jwt.claims (HTTP v2) or
// event.requestContext.authorizer.claims (REST v1).
exports.handler = async (event) => {
  // HTTP v2 nests the claims under `jwt`; a REST v1 Cognito authorizer does not.
  const claims =
    event.requestContext?.authorizer?.jwt?.claims ?? event.requestContext?.authorizer?.claims ?? {};
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sub: claims.sub, aud: claims.aud }),
  };
};

// REST v1 TOKEN authorizer (go-to-k/cdk-local#1011): allows every token it is
// handed, so a 401 proves the IdentityValidationExpression stopped the token
// before the Lambda ran.
exports.authorize = async (event) => ({
  principalId: 'token-user',
  policyDocument: {
    Version: '2012-10-17',
    Statement: [{ Action: 'execute-api:Invoke', Effect: 'Allow', Resource: event.methodArn }],
  },
});
