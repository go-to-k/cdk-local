# Integration Test Creator

Scaffold a NEW `tests/integration/<name>/` fixture, fill in its stack +
assertions, RUN it, and record the `create-integ` marker.

cdk-local's integ fixtures are the lifeline — they exercise the actual
user-facing behavior against real Docker (and, for `*-from-cfn-stack`
fixtures, a real deployed CloudFormation stack via the upstream `cdk` CLI).
Every new subcommand factory (`src/cli/commands/local-<verb>.ts`) is
brand-new behavior with no existing fixture, so it MUST ship its own —
`create-integ-gate.sh` blocks `gh pr create` until this marker is fresh.

Use this skill whenever you add a new command, or a new feature that genuinely
needs its OWN fixture (a new runtime path that no existing fixture exercises).
A new flag on an existing command usually reuses that command's fixture —
extend it instead.

## Arguments

- `name`: the fixture directory name under `tests/integration/`, by convention
  `local-<command>[-<scenario>]` (e.g. `local-start-foo`,
  `local-start-foo-from-cfn-stack`). If omitted, ask which command/behavior the
  fixture covers and derive the name.

## Steps

1. **Decide the shape.** Two kinds:
   - **Docker-only** (most): the command runs containers locally; `verify.sh`
     boots `cdkl <cmd>` against a synthesized fixture and asserts the result.
   - **`*-from-cfn-stack`** (real AWS): the command needs a deployed stack;
     `verify.sh` does `cdk deploy` first, runs `cdkl <cmd> --from-cfn-stack`,
     then `cdk destroy`. Name it with the `-from-cfn-stack` suffix so
     `/run-integ` runs the AWS orphan-stack sweep.

2. **Scaffold the files** under `tests/integration/<name>/`:

   - `cdk.json`:
     ```json
     {
       "app": "node bin/app.ts"
     }
     ```

   - `package.json` — **pin `packageManager`** so `vp install` is a no-op and
     does NOT dirty the file on the first integ run (the recurring churn trap).
     Keep the trailing newline:
     ```json
     {
       "name": "cdkl-integ-<name>",
       "version": "1.0.0",
       "private": true,
       "description": "Integration test fixture for <what it covers>",
       "scripts": {
         "build": "tsc",
         "watch": "tsc -w"
       },
       "devDependencies": {
         "@types/node": "^20.0.0",
         "typescript": "^5.0.0"
       },
       "dependencies": {
         "aws-cdk-lib": "^2.169.0",
         "constructs": "^10.0.0"
       },
       "type": "module",
       "packageManager": "pnpm@11.5.1"
     }
     ```
     Match the `packageManager` version to what `vp install` would write (run
     `vp install` once in a throwaway dir if unsure; it must match exactly, or
     it re-churns). Copy `tsconfig.json` verbatim from an existing fixture
     (e.g. `local-start-cloudfront-s3-from-cfn-stack/tsconfig.json`).

   - `bin/app.ts`:
     ```ts
     #!/usr/bin/env node
     import * as cdk from 'aws-cdk-lib';
     import { <Stack> } from '../lib/<name>-stack.ts';

     const app = new cdk.App();
     new <Stack>(app, '<FixtureStackName>', {
       description: 'Fixture stack for cdkl <cmd> integ test',
     });
     ```

   - `lib/<name>-stack.ts` — the minimal CDK resources the command exercises.
     Keep it as small as possible (a `*-from-cfn-stack` fixture that does NOT
     need a slow resource deployed should gate it behind a `withX` context flag,
     like the cloudfront fixtures deploy a bucket-only stack and synth the
     distribution locally only under `-c withDistribution=true`).

   - `verify.sh` (executable; `chmod +x`) — start from the harness below and
     fill in the deploy (for `*-from-cfn-stack`) + the boot + assertions.

3. **Fill in the assertions.** Read the command's actual output shape and assert
   the real user-facing behavior (the ready-line banner, the served response, a
   404/502 baseline). Cover the new behavior AND a baseline/negative case.

