import type { Command } from 'commander';

/**
 * Strip a real CLI command's action handler so a test can drive
 * `cmd.parse(...)` for its OPTION PARSING ONLY.
 *
 * Why this exists (issue go-to-k/cdk-local#402): Commander runs the
 * registered action as part of `parse()`. A site-level binding test that
 * builds a REAL factory (`createLocalStartAlbCommand()`,
 * `createLocalStartServiceCommand()`, ...) and parses an argv to assert on
 * `cmd.opts()` therefore also STARTS the command — synth, docker
 * pre-flight, servers, watchers — even though it only ever asserts the
 * parsed options.
 *
 * That is not a slow test; it is a test that outlives itself. Measured on
 * `tests/unit/cli/local-start-no-logs.test.ts` with an `async_hooks` probe,
 * four `parse()` calls left four live `PROCESSWRAP` handles at worker exit:
 *
 *     at ensureDockerAvailable        (src/local/docker-runner.ts:379)
 *     at runEcsServiceEmulator        (src/cli/commands/ecs-service-emulator.ts:626)
 *     at .../local-start-service.ts:98
 *
 * i.e. a unit test shelling out to real `docker`. The file's assertions all
 * pass and the file completes, but the orphaned action chain keeps running
 * in the forked worker and eventually rejects. `tests/setup.ts` makes
 * `process.exit` a no-op, so that rejection surfaces as an unhandled
 * rejection, which Node 24 turns into a non-zero worker exit. Vitest defers
 * worker termination to the end of the run, so whether the parent has
 * already removed its `emitUnexpectedExit` listener is a race: lose it and
 * the whole run reports
 *
 *     Error: [vitest-pool]: Worker forks emitted error.
 *     Caused by: Error: Worker exited unexpectedly
 *
 * and exits 1 with every test passing. Measured 5 failures in 10 local
 * `vp test run` invocations before this fix.
 *
 * Replacing the action keeps the parse — and therefore every assertion
 * these tests make about `cmd.opts()` — completely unchanged. It only drops
 * the side effect the test never wanted. Reach for it whenever a test
 * builds a real `createLocal*Command()` and parses argv without mocking the
 * modules that command's action reaches.
 */
export function withoutAction(cmd: Command): Command {
  // Commander stores a single action handler per command, so registering a
  // no-op replaces the factory's real one.
  cmd.action(() => {});
  return cmd;
}
