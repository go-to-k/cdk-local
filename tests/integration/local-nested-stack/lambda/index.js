exports.handler = async (event) => {
  const who = process.env.WHO;
  // API Gateway proxy event -> proxy response; plain invoke -> plain object.
  if (event && event.httpMethod) {
    return { statusCode: 200, body: JSON.stringify({ who }) };
  }
  return { who };
};
