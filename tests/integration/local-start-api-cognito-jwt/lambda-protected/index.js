// Protected handler for the local-start-api-cognito-jwt integ fixture.
// Echoes the JWT authorizer context (the verified claims surfaced by
// cdk-local's start-api JWT authorizer pass) so verify.sh can confirm
// the JWT verifier actually fired and propagated the decoded `sub` /
// `aud` claims onto the downstream Lambda's event.
exports.handler = async (event) => {
  const authCtx =
    (event.requestContext &&
      ((event.requestContext.authorizer && event.requestContext.authorizer.jwt) ||
        event.requestContext.authorizer)) ||
    null;
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protected: true, gap: 'G3', authorizer: authCtx }),
  };
};
