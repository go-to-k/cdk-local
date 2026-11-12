/**
 * The signal policy of a long-running command that owns containers
 * (issue #882).
 *
 * - The FIRST SIGINT / SIGTERM runs the (single-flight) cleanup, then exits
 *   with the code the caller gives for that signal.
 * - The SECOND one does NOT abandon the cleanup. It used to force-exit with
 *   `container cleanup skipped`, which is exactly when a user presses ^C again:
 *   while the first one's teardown is still removing containers. That left the
 *   containers, the sidecars and the network behind. It now says the cleanup
 *   is still running and how to force an exit.
 * - The THIRD one force-exits at once (the escape from a hung Docker daemon),
 *   naming what may be left behind.
 */
export interface ShutdownSignalOptions {
  /** The single-flight cleanup. Must not reject. */
  cleanup: () => Promise<void>;
  /** Logged on the first signal. */
  stoppingMessage: (signal: string) => string;
  /** Appended to the force-exit line: how to find what was left behind. */
  forceExitHint: string;
  info: (message: string) => void;
  warn: (message: string) => void;
  /** Test seam; defaults to `process.exit`. */
  exit?: (code: number) => void;
  /** Test seam for the force-exit line; defaults to `process.stderr.write`. */
  writeStderr?: (text: string) => void;
}

export type ShutdownSignalHandler = (signal: string, exitCode: number) => void;

export function createShutdownSignalHandler(options: ShutdownSignalOptions): ShutdownSignalHandler {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const writeStderr = options.writeStderr ?? ((text: string) => void process.stderr.write(text));
  let count = 0;
  return (signal, exitCode) => {
    count += 1;
    if (count === 1) {
      options.info(options.stoppingMessage(signal));
      void options.cleanup().then(() => exit(exitCode));
      return;
    }
    if (count === 2) {
      options.warn(
        `Received ${signal} again; still shutting down — waiting for the cleanup to remove the ` +
          'containers and networks. Send it once more to force-exit (that skips the cleanup).'
      );
      return;
    }
    writeStderr(
      `Force-exit on repeated ${signal}; container cleanup skipped. ${options.forceExitHint}\n`
    );
    exit(130);
  };
}
