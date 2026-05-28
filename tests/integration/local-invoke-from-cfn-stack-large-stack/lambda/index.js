// Counts how many `P###` env vars survived state-source substitution.
// The integ asserts that --from-cfn-stack resolves ALL of them even
// though the stack has more than 100 resources: DescribeStackResources
// would cap at the first 100 and silently drop the tail, whereas the
// paginated ListStackResources provider maps every parameter.
exports.handler = async (event) => {
  const paramCount = Object.keys(process.env).filter((k) => /^P\d{3}$/.test(k)).length;
  return {
    paramCount,
    staticValue: process.env.STATIC_VALUE ?? 'unset',
    event,
  };
};
