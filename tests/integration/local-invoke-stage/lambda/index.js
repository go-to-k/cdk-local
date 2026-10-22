// Returns the MARKER env var of the stack this copy of the function was
// synthesized into, so verify.sh can tell which stack a target reached:
// every stack shares this one asset and one logical ID.
exports.handler = async () => ({
  statusCode: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ marker: process.env.MARKER }),
  marker: process.env.MARKER,
});
