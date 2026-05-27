exports.handler = async (event) => {
  return {
    message: process.env.GREETING ?? 'Hello from cdk-local!',
    receivedEvent: event,
  };
};