4. **Make the source files tracked.** `tests/integration/.gitignore` ignores
   `*.js` / `*.d.ts` and (for some) `pnpm-lock.yaml`. Confirm your `.ts` sources
   are tracked (`git add -f` a handler `*.js` if your fixture ships one, or add a
   `!subdir/*.js` negation to the fixture's own `.gitignore`). The fixture must
   build on a fresh checkout / in CI.

5. **RUN it** (NEVER skip — the whole point is to exercise the real path):
   ```
   /run-integ <name>
   ```
   `/run-integ` does the Docker pre-flight, `verify.sh`, the post-run orphan
   sweep (+ AWS stack sweep for `*-from-cfn-stack`), and sets the `integ` marker
   on a clean run. Fix anything it surfaces and re-run until green with 0
   orphans.

6. **Record the `create-integ` marker** — ONLY after `/run-integ` finished
   clean (verify.sh exit 0, 0 docker orphans, 0 AWS orphan stacks):
   ```bash
   mise exec -- markgate set create-integ
   ```
   Skip this if the run was not clean — a stale marker correctly keeps
   `gh pr create` blocked until the fixture actually passes.

## verify.sh harness

The repetitive shell scaffold (stop / cleanup-trap / fail / a boot-and-curl
helper / the ready-line wait). Fill in `<CMD>`, `<STACK>`, ports, and the
assertions. For a Docker-only fixture, drop the `cdk deploy` / `cdk destroy`
blocks.

`boot_and_get` below is the **HTTP-server shape** — it fits `start-api` /
`start-cloudfront` (they declare `--port` and serve over HTTP). A non-serving
command asserts differently: `start-service` / `start-alb` use listener /
`--host-port` ports (no `--port`); `invoke` / `run-task` / `list` /
`invoke-agentcore` are not servers — run `${CLI} <cmd> ...` to completion (or
until a ready banner for a streaming run) and assert on its captured **stdout**
(the response payload / the `==> ... passed` lines), not a curl. Pick the shape
that matches your command's surface.

```bash
#!/usr/bin/env bash
#
# Real-Docker validation for `cdkl <CMD>` (<what it covers>).
# Run via `/run-integ <name>`.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="<FixtureStackName>"
TARGET="${STACK}/<Construct>"
PORT=18500

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/<name>"
CLI="node ${REPO_ROOT}/dist/cli.js"

CDKL_PID=""
WE_CREATED_STACK=0          # *-from-cfn-stack only
OUT_FILE="$(mktemp)"
BODY_FILE="$(mktemp)"

stop_server() {
  if [ -n "${CDKL_PID}" ] && kill -0 "${CDKL_PID}" 2>/dev/null; then
    kill -TERM "${CDKL_PID}" 2>/dev/null || true
    for _ in $(seq 1 60); do kill -0 "${CDKL_PID}" 2>/dev/null || break; sleep 0.25; done
    kill -KILL "${CDKL_PID}" 2>/dev/null || true
  fi
  CDKL_PID=""
}

cleanup() {
  rc=$?
  stop_server
  if [ "${WE_CREATED_STACK}" -eq 1 ]; then
    (cd "${TEST_DIR}" && cdk destroy "${STACK}" --force --region "${REGION}" \
      --no-version-reporting --no-asset-metadata --no-path-metadata) || true
  fi
  rm -f "${OUT_FILE}" "${BODY_FILE}" "${BODY_FILE}.code"
  exit "${rc}"
}
trap cleanup EXIT INT TERM

fail() { echo "[verify] FAIL: $*" >&2; cat "${OUT_FILE}" >&2 || true; exit 1; }

# boot_and_get <port> <uri> <body-out> [extra cdkl flags...]
boot_and_get() {
  local port="$1" uri="$2" body_out="$3"; shift 3
  : > "${OUT_FILE}"
  lsof -ti "tcp:${port}" >/dev/null 2>&1 && lsof -ti "tcp:${port}" | xargs -r kill -9 || true
  ${CLI} <CMD> "${TARGET}" --port "${port}" "$@" > "${OUT_FILE}" 2>&1 &
  CDKL_PID=$!
  local booted=0
  for _ in $(seq 1 240); do
    if grep -q "<READY LINE>" "${OUT_FILE}"; then booted=1; break; fi
    kill -0 "${CDKL_PID}" 2>/dev/null || fail "server exited before it was ready"
    sleep 0.5
  done
  [ "${booted}" -eq 1 ] || fail "server did not print its ready banner in time"
  curl -s -o "${body_out}" -w '%{http_code}' "http://127.0.0.1:${port}${uri}" > "${body_out}.code" || true
  stop_server
}

echo "[verify] step 1: install + build cdk-local"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)
cd "${TEST_DIR}"
[ -d node_modules ] || vp install --prefer-offline

# --- *-from-cfn-stack only: deploy first ---
# if aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" >/dev/null 2>&1; then
#   echo "[verify] FAIL: ${STACK} already exists — clean up first"; exit 1; fi
# WE_CREATED_STACK=1
# cdk deploy "${STACK}" --require-approval never --no-version-reporting \
#   --no-asset-metadata --no-path-metadata --region "${REGION}"

echo "[verify] step 2: <assert the new behavior>"
boot_and_get "${PORT}" "/" "${BODY_FILE}"
[ "$(cat "${BODY_FILE}.code")" = "200" ] || fail "GET / did not return 200"
# grep -qi "<expected body>" "${BODY_FILE}" || fail "..."

echo "[verify] PASS: <one-line summary of what was proven>"
```

## Important

- **Always RUN the fixture (step 5) before recording the marker.** A scaffold
  that never ran proves nothing. `create-integ` is earned by a clean
  `/run-integ`, not by writing files.
- **`packageManager` is pinned on purpose** — without it `vp install` adds it on
  the first run, dirtying `package.json`, staling the `integ` marker, and
  leaking into the PR. Pinning it makes the install a no-op.
- **English only** for all committed artifacts (see `.claude/CLAUDE.md`).
- This skill is the ONLY legitimate setter of `create-integ`; never
  `markgate set create-integ` from a shell to bypass `create-integ-gate.sh`.
