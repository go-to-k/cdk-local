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
- **Start every marker / gate command with an explicit `cd <lane tree> &&`** —
  the shell cwd does not reliably persist across tool calls, and a
  `markgate set` / sha-sentinel write landing in the WRONG worktree surfaces
  later as a mystifying `no marker` (per-worktree stores; fired twice in one
  run, 2026-08-19). **A KILLED or REFUSED call is a named trigger for the cwd
  going wrong, and it lies about the filesystem too**: a timeout can bring the
  persistent shell back at the session cwd; a PreToolUse refusal aborts the
  WHOLE call, so a directory it was going to `mkdir` never exists for a later
  relative `cd` — and a failed `cd` stops an `&&` chain but NOT the later
  lines of a multi-line call (both measured, go-to-k/cdkd#2370; this repo has
  no main-tree EDIT gate to catch the stray write). After any timeout or
  refusal, run `pwd` and re-verify what the aborted call was supposed to
  create. **And the reset can land you in a DIFFERENT REPOSITORY, where every
  check you would reach for agrees with you** — the three sibling repos share
  the skill layout and suite FILENAMES, so `git status` reads clean and the
  suite runs green, all about the wrong repo (measured 2026-09-03: the shell
  surfaced in `../cdk-real-drift`; the tell was a case NAME in the output
  naming a predicate the file under edit does not carry, and nothing was
  damaged only because the edit ran through `python3` with
  `assert <anchor> in s`). A COUNT that moves with no diff is the cheap
  signal; confirm with `git rev-parse --show-toplevel`, never `git status`.
- **A hook's `if` takes ONE pattern — ` or ` matches nothing and disables the
  gate outright.** On 2026-08-20 (go-to-k/cdk-real-drift#1801) all seventeen
  gates here were written as
  `"if": "Bash(git commit*) or Bash(git -C * commit*) or Bash(cd * && git commit*)"`
  and every one was INERT: `git commit` on `main` with no markers reached git,
  while the same payload run through the script by hand blocked with exit 2.
  Bisect with throwaway hooks: an `if`-less hook, a known-good single pattern,
  the suspect — whichever stops firing names the cause.
  A gate guarding two verbs gets two ENTRIES, and the pattern is written
  UNANCHORED (`Bash(*git commit*)`) so a compound command still selects it; the
  script re-matches precisely anyway. `tests/unit/hooks/gate-if-matchers.test.ts`
  pins all three properties. **The general shape: a gate you have never watched
  go RED is not a gate** — the failure stays invisible until someone types a
  command that should have been blocked and notices it was not.
- **An IN-PLACE run ends with the Stop hook still calling its lane unmerged, and
  the remedy it names is one this mode forbids.**
  `.claude/hooks/stop-unmerged-lane-warn.sh` enumerates every worktree whose
  branch is ahead of `origin/main`, and this repo SQUASH-merges, so a merged
  branch reads as ahead forever; because the launch worktree IS the session's,
  the warning arrives as `additionalContext` — "remove its worktree and delete
  the branch" — which §3's launch-mode rule forbids here. Expected, not a
  defect: confirm the PR is MERGED (`gh pr view <n> --json state`) and say so in
  the wrap. The tree is only clearable from inside by LEAVING the branch, and
  §9's IN-PLACE cleanup arm is where that happens — as the run's LAST step:
  switch back to `LAUNCH_BRANCH`, which for a freshly created workspace sits 0
  commits ahead of `origin/main` and so silences the hook while leaving the
  workspace exactly as the outer tool created it. (If the tool DID leave commits
  on its own branch the hook keeps naming it — correctly: they are not this
  run's to merge, and §9 forbids fast-forwarding them away.) Detaching (`git switch --detach origin/main`) silences it too —
  the hook skips a detached worktree, `git branch --show-current` being empty —
  but it is visible-surprising in the outer tool's UI, so §9 keeps it as the
  FALLBACK, taken only when `LAUNCH_BRANCH` was empty at probe time or is now
  gone. `main` is never an option here: it is checked out in the main checkout.
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
- **A run interrupted by a rate-limit reset resumes cheaply, but only if it was
  ARMED before the pause — and the salvage inventory is what makes it cheap.** A
  one-shot cron at reset + 3 minutes re-enters the run; the +3 is not padding,
  since a one-shot job scheduled on the hour can fire up to 90 s EARLY, i.e.
  still rate-limited. What SURVIVES the pause: markgate markers (per-worktree,
  on disk), the PR, its CI, and every reviewer verdict already posted to GitHub.
  What does NOT: in-flight subagents. So the resuming session re-derives its
  state from the markers plus `gh pr view` plus the review comments, and
  re-dispatches only the reviewers that died. Measured on the overnight run of
  2026-09-02 (go-to-k/cdk-local#650), which crossed two resets and a host sleep
  and still finished its lane. Stand down any QUEUED lane the run will not reach
  at the moment that verdict is known, not at the wrap (§4).
- **Any writer that NORMALISES an escape puts invisible non-C0 characters
  straight into a commit, and the fences do not all cover them.** A heredoc is
  one such writer; an EDITING TOOL is another -- writing this very bullet, an
  `Edit` call substituted a literal U+FEFF for the `\uFEFF` it was given, so
  the sentence warning about the byte shipped carrying it. Write such a
  character through `python3` / `printf`, spell it as a `\u`-escape (the same
  rule `.claude/rules/hooks.md` states for C0 bytes), then re-scan — and when
  a heredoc's subject IS whitespace-adjacent text, read the bytes before
  committing.
  `control-char-gate.sh` is C0-only, so U+00A0 (NBSP) and U+FEFF (BOM) walk
  past it -- including into a commit MESSAGE, which nothing scans at all (this
  bullet's own commit acquired an instance, amended away on re-read).
  `tests/unit/no-control-bytes.test.ts` now catches U+FEFF in tracked FILE
  CONTENT (`main` carried a live literal-BOM regex in
  `tests/unit/gates/markgate-include-globs.test.ts` until that arm landed);
  the remaining gap is NBSP everywhere plus either byte in a commit message
  (go-to-k/cdk-local#677). For that unfenced case, the portable recipe below:
  match the BYTES built with `printf`, never `grep -P` (macOS grep exits 2,
  `invalid option`) and never `$'\xc2\xa0'` (`dash` searches for that TEXT and
  exits 1 on a file that carries the byte; both fail open under
  `|| echo clean`, measured 2026-09-02). rc=1 really does mean clean; the
  recipe itself is executed by no test -- a live trade, since a harness that
  extracts and runs a fenced block from prose is more machinery than the one
  command it guards:

  ```sh
  git diff --cached | LC_ALL=C grep -n \
    -e "$(printf '\302\240')" -e "$(printf '\357\273\277')"
  ```
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
  `.claude/worktrees/<branch>/` — or, when the run was launched inside a worktree
  already, in that one (§3's launch-mode probe) — with DISJOINT files; merge via
  `/merge-pr`.
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
