---
name: check-cdkd-parity
description: Walk a PR that adds a new subcommand factory, CLI option, public helper, or behavior change to cdk-local, pinning each category to "exported via internal.ts / inside add<Cmd>SpecificOptions / cdkd notified". Run it before opening a PR that touches the library surface cdkd embeds.
---

# cdkd Parity Check

cdk-local is a library + CLI; cdkd embeds it as a library. Whenever cdk-local
extends its public surface — new subcommand, option, exported helper, or a
behavior change — cdkd has to wrap, import, inherit or adapt. Per-command
unit-test contracts cover the mechanical part; this skill walks the
judgment-level questions that are easy to skip: did you export it, did you put
it in the right helper, did you tell the host? Recommended procedure — nothing
blocks on it.

## Pre-flight scope check

Two signals put a PR in scope:

1. Any path under `src/cli/commands/**`, `src/internal.ts`, or `src/index.ts`
   (the library surface itself).
2. A NEW `.ts` file under `src/local/**` (`--diff-filter=A`). Edits to existing
   `src/local/**` files are deliberately out of scope — internal refactors are
   noise — but a brand-new file is the strongest signal that a host-facing helper
   arrived without an `src/internal.ts` re-export.

Run from the worktree (the diff base is `origin/main`, not local `main`):

```bash
{
  git diff origin/main...HEAD --name-only \
    | grep -E '^src/cli/commands/|^src/internal\.ts$|^src/index\.ts$'
  git diff origin/main...HEAD --diff-filter=A --name-only \
    | grep -E '^src/local/.+\.ts$'
} | head -1 \
  || echo "out-of-scope"
```

On `out-of-scope`, write one line — "no library surface touched; parity n/a" —
and stop. Do NOT walk the categories for unrelated edits.

## Category 1: New subcommand factory?

A new `src/cli/commands/local-<verb>.ts` exporting a `createLocal<Verb>Command`
factory is a new public CLI subcommand; cdkd embeds these via `src/index.ts` and
wraps them with host-side options.

```bash
git diff origin/main...HEAD --name-only --diff-filter=A \
  | grep -E '^src/cli/commands/local-[^/]+\.ts$'
```

Empty → skip to Category 2. Per new factory file:

- [ ] **Exported from `src/index.ts`?** Host CLIs reach the factory through the
      public library entry — `grep -nE 'createLocal[A-Z][A-Za-z]*Command' src/index.ts`
      must show the new name. If it does not, add the export.
- [ ] **cdkd tracking issue filed?** REQUIRED for a new subcommand — label it
      cat 1, "wrap the new subcommand (`createLocal<Verb>Command`) — REQUIRED".

## Category 2: New CLI option on an existing command?

A new `addOption(new Option(...))` inside an existing `src/cli/commands/local-*.ts`
is a flag the host CLI must inherit.

```bash
git diff origin/main...HEAD -- 'src/cli/commands/*.ts' \
  | grep -E '^\+.*addOption.*new Option'
```

Empty → skip to Category 3. Per added option:

- [ ] **Added inside the relevant `add<Cmd>SpecificOptions` helper, NOT inline in
      `create<Cmd>Command`?** The helper is the seam cdkd reuses to inherit the
      option block without duplicating it; inline-in-factory leaves the host only
      copy-paste. In the diff context, `+addOption(...)` must sit inside
      `add<Cmd>SpecificOptions(cmd: Command)`.
- [ ] **Contract test still passes?** The per-command option-contract tests
      assert the helper's output matches the factory's attached options, so they
      catch an inline addition as drift. `vp run test` covers them.
- [ ] **cdkd tracking issue filed?** REQUIRED — label it cat 2, "inherit the new
      option (`add<Cmd>SpecificOptions`) — REQUIRED".

## Category 3: New public helper / type in `src/local/**`?

A new exported function / class / type under `src/local/**` is a low-level
building block. Hosts reach these through the `cdk-local/internal` subpath
(`src/internal.ts`); the main entry `src/index.ts` does NOT re-export them.

```bash
git diff origin/main...HEAD --diff-filter=A --name-only | grep -E '^src/local/.+\.ts$'
git diff origin/main...HEAD --name-only -- 'src/local/**'
```

Empty → skip to Category 4. For each new export:

- [ ] **Exported from `src/internal.ts`?** `grep -nE "from '\./local/" src/internal.ts`
      — the new symbol must appear as a named re-export or under an `export *`
      line covering its module.
- [ ] **JSDoc explains the host-side use case?** `internal.ts` carries no semver
      guarantee, so the JSDoc is the only contract a host author has: it must
      name the intended host-side use ("consumed by cdkd's `<command>` provider
      to …"). A pure-implementation docstring ("returns a Foo") is not enough.
- [ ] **cdkd tracking issue filed?** Label it cat 3, "new internal primitive
      available — OPTIONAL: adopt if useful, cdkd decides". Additive, so cdkd's
      build cannot break by not adopting; filing just lets cdkd make the call.

## Category 4: Behavior change in an existing command?

Changed defaults, new validation, changed output format, changed exit codes,
changed error messages a host might match on — all silent breakage for cdkd.
Purely additive changes (categories 1-3) do not count here.

**Detect**: no mechanical grep exists. Read every changed
`src/cli/commands/*.ts` and `src/local/**` file and ask "does the observable
behavior change for an existing input?".

For each behavior change:

- [ ] **cdkd tracking issue filed?** REQUIRED — label it cat 4, "behavior change
      — adapt — REQUIRED", naming the old behavior, the new behavior, and the
      migration cdkd needs.
- [ ] **Migration note in the PR body?** Under a `Behavior change` (or
      `Breaking change`) heading, so anyone bumping the `cdk-local` version in
      cdkd reads it without digging through the diff.

## File the cdkd tracking issue (when any category applies)

cdk-local's job is to SURFACE the change; cdkd decides whether and how to follow.
File on `go-to-k/cdkd` so its agent picks the work up from its own issue queue.

**Search first**, for the SURFACE this change touches (the subcommand, the
option, the helper name) — not for this PR's wording:

```bash
gh issue list --repo go-to-k/cdkd --state open --limit 200 \
  --search 'Follow cdk-local <surface>' --json number,title
```

On a HIT, do not file: add the change as a checklist row on that issue, building
the new body from its current one so nothing is lost. On a MISS, file
`Follow cdk-local: <one-line summary>` with one bullet per applicable category,
each carrying its host-action label, and link the cdk-local PR as a FULL GitHub
URL — a bare `#N` auto-links to an issue in the TARGET repo. If `gh issue create`
is denied (permission / offline), say so explicitly and stop.

## Important

- English only for every committed or published artifact.
- Do NOT reference cdkd internals in cdk-local artifacts — the dependency
  direction is `cdkd -> cdk-local`. Talk about "notify cdkd" / "the host CLI",
  never about cdkd's deploy or provider system.
