// Entry file that throws while loading, before it ever listens: the
// `cdkl start-web-function` integ asserts the boot failure surfaces this
// stack trace and leaves no container behind.
throw new Error('boom-at-boot');
