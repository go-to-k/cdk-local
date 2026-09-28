exports.handler = async (event) => {
  return {
    echoed: event,
    greeting: process.env.GREETING ?? 'unset',
    // Read `__proto__` as an OWN key: a plain `process.env.__proto__` could
    // resolve to the inherited accessor instead (issue #769).
    protoEnv: Object.getOwnPropertyDescriptor(process.env, '__proto__')?.value ?? 'unset',
  };
};
