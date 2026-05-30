# Contributing to cdk-local

Thanks for your interest in cdk-local! This guide covers what you need
to know to land a change.

## Dev environment

cdk-local uses [mise](https://mise.jdx.dev) to pin the dev toolchain
(Node 24.x, [pnpm](https://pnpm.io), [vite-plus](https://github.com/sapphi-red/vite-plus),
[markgate](https://github.com/go-to-k/markgate)). At the repo root:

```bash
mise install     # installs Node 24.x, pnpm, vp, markgate
mise trust       # one-time, when you check out a fresh clone
pnpm install     # workspace deps
```

The shipped runtime targets **Node 20+**; CI runs the Node 20 / 22 / 24
matrix.

## Build, lint, test

```bash
# Unified quality check (typecheck + lint + format-check) — fast
vp run check

# Build dist/cli.js + dist/index.js
vp run build

# Unit tests (vitest)
vp run test

# Full check + tests + build (what CI runs)
vp run verify
```

When iterating, `vp run dev` runs the build in watch mode.

## Integration tests

Per-fixture real-Docker end-to-end tests live under
`tests/integration/local-*`. Each fixture has its own `verify.sh`
that runs the CLI against a deployed-style CDK app. Some fixtures
(named `*-from-cfn-stack`) deploy a real CloudFormation stack via the
upstream `cdk` CLI as part of the setup; those require AWS credentials.

Always run integ tests via the `/run-integ` skill rather than calling
`verify.sh` directly:

```text
/run-integ local-start-api
```

The skill wraps the run with Docker pre-flight, the verify.sh
invocation, and a post-run orphan sweep. Bypassing it risks setting
the integ marker on incomplete verification.

## Workflow rules

- **English only for committed artifacts**: source, comments, docs,
  commit messages, PR titles / bodies, and GitHub issue text.
- **Never commit directly to `main`**. Open a feature branch + PR.
  When using Claude Code, feature branches live under
  `.claude/worktrees/<branch>/`.
- **Squash merge**: `gh pr merge <N> --squash --delete-branch` keeps
  history flat.
- **Always add unit tests** for new functionality. `tests/unit/**`
  mirrors `src/**`. Mock external boundaries
  (`@aws-cdk/toolkit-lib`, the Docker CLI, AWS SDK) with `vi.mock` /
  `vi.hoisted`.

## Commit messages

Commits follow [Angular Conventional Commits](https://www.conventionalcommits.org/)
(`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, etc.).
[semantic-release](https://github.com/semantic-release/semantic-release)
uses these to drive the next version + changelog when the release
workflow fires from `main`.

Examples:

```text
feat(start-api): add --strict-sigv4 fail-closed enforcement
fix(invoke): keep SecureString SSM values off the docker run argv
docs: lead getting-started with the interactive picker form
```

## Opening a PR

1. Branch off `origin/main`.
2. Run `vp run verify` locally — that is what CI gates on.
3. For source changes, add unit tests under `tests/unit/<mirroring-path>`.
4. For CLI-surface changes, add or update an integ fixture under
   `tests/integration/local-*` and run it via `/run-integ`.
5. Push and open the PR with `gh pr create`. The default template
   asks for a Summary + Test plan; fill both.

CI runs `vp run verify` on Node 20 / 22 / 24. The CHANGELOG and
GitHub release are produced automatically by semantic-release on
merge to `main`.

## Scope reminders for docs / messages

- cdk-local runs your **application compute** locally; it does NOT
  emulate AWS managed services. Pair it with a service emulator like
  LocalStack if you need offline DynamoDB / S3 / etc.
- The only sanctioned tool comparison in committed docs is to
  `sam local` (same compute-locally category). Please don't add side-by-side
  tables vs other tools.

## Reporting bugs / requesting features

- File issues at <https://github.com/go-to-k/cdk-local/issues>. Issue
  templates (`bug_report` and `feature_request`) live under
  `.github/ISSUE_TEMPLATE/`.

Thanks again — every contribution helps.
