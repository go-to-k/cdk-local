// Echoes back the env vars the container saw. The integ asserts that
// TABLE_NAME is the deployed DynamoDB table's actual physical name and
// SIBLING_ARN is the deployed sibling function's actual ARN (not the
// literal "${Token[...]}" or the unresolved intrinsic shape).
exports.handler = async (event) => {
  return {
    tableName: process.env.TABLE_NAME ?? 'unset',
    siblingArn: process.env.SIBLING_ARN ?? 'unset',
    staticValue: process.env.STATIC_VALUE ?? 'unset',
    event,
  };
};
