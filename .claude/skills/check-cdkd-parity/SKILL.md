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
surface. Two signals trigger the gate:

1. Any path under `src/cli/commands/**`, `src/internal.ts`, or
   `src/index.ts` (the library-surface scope).
2. A NEW `.ts` file added under `src/local/**` (`--diff-filter=A`).
   Edits to existing `src/local/**` files are deliberately out of
   scope — internal refactors are noise — but a brand-new file is
   the strongest signal that a host-facing helper may have been
   introduced without an explicit `src/internal.ts` re-export.

Run from the worktree:

```bash
{
  git diff origin/main...HEAD --name-only \
    | grep -E '^src/cli/commands/|^src/internal\.ts$|^src/index\.ts$'
  git diff origin/main...HEAD --diff-filter=A --name-only \
    | grep -E '^src/local/.+\.ts$'
} | head -1 \
  || echo "out-of-scope"
```

If the output is `out-of-scope` (neither signal fires), write one
line — "no library-surface touched; cdkd-parity n/a" — set the
marker (see "Final step" below), and stop. Do NOT walk the
categories below for unrelated edits; the marker is correct to set
because there is nothing for cdkd to inherit.

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

- [ ] **cdkd tracking issue filed?** — REQUIRED for a new subcommand. File
      (or reuse) the cdkd issue per "File the cdkd tracking issue" below,
      labeling this as cat 1 "wrap the new subcommand
      (`createLocal<Verb>Command`) — REQUIRED". The `cdkd-parity-gate.sh`
      hook hard-blocks `gh pr create` until `.cdkd-parity-issue` carries the
      issue URL.

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
# A new file in src/local/** is the strongest signal — it's also the
# scope trigger that fires the gate independently of internal.ts edits.
git diff origin/main...HEAD --diff-filter=A --name-only \
  | grep -E '^src/local/.+\.ts$'
# And any edits to src/local/** files that may have added exports.
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

- [ ] **cdkd tracking issue filed?** — file (or reuse) the cdkd issue per
      "File the cdkd tracking issue" below, labeling this as cat 3 "new
      internal primitive available — OPTIONAL: adopt if useful, cdkd
      decides". Additive, so cdkd's build won't break by not adopting —
      but filing surfaces it so cdkd makes the adoption call, instead of
      cdk-local silently deciding for it. (The hook does NOT hard-block
      cat 3; the marker covers it.)

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

- [ ] **cdkd tracking issue filed?** — REQUIRED for a behavior change. File
      (or reuse) the cdkd issue per "File the cdkd tracking issue" below,
      labeling this as cat 4 "behavior change — adapt — REQUIRED" and naming
      the old behavior, the new behavior, and the migration cdkd needs to
      apply. (The hook does NOT mechanically detect cat 4; the marker covers
      it — so filing here is on your honor, but it is REQUIRED.)

- [ ] **Migration note in PR body?** — the PR body must ALSO call out the
      behavior change in a section labeled `Behavior change` (or
      `Breaking change` when appropriate), so anyone bumping the
      `cdk-local` version in cdkd reads it without digging through the
      diff.

## File the cdkd tracking issue (REQUIRED when any category applies)

When ANY of categories 1-4 above applies, you MUST file a tracking issue on
the `go-to-k/cdkd` repo so the cdkd agent can inherit the change by working
its own issue queue — without having to actively watch cdk-local. cdk-local's
job is to SURFACE the change; cdkd decides whether/how to follow.

This is no longer optional or a PR-body note. The `cdkd-parity-gate.sh` hook
hard-blocks `gh pr create` for category 1 (new subcommand) and category 2 (new
option) until the per-worktree sentinel `.cdkd-parity-issue` carries a
`github.com/go-to-k/cdkd/issues/` reference. Categories 3 and 4 are filed too
(the gate relies on the marker for those, but you still file).

**Idempotent — reuse the sentinel; never open a duplicate on a re-run:**

```bash
SENTINEL=".cdkd-parity-issue"   # per-worktree, gitignored (like .markgate-pr-review-sha)
if [ -f "$SENTINEL" ] && grep -q 'github.com/go-to-k/cdkd/issues/' "$SENTINEL"; then
  echo "Reusing existing cdkd issue: $(cat "$SENTINEL")"
  # If the applicable categories changed since it was filed, append an update
  # with: gh issue comment "$(cat "$SENTINEL")" --repo go-to-k/cdkd --body-file <file>
else
  # Build the body in a file (NEVER inline bare #N — the cross-repo auto-link
  # trap; reference the cdk-local PR/branch as a FULL GitHub URL). Label EACH
  # applicable category with its host action:
  #   cat 1 -> "wrap the new subcommand (createLocal<Verb>Command) — REQUIRED"
  #   cat 2 -> "inherit the new option (add<Cmd>SpecificOptions) — REQUIRED"
  #   cat 3 -> "new internal primitive available — OPTIONAL: adopt if useful, cdkd decides"
  #   cat 4 -> "behavior change — adapt — REQUIRED" (name old vs new + migration)
  cat > /tmp/cdkd-parity-body.md <<'BODY'
## Follow cdk-local: <one-line summary>

cdk-local changed its host-facing surface. All changes are additive unless a
category-4 item below says otherwise. cdk-local PR:
https://github.com/go-to-k/cdk-local/pull/<N>  (or the branch URL pre-merge)

<one bullet per applicable category, each with the host-action label above>
BODY
  url=$(gh issue create --repo go-to-k/cdkd \
    --title "Follow cdk-local: <one-line summary>" \
    --body-file /tmp/cdkd-parity-body.md)
  printf '%s\n' "$url" > "$SENTINEL"
  echo "Filed cdkd tracking issue: $url"
fi
```

If `gh issue create` is denied (permission / offline), say so explicitly and
STOP — do NOT hand-write the sentinel to satisfy the gate. The whole point is
that the issue actually exists. (The committed `permissions.allow` in
`.claude/settings.json` pre-authorizes `gh issue create --repo go-to-k/cdkd`,
so this should not normally prompt.)

## Final step: set the marker

Only call `mise exec -- markgate set cdkd-parity` when EVERY check
above passed or was explicitly marked N/A, AND — when any category applied —
the cdkd tracking issue has been filed and `.cdkd-parity-issue` carries its
URL. If any item is unresolved, skip the marker, list the unresolved items,
and stop — the `cdkd-parity-gate.sh` hook will then correctly block
`gh pr create` until the walk-through is repeated.

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
- Filing the cdkd tracking issue is done BY this skill (auto `gh issue
  create --repo go-to-k/cdkd`, idempotent via the `.cdkd-parity-issue`
  sentinel), not left as a manual prompt — that is the change that makes
  cdkd follow-up actually happen (it never did under the old manual /
  PR-body-note path). cat 1 / cat 2 are hard-blocked by the gate until the
  sentinel carries the issue URL; cat 3 / cat 4 are filed on the marker's
  honor. The committed `permissions.allow` in `.claude/settings.json`
  pre-authorizes the scoped `gh issue create` / `gh issue comment`.
