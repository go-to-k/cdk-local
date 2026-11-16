// Returns the verified JWT claims cdkl forwards in
// event.requestContext.authorizer.jwt.claims.
exports.handler = async (event) => {
  const claims = event.requestContext?.authorizer?.jwt?.claims ?? {};
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sub: claims.sub, aud: claims.aud }),
  };
};
