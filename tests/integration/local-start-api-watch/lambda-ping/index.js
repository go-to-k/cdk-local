// Ping handler for the local-start-api-watch integ fixture.
//
// verify.sh rewrites this whole file mid-run to bump the `version`
// marker (v1 -> v2) and asserts the served response changes after a
// single hot reload. Keep the handler trivial so the asset re-stages
// quickly on re-synth.
exports.handler = async () => {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ functionUrl: true, version: 'v1' }),
  };
};
