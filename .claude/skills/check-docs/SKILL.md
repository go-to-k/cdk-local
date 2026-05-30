---
name: check-docs
description: Check if documentation (README.md, .claude/CLAUDE.md) is up to date with recent code changes. Use when code has been modified and docs may be stale.
---

# Documentation Consistency Check

Check whether documentation is up to date with recent code changes.

## Steps

1. **Identify what changed**: Run `git diff main...HEAD --name-only` (or `git diff HEAD~5 --name-only` if on main) to see recently changed source files.

2. **Decide whether a deep review is needed (short-circuit)**. The `docs` gate's scope includes `src/**`, so any src edit invalidates the marker — but most internal refactors and bug fixes don't affect anything the docs describe. Skip the LLM-judged review and set the marker directly when the diff **only** touches files that the docs don't describe. A deep review is required if the diff touches ANY of:
   - `src/index.ts` — public library exports
   - `src/cli/index.ts`, `src/cli/commands/**` — CLI surface described in README.md
   - `src/types/**` — public type definitions
   - **any new file added** anywhere under `src/**` — must be mentioned in `.claude/CLAUDE.md` "Architecture" section
   - `package.json` — dependency additions/removals
   - `README.md`, `.claude/CLAUDE.md`, `.claude/rules/**`, `docs/**` (when it exists) — the docs themselves
   - README-visible CLI behavior changes (new flags, changed defaults, new commands)

   If none of the above apply (only internal src files modified, no new files, no deps changed), write a one-line note — "no docs-visible surface touched" — set the `docs` marker (see "Commit-gate marker" below), and stop. Do NOT re-read docs for unrelated internal edits.

3. **For each changed source file** (when a deep review is warranted), determine what documentation might be affected:
   - `src/cli/` changes → check CLI options/commands in README.md, `.claude/CLAUDE.md`
   - `src/synthesis/` changes → check `.claude/CLAUDE.md` Architecture section
   - `src/local/` changes → check README.md usage examples + scope statement, `.claude/CLAUDE.md` "Runs locally" list
   - `src/assets/` changes → check `.claude/CLAUDE.md` Architecture section
   - New files added → check if they're mentioned in `.claude/CLAUDE.md` "Architecture"
   - New exports in `src/index.ts` → check if README usage matches
   - `package.json` dependency changes → mention in `.claude/CLAUDE.md` if user-facing
   - New CLI options → check README.md usage section

4. **Read the relevant documentation sections** and compare with the actual code to find:
   - Missing mentions of new files, features, or options
   - Outdated descriptions that no longer match the code
   - Stale lists that don't match what's in the source
   - Third-party product mentions that violate the `.claude/CLAUDE.md` "Positioning" rule (no naming, recommending, or comparing against `aws-cdk-local`/`cdklocal`/LocalStack or other competing products — `sam local` is the only sanctioned exception).

5. **Report findings** as a checklist:
   - List each discrepancy found with the specific file and section
   - For each issue, suggest the fix
   - If no issues found, confirm documentation is consistent

6. **Fix the issues** if the user agrees, or ask for confirmation first.

## Commit-gate marker (on success only)

After documentation is verified consistent (either no issues were found, or all issues were fixed), record the `docs` markgate marker:

```bash
mise exec -- markgate set docs
```

Skip this step if issues remain unfixed.

## Important

- Do NOT add documentation that doesn't exist yet (don't create new doc files unless explicitly asked)
- Focus on consistency between existing docs and code, not completeness
- English-only for all committed artifacts (see `.claude/CLAUDE.md` "Workflow rules")
- Do NOT reference cdkd internal implementation in cdk-local docs (the dependency direction is `cdkd -> cdk-local`)
