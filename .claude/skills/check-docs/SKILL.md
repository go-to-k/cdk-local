---
name: check-docs
description: Check if documentation (README.md, .claude/AGENTS.md) is up to date with recent code changes. Use when code has been modified and docs may be stale.
---

# Documentation Consistency Check

Check whether documentation is up to date with recent code changes. Run it once
per PR, at the final sha.

## Steps

1. **Identify what changed**: Run `git diff main...HEAD --name-only` (or `git diff HEAD~5 --name-only` if on main) to see recently changed source files.

2. **Decide whether a deep review is needed (short-circuit)**. Most internal refactors and bug fixes don't affect anything the docs describe. A deep review is required if the diff touches ANY of:
   - `src/index.ts` — public library exports
   - `src/cli/index.ts`, `src/cli/commands/**` — CLI surface described in README.md
   - `src/types/**` — public type definitions
   - **any new file added** anywhere under `src/**` — must be mentioned in the per-module walk: `.claude/rules/code-layout.md`, or `.claude/rules/code-layout-local.md` for a `src/local/` runtime subsystem
   - `package.json` — dependency additions/removals
   - `README.md`, `.claude/AGENTS.md`, `.claude/rules/**`, `docs/**` — the docs themselves
   - README-visible CLI behavior changes (new flags, changed defaults, new commands)

   If none of the above apply (only internal src files modified, no new files, no deps changed), write a one-line note — "no docs-visible surface touched" — and stop. Do NOT re-read docs for unrelated internal edits.

3. **For each changed source file** (when a deep review is warranted), determine what documentation might be affected:
   - `src/cli/` changes → check CLI options/commands in README.md, `.claude/AGENTS.md`
   - `src/synthesis/` changes → check `.claude/rules/code-layout.md` (+ the `.claude/AGENTS.md` Architecture summary if the layout itself changed)
   - `src/local/` changes → check README.md usage examples + scope statement, `.claude/AGENTS.md` "Runs locally" list, `.claude/rules/local-scope.md`, and `.claude/rules/code-layout-local.md` (the per-subsystem walk for this subtree)
   - `src/assets/` changes → check `.claude/rules/code-layout.md`
   - New files added → check if they're mentioned in `.claude/rules/code-layout.md` (or `code-layout-local.md` under `src/local/`)
   - New exports in `src/index.ts` → check if README usage matches
   - `package.json` dependency changes → mention in `.claude/AGENTS.md` if user-facing
   - New CLI options → check README.md usage section

4. **Read the relevant documentation sections** and compare with the actual code to find:
   - Missing mentions of new files, features, or options
   - Outdated descriptions that no longer match the code
   - Stale lists that don't match what's in the source
   - Third-party product mentions that violate the `.claude/AGENTS.md` "Positioning" rule (no naming, recommending, or comparing against any third-party product — `sam local` is the only sanctioned exception).

5. **Report findings** as a checklist:
   - List each discrepancy found with the specific file and section
   - For each issue, suggest the fix
   - If no issues found, confirm documentation is consistent

6. **Fix the issues** if the user agrees, or ask for confirmation first.

## Important

- Do NOT add documentation that doesn't exist yet (don't create new doc files unless explicitly asked)
- Focus on consistency between existing docs and code, not completeness
- English-only for all committed artifacts (see `.claude/AGENTS.md` "Workflow rules")
- Do NOT reference cdkd internal implementation in cdk-local docs (the dependency direction is `cdkd -> cdk-local`)
