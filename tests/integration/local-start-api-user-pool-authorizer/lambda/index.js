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
