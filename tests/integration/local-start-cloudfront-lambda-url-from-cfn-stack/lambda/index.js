// Lambda Function URL handler behind a CloudFront distribution. Echoes back
// the env vars the container saw as a Function URL (payload v2.0) response.
// The integ asserts TABLE_NAME is the deployed DynamoDB table's physical name
// (only under --from-cfn-stack) and STATIC_VALUE is the literal.
exports.handler = async () => {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableName: process.env.TABLE_NAME ?? 'unset',
      staticValue: process.env.STATIC_VALUE ?? 'unset',
    }),
  };
};
