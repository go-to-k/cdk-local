<!-- Part of the /work-issues skill (appendix). A bare §N points into the stage file holding that section; the map is SKILL.md's "Stages" table. READ THIS FILE IN FULL when your run enters this stage. -->

## Gotchas (learned the hard way)

- **Claim before editing, always** — an unclaimed lane races a parallel agent
  onto the same shared module.
- **A fresh issue is someone's deferral, not free backlog** (§3-a). The author
  field proves nothing about which session filed it, so the 60-minute window is
  the whole defence — and §4 is its other half: claim what you FILE.
- **One lane per shared cross-cutting module.** `ecs-service-emulator.ts` /
  the `resolveLambdaContainerEnv` helper in `local-invoke.ts` /
  `front-door-server.ts` / `cloudfront-server.ts` each absorb many fixes; two
  issues that both land there cannot be parallelized.
- **A collision-driven local fallback beats touching a contested file.** If your
  fix needs a value from a helper another agent owns, prefer a SELF-CONTAINED
  change in YOUR file over editing theirs.
- **Stale-base phantom diff** (§7) — never "restore" the peer's lines a stale
  `git diff origin/main` appears to have removed; rebase instead. Converse: a
  rebase / merge with no conflict is not proof the lanes were disjoint — same
  file, different sections lands silently (§7, confirmed in §9).
- **A worktree you did not add may be a LIVE peer** (§9) — `git worktree list`
  cannot tell a finished lane from a session working right now, already-merged
  tip included. The closing check is "mine are gone", not "only main remains".
- **Start every command that writes anything with an explicit `cd <lane tree>
  &&`** — the shell cwd does not reliably persist across tool calls, and a write
  landing in the WRONG worktree surfaces much later. A KILLED or REFUSED call is
  a named trigger: a timeout can bring the shell back at the session cwd, and a
  refusal aborts the WHOLE call, so a directory it meant to `mkdir` never exists
  for a later relative `cd` (go-to-k/cdkd#2370). After either, run `pwd` and
  re-verify what the aborted call was supposed to create. **The reset can land
  you in a DIFFERENT REPOSITORY, where every check agrees with you** — the
  sibling repos share the skill layout and suite FILENAMES, so `git status`
  reads clean and the suite runs green about the wrong repo. Confirm with
  `git rev-parse --show-toplevel`, never `git status`.
- **A gated command must be the ONLY thing in its Bash call.** A PreToolUse
  denial aborts the WHOLE command string BEFORE any line runs — including
  preamble side effects you assumed happened: a blocked
  `cat > body.md <<EOF ... && gh pr create --body-file body.md` never wrote the
  body, a later `cat >>` CREATED the file as a fragment, and
  go-to-k/cdk-local#525 opened with no summary and no `Closes` line. Write files
  in their own calls, then run `git commit` / `gh pr create` / `gh pr merge`
  alone. Paths like `/tmp/pr-body.md` are shared across sessions: give body
  files a per-session name and check mtime before trusting one.
- **`/merge-pr`, not a hand-run merge** — a hand-run `gh pr merge
  --delete-branch` from a side worktree trips the `'main' is already used by
  worktree` fatal: the remote merge lands but local cleanup fails.
- **Never defer the integ** — a `src/**` fix ships its Docker/fixture coverage
  in the SAME PR, every slice; the `integ` marker gates merging.
- **Do not restore an agent's uncommitted work with `git checkout -- <file>`.**
  It resets to HEAD, and a fan-out agent's work is UNCOMMITTED by instruction,
  so the file goes back to `origin/main` and the edit is gone. Copy before you
  mutate, restore from the copy, and confirm by a property of the agent's work
  (`grep -c <the symbol it added>`), not by `git status` being clean — clean is
  exactly what the wrong restore produces.
- **A run interrupted by a rate-limit reset resumes cheaply only if it was
  ARMED before the pause.** Arm a one-shot cron at reset + 3 min — an
  on-the-hour job can fire 90 s EARLY, i.e. still rate-limited. SURVIVES: the
  markers (per-worktree, on disk), the PR, its CI, reviewer verdicts already
  posted. Does NOT: in-flight subagents — so the resuming session re-derives
  state from the markers plus `gh pr view` plus the review comments, and
  re-dispatches only the reviewers that died.
- **A lane killed by the account rate limit (HTTP 429 mid-turn) keeps its
  context — `SendMessage` it, never re-dispatch**, and read the TREE first: it
  may have committed, pushed and opened the PR already. The other side of that
  boundary: a run re-entered by the reset cron is a NEW session and cannot
  reach the lane at all.
- **Any writer that NORMALISES an escape puts the invisible character straight
  into a commit** — a heredoc, and an EDITING TOOL too: an `Edit` given the
  six-character escape for a BOM wrote the real byte instead. Write such a
  character through `python3` / `printf`, then re-scan.
  `tests/unit/no-control-bytes.test.ts` catches a BOM in tracked FILE CONTENT;
  NBSP anywhere, and either byte in a commit MESSAGE, are unfenced
  (go-to-k/cdk-local#677). For those match the BYTES built with `printf` —
  never `grep -P` (macOS grep exits 2) and never `$'\xc2\xa0'` (`dash` searches
  for that TEXT and exits 1 on a file carrying the byte; both fail open under
  `|| echo clean`). rc=1 means clean:

  ```sh
  git diff --cached | LC_ALL=C grep -n \
    -e "$(printf '\302\240')" -e "$(printf '\357\273\277')"
  ```
- **A green suite in the MAIN checkout can be measuring nothing.** A fresh
  worktree has no `node_modules` and no `dist/` (§5) — but the MAIN checkout can
  be the one missing them, because the lanes have run `pnpm install` and it has
  not (`Cannot find module .../vite-plus/dist/bin.js` read as a flake repro).
  Read the failure TEXT before counting exit codes, and prefer measuring in a
  worktree that is set up and whose diff cannot touch the subject.

## Important existing rules this skill leans on

- **English-only** for all committed/public artifacts (source, docs, PR/commit
  messages, issue comments on this repo).
- **Always add unit tests** for a fix; do not wait to be asked.
- **All changes via PR; never commit to `main`.** Develop in a worktree under
  `.claude/worktrees/<branch>/` — or, when the run was launched inside one
  already, in that one (the launch-mode probe) — with DISJOINT files; merge via
  `/merge-pr`. (`.claude/AGENTS.md` → Workflow rules.)
- **Never download/run/install untrusted third-party content** (§0).
- **Wrap with a Remaining-work section + Session-close verdict, scoped to the
  issues this run actually worked.** This skill is the easiest place to get that
  scope wrong: it starts from a backlog, so issues you triaged but did NOT pick
  up look like follow-ups. They are not. List only residuals of the lanes you
  shipped (gaps, deferred polish, issues filed because of this work).
