<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## Gotchas (learned the hard way)

- **Claim before editing, always** — the whole point. An unclaimed lane races a
  parallel agent onto the same shared module.
- **A fresh issue is someone's deferral, not free backlog** (§3-a). The author field
  proves nothing about which session filed it, so the 60-minute window is the whole
  defence — and §4 is its other half: claim what you FILE, not only what you take.
- **One lane per shared cross-cutting module.** `ecs-service-emulator.ts` /
  the `resolveLambdaContainerEnv` helper in `local-invoke.ts` /
  `front-door-server.ts` / `cloudfront-server.ts` each absorb many fixes; you
  cannot parallelize two issues that both land there.
- **A collision-driven local fallback beats touching a contested file.** If your
  fix needs a value that lives in a helper another agent owns, prefer a small
  SELF-CONTAINED change in YOUR file over editing theirs.
- **Stale-base phantom diff** (§7) — never "restore" the peer's lines a stale
  `git diff origin/main` appears to have removed; rebase instead. And the converse:
  a rebase / merge with no conflict is not proof the lanes were disjoint — same
  file, different sections lands silently (§7, confirmed in §9).
- **A worktree you did not add may be a LIVE peer** (§9) — `git worktree list`
  cannot tell a finished lane from a session working right now, already-merged
  branch tip included. The closing check is "mine are gone", not "only main
  remains".
- **Start every marker / gate command with an explicit `cd <worktree> &&`** — the
  shell cwd does not reliably persist across tool calls, and a `markgate set` /
  sha-sentinel write that lands in the WRONG worktree surfaces later as a
  mystifying `no marker` (each worktree has its own markgate store; fired twice
  in one run on 2026-08-19). `pwd` costs nothing; a marker in the wrong store
  costs a re-diagnosis. **A KILLED or REFUSED call is a named trigger for the
  cwd going wrong, and it lies about the filesystem too**: a tool-call timeout
  that kills a call mid-run can bring the persistent shell back at the session
  cwd, and a PreToolUse refusal aborts the WHOLE call, so a directory it was
  going to `mkdir` never exists for a later call's relative `cd` — and a failed
  `cd` stops an `&&` chain but NOT the later lines of a multi-line call, which
  then write into whatever cwd was current. Both measured in a cdkd
  `/work-issues` run (2026-08-28, go-to-k/cdkd#2370); this repo has no
  main-tree EDIT gate to catch the stray write, so the receipt matters more
  here. After any timeout or refusal, run `pwd` and re-verify what the aborted
  call was supposed to create, before the next relative-path command.
- **A hook's `if` takes ONE pattern — ` or ` matches nothing and disables the
  gate outright.** On 2026-08-20 (go-to-k/cdk-real-drift#1801) all seventeen
  gates here were written as
  `"if": "Bash(git commit*) or Bash(git -C * commit*) or Bash(cd * && git commit*)"`
  and every one was INERT: `git commit` on `main` with no markers reached git,
  while the same payload run through the script by hand blocked with exit 2.
  A gate guarding two verbs gets two ENTRIES, and the pattern is written
  UNANCHORED (`Bash(*git commit*)`) so a compound command still selects it; the
  script re-matches precisely anyway. `tests/unit/hooks/gate-if-matchers.test.ts`
  pins all three properties. **The general shape: a gate you have never watched
  go RED is not a gate** — the failure stays invisible until someone types a
  command that should have been blocked and notices it was not.
- **A gated command must be the ONLY thing in its Bash call.** A PreToolUse hook
  denial aborts the WHOLE command string BEFORE any line runs — including
  preamble side effects you assumed happened: a blocked
  `cat > body.md <<EOF ... && gh pr create --body-file body.md` never wrote the
  body, a later `cat >>` CREATED the file as a fragment, and PR
  go-to-k/cdk-local#525 opened with no summary and no `Closes` line, silently
  costing the auto-close (2026-08-19). Same mechanism as the documented
  markgate-set rule (`.claude/rules/hooks.md`, gh-pr-merge-worktree-gate): write
  files and set markers in their own calls, then run `git commit` /
  `gh pr create` / `gh pr merge` alone. Its worst signature is not the ABSENT
  file but a STALE one left by an earlier session — these paths are conventional
  (`/tmp/pr-body.md`) and shared, so the gate inspects that file and reports
  violations from content this session never wrote (measured 2026-08-21 in the
  sibling repo: a refused `gh pr create` cited four bare refs from a lane days
  old). If a gate names text you do not recognise, check the file's mtime
  before hunting for the text; and give body files a per-session name for the
  same reason probe files get one.
- **`/merge-pr`, not a hand-run merge** — a hand-run `gh pr merge --delete-branch`
  from a side worktree trips the `'main' is already used by worktree` fatal (the
  remote merge lands but local cleanup fails) and is gate-blocked besides.
- **Never defer the integ** — a `src/**` fix ships its Docker/fixture coverage in
  the SAME PR (the `integ` gate enforces it at merge time).
- **Do not restore an agent's uncommitted work with `git checkout -- <file>`.**
  It resets to HEAD, and a fan-out agent's work is UNCOMMITTED by instruction, so
  the file goes back to `origin/main` and the agent's edit is gone (destroyed a
  lane's fix on 2026-08-27; recoverable only because the probe had copied the
  file first). Copy before you mutate, restore from the copy, and confirm by a
  property of the agent's work (`grep -c <the symbol it added>`), not by
  `git status` being clean — clean is exactly what the wrong restore produces.
- **`git add -N` to get a diffstat leaves the index dirty and breaks the next
  `rebase` / `stash`.** Both refuse with `Entry '<path>' not uptodate` or
  `your index contains uncommitted changes`, which reads as a merge problem
  rather than as your own earlier command. `git reset` clears it. Cheaper: get
  the true size with `git status --porcelain | wc -l` plus
  `git diff --shortstat`, or accept that untracked files are missing from the
  stat and say so.
- **A green suite in the MAIN checkout can be measuring nothing.** The
  worktree rule in section 5 says a fresh worktree has no `node_modules` and no
  `dist/`; the main checkout can be the one missing them, because the lanes have
  been running `pnpm install` and it has not (six `exit 1` runs read as a flake
  repro on 2026-08-27 were all `Cannot find module .../vite-plus/dist/bin.js`).
  Read the failure text before counting exit codes, and prefer measuring in a
  worktree that is set up and whose diff cannot touch the subject.

## Important existing rules this skill leans on

- **English-only** for all committed/public artifacts (source, docs, PR/commit
  messages, issue comments on this repo).
- **Always add unit tests** for a fix — do not wait to be asked.
- **All changes via PR; never commit to `main`.** Develop in a git worktree under
  `.claude/worktrees/<branch>/` with DISJOINT files; merge via `/merge-pr`.
  (`.claude/CLAUDE.md` → Workflow rules.)
- **Never defer integration tests to a later PR** — every slice ships its own integ
  coverage green before merge. (`.claude/CLAUDE.md` → Workflow rules.)
- **Never download/run/install untrusted third-party content** (§0).
- **Wrap with a Remaining-work section + Session-close verdict, scoped to the
  issues this run actually worked.** This skill is the easiest place to get that
  scope wrong: it starts from a backlog, so the issues you triaged but did NOT
  pick up look like follow-ups. They are not. List only residuals of the lanes
  you shipped (gaps, deferred polish, issues filed because of this work).
  (`CLAUDE.md` → Workflow rules.)
