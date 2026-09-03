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

Re-run `mise install` whenever a pull changes `.mise.toml` — the pinned
markgate version and `.markgate.yml` move together, and an older binary
rejects a newer config outright rather than degrading gracefully.

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

# Hook / integ-lib shell suites (bash) — a separate task from `vp run test`
vp run test:hooks

# Full check + tests + hook suites + build (what CI's check job runs)
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

### You are not required to run them

CI does not run the integration fixtures, and you do not need to run
them to contribute. If your change needs integration coverage (see
below), just say so in your PR — the maintainer runs the required
fixtures before merging, and the maintainer's merge gates block the
merge until they pass, so coverage is guaranteed either way. This
matters especially for the `*-from-cfn-stack` fixtures (they deploy
real AWS resources and incur real charges) and for contributors
without a local Docker daemon.

### When is an integration run needed, and which one?

Which verification a PR needs is derived mechanically from the paths
it touches. The path lists are the gate scopes in
[`.markgate.yml`](.markgate.yml) — the maintainer's merge gates read
exactly those, so that file is the source of truth. In summary:

| Your PR touches | Required verification (gate) |
| --- | --- |
| Any `src/**` or `tests/integration/**` file | A `local-*` fixture run covering the changed surface (`integ`) |
| A NEW `src/cli/commands/local-<verb>.ts` subcommand factory | A new integ fixture for the subcommand, shipped in the same PR — the maintainer can run it for you (`create-integ`) |
| `src/cli/commands/**`, `src/index.ts`, or `src/internal.ts` | A host-CLI embedding parity check, run by the maintainer (`cdkd-parity`) |
| Docs / tooling only | No integration run — unit tests and CI are enough |

When in doubt, open the PR and ask; the maintainer will pick and run
the right fixtures.

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
[release-please](https://github.com/googleapis/release-please)
uses these to drive the next version + changelog: pushes to `main`
create/update a single standing `chore(release): <version>` PR, and
merging that PR cuts the tag, the GitHub release, and the npm publish
(releases are batched, not per-merge). cdk-local deliberately stays at
major version 0 — `bump-minor-pre-major` maps breaking changes to minor
bumps, and the publish job refuses any non-0.x tag.

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
   `tests/integration/local-*` and run it via `/run-integ` — or ask in
   the PR and the maintainer runs it for you (see "Integration tests").
5. Push and open the PR with `gh pr create`. The default template
   asks for a Summary + Test plan; fill both.

CI's `check-build-test` job runs the same four steps `vp run verify`
chains; a second job then builds and smoke-runs `dist/cli.js` on Node
20 / 22 / 24. The CHANGELOG and
GitHub release are produced by release-please when the maintainer
merges the standing `chore(release)` PR — an ordinary merge to `main`
only updates that PR and publishes nothing by itself.

## Scope reminders for docs / messages

- cdk-local runs your **application compute** locally; it does NOT
  emulate AWS managed services. Don't recommend third-party emulators
  or other tools in committed docs.
- The only sanctioned tool comparison in committed docs is to
  `sam local` (same compute-locally category). Don't name, recommend,
  or compare against any other third-party product — no side-by-side
  tables, no "pair with" / "use alongside" recommendations, no
  parenthetical mentions, no examples.

## Reporting bugs / requesting features

- File issues at <https://github.com/go-to-k/cdk-local/issues>. Issue
  templates (`bug_report` and `feature_request`) live under
  `.github/ISSUE_TEMPLATE/`.

Thanks again — every contribution helps.
