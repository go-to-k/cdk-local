---
name: check-cdkd-parity
description: Triggers when a PR adds a new subcommand factory, CLI option, public helper, or behavior change to cdk-local that cdkd (host CLI) may need to inherit. Walks the diff and pins each category to "exported via internal.ts / inside add<Cmd>SpecificOptions / cdkd notified" — sets the cdkd-parity marker so gh pr create can fire.
---

# cdkd Parity Check

cdk-local is a library + CLI; cdkd embeds it as a library. Whenever
cdk-local extends its public surface — new subcommand, new option, new
exported helper, behavior change — cdkd has to either import the new
helper, wrap the new subcommand, inherit the new option block, or
update its own behavior to match. The mechanical part is covered by
per-command unit-test contracts; this skill walks the judgment-level
questions that are easy to skip: did you export it, did you put it in
the right helper, did you tell the host?

This skill is consumed by `cdkd-parity-gate.sh`, which blocks
`gh pr create` when the diff touches the gate's scope and this marker
is stale.

## Pre-flight scope check

Determine whether the PR's diff actually touches cdk-local's library
surface. Run from the worktree:

```bash
git diff origin/main...HEAD --name-only \
  | grep -E '^src/cli/commands/|^src/internal\.ts$|^src/index\.ts$' \
  || echo "out-of-scope"
```

If the output is `out-of-scope` (the diff touches none of the gate's
paths), write one line — "no library-surface touched; cdkd-parity n/a"
— set the marker (see "Commit-gate marker" below), and stop. Do NOT
walk the categories below for unrelated edits; the marker is correct
to set because there is nothing for cdkd to inherit.

The diff base is `origin/main`, not local `main` (see memory:
`feedback_diff_base_origin_main`).

## Category 1: New subcommand factory?

A new file like `src/cli/commands/local-<verb>.ts` that exports a
`createLocal<Verb>Command` factory is a new public CLI subcommand.
cdkd embeds these via `src/index.ts` and wraps them with host-side
options.

**Detect**:

```bash
git diff origin/main...HEAD --name-only --diff-filter=A \
  | grep -E '^src/cli/commands/local-[^/]+\.ts$'
```

Empty output → no new subcommand → skip to Category 2.

For each new factory file:

- [ ] **Exported from `src/index.ts`?** — host CLIs reach the factory
      via the public library entry. Confirm:

      ```bash
      grep -nE 'createLocal[A-Z][A-Za-z]*Command' src/index.ts
      ```

      The new factory name must appear in the export list. If it
      doesn't, add the export before setting the marker.

- [ ] **cdkd notified?** — this is a manual step. Either file an issue
      on the cdkd repo describing the new subcommand and the wrap point
      (`createLocal<Verb>Command` factory + suggested host-side options
      block), OR cross-link this PR in an existing tracking issue. Note
      which path you took in the PR body.

## Category 2: New CLI option on an existing command?

A new `addOption(new Option(...))` call inside an existing
`src/cli/commands/local-*.ts` is a new flag the host CLI must inherit.

**Detect**:

```bash
git diff origin/main...HEAD -- 'src/cli/commands/*.ts' \
  | grep -E '^\+.*addOption.*new Option'
```

Empty output → no new option → skip to Category 3.

For each added option:

- [ ] **Added inside the relevant `add<Cmd>SpecificOptions` helper, NOT
      inline in `create<Cmd>Command`?** — the helper is the seam cdkd
      reuses to inherit the option block without duplicating it.
      Inline-in-factory means the host can't pick up the option without
      copy-paste. Read the diff context — the `+addOption(...)` should
      sit inside an `add<Cmd>SpecificOptions(cmd: Command)` function,
      not in the factory body.

- [ ] **Contract test still passes?** — the per-command option-contract
      tests assert that the helper's output matches the factory's
      attached options. `vp run test` covers this; the `check` marker's
      freshness already implies this passed. If the option was added
      inline in the factory, the contract test will catch it as a
      drift.

## Category 3: New public helper / type in `src/local/**`?

A new exported function / class / type under `src/local/**` is a
low-level building block. Host CLIs reach these via the
`cdk-local/internal` subpath (`src/internal.ts`); the main entry
`src/index.ts` does NOT re-export them. See memory:
`feedback_internal_exports_placement`.

**Detect**:

```bash
git diff origin/main...HEAD --name-only -- 'src/local/**'
```

Empty output → no helper changes → skip to Category 4.

For each new export in `src/local/**`:

- [ ] **Exported from `src/internal.ts`?** — the host reaches it via
      `import { ... } from 'cdk-local/internal'`. Confirm:

      ```bash
      grep -nE "from '\./local/" src/internal.ts
      ```

      The new symbol must show up either as a named re-export or via a
      `export *` line covering its module.

- [ ] **JSDoc explains the host-side use case?** — `internal.ts` has no
      semver guarantee, so the JSDoc on each exported symbol is the
      only contract a host author has. Read the new symbol's JSDoc and
      confirm it names the intended host-side use case (e.g. "consumed
      by cdkd's `<command>` provider to ..."). Pure-implementation
      docstrings ("returns a Foo") are not sufficient.

## Category 4: Behavior change in an existing command?

Behavior changes — changed defaults, new validation, changed output
format, changed exit codes, changed error messages a host might match
on — are silent breakage for cdkd. Purely additive changes
(Categories 1-3) do not count here.

**Detect**: walk the diff yourself. There is no mechanical grep for
this — read every changed `src/cli/commands/*.ts` and every changed
`src/local/**` file and ask "does the externally observable behavior
change for an existing input?".

For each behavior change:

- [ ] **cdkd informed?** — file an issue on the cdkd repo OR cross-link
      this PR in an existing tracking issue. The issue must name the
      old behavior, the new behavior, and the migration cdkd needs to
      apply (if any). Without this, cdkd's next release silently ships
      the changed behavior with no host-side adjustment.

- [ ] **Migration note in PR body?** — the PR body must call out the
      behavior change in a section labeled `Behavior change` (or
      `Breaking change` when appropriate), so anyone bumping the
      `cdk-local` version in cdkd reads it without digging through the
      diff.

## Final step: set the marker

Only call `mise exec -- markgate set cdkd-parity` when EVERY check
above passed or was explicitly marked N/A. If any item is unresolved,
skip the marker, list the unresolved items, and stop — the
`cdkd-parity-gate.sh` hook will then correctly block `gh pr create`
until the walk-through is repeated.

```bash
mise exec -- markgate set cdkd-parity
```

Run from the same worktree (cwd) where `gh pr create` will eventually
be invoked. See `.claude/rules/hooks.md` "Markgate-backed gates" for
the per-worktree marker convention.

## Important

- English-only for all committed artifacts (see `.claude/CLAUDE.md`
  "Workflow rules").
- Do NOT reference cdkd internal implementation in cdk-local artifacts
  — the dependency direction is `cdkd -> cdk-local`. The skill talks
  about "notify cdkd" / "host CLI", not about cdkd's deploy or
  provider system.
- The "notify cdkd" steps are manual — this skill does NOT file the
  issue / send the message itself; it prompts the user to do so and
  records the decision in the PR body.
