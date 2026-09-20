# Integration Test Creator

Scaffold a NEW `tests/integration/<name>/` fixture, fill in its stack +
assertions, and RUN it.

Every new subcommand factory (`src/cli/commands/local-<verb>.ts`) is brand-new
behavior with no existing fixture, so it MUST ship its own. Use this skill for a
new command, or a new runtime path no existing fixture exercises; a new flag on
an existing command usually extends that command's fixture instead.

## Arguments

- `name`: the fixture directory name under `tests/integration/`, by convention
  `local-<command>[-<scenario>]`. If omitted, ask which command/behavior it
  covers and derive the name.

## Steps

1. **Decide the shape.** Two kinds:
   - **Docker-only** (most): `verify.sh` boots `cdkl <cmd>` against a
     synthesized fixture and asserts the result.
   - **`*-from-cfn-stack`** (real AWS): `verify.sh` does `cdk deploy` first, runs
     `cdkl <cmd> --from-cfn-stack`, then `cdk destroy`.

2. **Scaffold the files** under `tests/integration/<name>/`:

   - `cdk.json`: `{ "app": "node bin/app.ts" }`

   - `package.json` and `tsconfig.json` — copy both from an existing fixture
     (e.g. `local-start-cloudfront-s3-from-cfn-stack/`), rename to
     `cdkl-integ-<name>`, and keep the trailing newline. **Keep the pinned
     `packageManager`**, at exactly the version `vp install` would write:
     without it (or with a mismatch) the first integ run rewrites
     `package.json`, dirtying the tree, staling the `integ` marker and leaking
     into the PR.

   - `bin/app.ts`:

     ```ts
     #!/usr/bin/env node
     import * as cdk from 'aws-cdk-lib';
     import { <Stack> } from '../lib/<name>-stack.ts';

     const app = new cdk.App();
     new <Stack>(app, '<FixtureStackName>', {});
     ```

   - `lib/<name>-stack.ts` — the minimal CDK resources the command exercises.
     Gate a slow resource behind a `withX` context flag when the fixture does not
     need it deployed (the cloudfront fixtures deploy a bucket-only stack and
     synth the distribution under `-c withDistribution=true`).

     **If the stack declares ANY Lambda, it MUST declare the HOST CPU
     architecture** (issue go-to-k/cdk-local#560). A Lambda with no
     `architecture` defaults to `X86_64`, so on an arm64 host cdk-local pins
     `--platform linux/amd64`, the container runs under emulation, and the Go RIE
     faults intermittently — a failure landing on a different assertion each run,
     which reads as flaky. CI runs on amd64, where the buggy default IS the host
     arch, so CI can never catch it. Copy this above the stack class:

     ```typescript
     const HOST_ARCHITECTURE =
       process.arch === 'arm64' ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64;
     ```

     Pass `architecture: HOST_ARCHITECTURE` on every `lambda.Function` /
     `lambda.DockerImageFunction`, and `architectures: [HOST_ARCHITECTURE.name]`
     on every L1 `lambda.CfnFunction` (the L1 takes architecture NAMES). Never
     hardcode either value. Two exceptions, both where an ARTIFACT dictates the
     architecture: a handler shipping a PREBUILT binary (pin to the BINARY), and
     a `DockerImageFunction` whose Dockerfile pulls an arch-specific base image or
     `COPY`s in a cross-compiled executable (the declared architecture drives
     `docker build` as well as `docker run`). A multi-arch base with no prebuilt
     binary copied in is NOT an exception.

     Then add the new file to `HOST_ARCHITECTURE_STACKS` in
     `tests/unit/integ-fixture-host-architecture.test.ts` — that fence asserts
     every fixture source constructing a `*Function(` is accounted for, so a new
     fixture fails the suite until it is classified there.

   - `verify.sh` (executable; `chmod +x`) — start from the harness below.

3. **Fill in the assertions.** Read the command's actual output shape and assert
   the real user-facing behavior (the ready-line banner, the served response, a
   404/502 baseline). Cover the new behavior AND a baseline/negative case.

4. **Make the source files tracked.** `tests/integration/.gitignore` ignores
   `*.js` / `*.d.ts` and (for some) `pnpm-lock.yaml`. Confirm your `.ts` sources
   are tracked (`git add -f` a handler `*.js`, or add a `!subdir/*.js` negation
   to the fixture's own `.gitignore`) — it must build on a fresh checkout and in CI.

5. **RUN it** (NEVER skip — the whole point is to exercise the real path):

   ```
   /run-integ <name>
   ```

   It does the Docker pre-flight, `verify.sh`, the post-run Docker sweep and the
   AWS orphan sweep (which runs for EVERY fixture — `aws-orphan-sweep.sh`
   derives ownership itself rather than globbing the name, and makes no AWS call
   for a fixture that owns nothing), then sets the `integ` marker on a clean
   run. Fix what it surfaces and re-run until green with 0 orphans.

## verify.sh harness

Start from a real one — `tests/integration/local-start-cloudfront-s3-from-cfn-stack/verify.sh`
for the `*-from-cfn-stack` shape, any `local-invoke-*` fixture for the
run-to-completion shape — and adapt `<CMD>`, `<STACK>`, ports and assertions.
For a Docker-only fixture, drop its `cdk deploy` / `cdk destroy` blocks.

Whatever you copy, the script MUST keep:

- `set -euo pipefail`, and `CLI="node $(git rev-parse --show-toplevel)/dist/cli.js"`
  — never a globally installed `cdkl`.
- A `cleanup()` that seeds `rc=$?` FIRST, stops the server, `cdk destroy`s the
  stack when this run created it (`WE_CREATED_STACK=1`), removes its temp files
  and `exit "${rc}"`, armed with `trap cleanup EXIT INT TERM`. Without INT/TERM
  a killed run leaks containers and a real stack; without the `rc` seed the trap
  exits 0 and the fixture reports green.
- A `fail()` that dumps the captured CLI output to stderr and exits 1.
- A bounded ready-line wait that ALSO re-checks `kill -0 "${CDKL_PID}"` each
  iteration, so a server that died is reported as "exited before it was ready"
  rather than timing out.
- For `*-from-cfn-stack`, a pre-flight refusal when the target stack already
  exists — never deploy on top of someone else's stack.

Pick the assertion shape for the command's surface. `start-api` /
`start-cloudfront` declare `--port` and serve over HTTP, so boot and `curl`.
`start-service` / `start-alb` use listener / `--host-port` ports (no `--port`).
`invoke` / `run-task` / `list` / `invoke-agentcore` are not servers — run
`${CLI} <cmd> ...` to completion (or to a ready banner for a streaming run) and
assert on its captured **stdout**. Capture through the `capture` helper (copy
`CANONICAL_CAPTURE` from `tests/unit/integ-verify-capture-shape.test.ts`, with
its trap-held `CDKL_STDERR`), never `$(... 2>/dev/null | tail -1)` — under
pipefail that shape aborts at the assignment with no diagnostic, and that same
file refuses it tree-wide.

## Important

- **Always RUN the fixture (step 5).** A scaffold that never ran proves nothing.
- **English only** for all committed artifacts (see `.claude/AGENTS.md`).
