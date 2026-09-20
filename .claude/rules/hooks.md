# Hooks and Gates

Reference for `.claude/hooks/*.sh` and `.markgate.yml`. The policy that
decides whether a hook may exist at all is in `.claude/AGENTS.md`, section
"Tooling Policy"; this file is the roster and the authoring contract.

## When a hook may BLOCK, and when it may exist at all

**A gate may block only when the harm completes at the moment of the action
AND lands irreversibly on a THIRD PARTY's artifact, on ANOTHER SESSION's work,
or on the MAINTAINER's AWS account.** Everything else becomes a sentence in
`.claude/AGENTS.md`, a CI unit test on `src/**`, or nothing. Ask the two
clauses separately — is the harm reversible, and whose artifact does it land
on — never one about severity: irreversibility alone would block a duplicate
issue, which is the filer's own artifact and closes cleanly.

**A hook that fails OPEN on an exotic shell shape is accepted as-is.**
Quoting, heredocs, substitutions, `bash -c`, `eval`, case arms and
redirections can all steer a command past a matcher. These hooks steer a
COOPERATIVE agent away from foot-guns; they are not a security boundary, and
`main` is protected server-side by a GitHub ruleset. Such a miss is not
issue-worthy and not backlog-worthy.

## The roster

**`main` itself is protected SERVER-SIDE, not by a hook. This is the ONE place
the ruleset is written down** — everywhere else points here. It is repository
settings rather than a file, so read the live rules rather than this paragraph:

```bash
gh api repos/go-to-k/cdk-local/rules/branches/main
```

`enforcement: active`, `bypass_actors: []`, scope `~DEFAULT_BRANCH`. Four
rules:

| Rule | What it refuses |
| --- | --- |
| `deletion` | deleting `main` |
| `non_fast_forward` | a force push to `main` |
| `required_status_checks` | a merge whose head has not passed `ci-ok`, `check`, `pr-content` and `English-only (pull request)` |
| `pull_request` | **any change that did not arrive through a PR**; `allowed_merge_methods: [squash]`, `required_approving_review_count: 0` |

So `git push origin main` is refused for ANY commit, green or not, and history
on `main` is squash-only. Nothing local needs to repeat that, which is why
`branch-gate.sh` went.

**Two residuals remain, and neither is hook-shaped.**

1. **A commit on a LOCAL `main` is refused by nothing.** It never reaches the
   server, so the ruleset has no opinion. Move it:
   `git branch <name> && git reset --hard origin/main`.
2. **A red NON-required check does not block a merge.** The ruleset gates on
   exactly the four contexts above, so a fifth workflow going red is invisible
   to it. Read `gh pr checks <N>` in full rather than trusting the merge
   button. (`required_approving_review_count: 0` likewise means a PR is
   required but an APPROVAL is not, and
   `strict_required_status_checks_policy: false` means the branch need not be
   up to date with `main` first.)

### Another session's work

- **`post-merge-orphan-push-gate.sh`** — blocks `git push <remote> <branch>`
  (incl. `-u` / `--set-upstream` / `git -C <path> push`) when `<remote>` is
  `origin` AND `gh pr list --head <branch> --state merged` returns a PR whose
  `headRefName` matches. The branch is gone, so the push re-creates an orphan
  ref no PR tracks and those commits silently never reach `main`. ONLY the
  MERGED state (closed-not-merged passes), ONLY `origin`, ONLY `git push`, and
  it judges EVERY push in the command rather than the first. The remote and
  branch are read PER SEGMENT through `gate_verb_args`, using the same
  constant that armed the gate — reading them off the whole command steers the
  branch to the wrong token on a chain or a quoted mention. Its `gh` calls
  carry `</dev/null`: the walk's stdin IS the segment stream, so a `gh` free
  to read stdin eats the segments not yet judged. Fails open without `gh`, and
  states each per-COMMAND note once however many segments it walks.

### The maintainer's AWS account

- **`integ-gate.sh`** — blocks `gh pr merge` (incl. `--auto`) and `git merge`
  on a PR whose diff touches `src/**` or `tests/integration/**` when the
  `integ` marker is stale. `/run-integ` is the ONLY legitimate setter: it
  requires a clean fixture run, an empty `docker ps` / `docker network ls`
  sweep, and an empty AWS orphan sweep. The AWS half is what puts this gate
  over the criterion — the `*-from-cfn-stack` fixtures deploy real
  CloudFormation stacks with the upstream CDK CLI, and a leaked stack bills
  the maintainer and is not undone by reverting the PR.

  **Scope short-circuit.** Before consulting the marker the hook diffs the PR
  against `origin/main` (`git diff origin/main...HEAD --name-only`) and exits
  0 when NEITHER path is touched. Without it, a fresh worktree — whose markers
  start empty, since they are per-worktree — would block every docs-only PR
  into an irrelevant Docker run.

## The `integ` gate's `hash: diff` mode

`integ` runs on markgate's diff mode: its digest is this branch's delta
against `merge-base(origin/main, HEAD)` restricted to the include set, not the
working tree's content.

| event | marker |
|---|---|
| `main` moves an in-scope file this branch did NOT touch | **fresh** |
| `main` moves an in-scope file this branch ALSO touched | stale |
| in-scope edit on this branch (committed or not) | stale |
| out-of-scope edit | fresh |

So rebasing onto an updated `main` no longer forces an irrelevant Docker
re-run — every incoming change already passed this same gate in its own PR.
`base: origin/main` is mandatory for the mode: there is no `origin/HEAD`
fallback, because that ref is frequently unset in CI clones and the gate must
mean the same thing locally and in CI. Accepted limitation: cross-file
interaction is invisible — this branch changing A while `main` changes B never
overlaps — which the 14-day TTL bounds (issue go-to-k/cdk-local#498).

Three operational consequences:

- **Empty TOTAL delta is REFUSED** (exit 2, "no delta against merge-base"),
  typically on a clean `main`. Set the marker from the PR's own worktree, on
  the PR branch.
- **Empty IN-SCOPE delta is ACCEPTED**, with a warning and exit 0 — the normal
  case for a docs-only branch. The marker IS written; do not read that warning
  as the refusal above.
- **An unresolvable `base` ref is a hard stop that `/run-integ` cannot
  clear**: markgate exits 2 for `verify`, `status` AND `set` alike, so
  re-running the skill fails identically. The fix is `git fetch origin`.

**Never pipe `markgate verify` / `set` / `run`.** `$?` after a pipeline is the
LAST stage's, and markgate prints NOTHING when a marker is fresh, so
`markgate verify integ | tail -5` reports "no output, rc=0" for a STALE marker
— indistinguishable from a fresh one. Read the verdict with a command
substitution. `markgate status | awk …` and `… || echo …` are fine.

**Markgate markers are per-worktree**, stored under
`<worktree>/.git/worktrees/<name>/markgate/`, so parallel lanes can verify and
commit concurrently; run `markgate set` from the worktree where the gated
command will be invoked. Spell a hand check `mise exec -- markgate …`: a bare
`markgate` is not the version `.mise.toml` pins for the gate.

The hooks a session runs come from ONE repo's `.claude/settings.json` and fire
on **every** Bash call, including ones targeting another repository. **A cdkd
session working here gets cdkd's policy applied to it: expected, not a bug in
this repo.** Complete this repo's checklist, set its marker legitimately, then
retry — never route around the block, and never converge the two repos'
policies.

## Authoring a hook

**Every Bash-targeting `PreToolUse` entry parses the command itself.** Each
gate uses the shared matcher rather than a line-anchored regex, which is what
catches the `cd <path> && …` and `gh -C <path>` spellings this repo
prescribes. An `if:` condition holding `A or B` matches NOTHING and leaves the
entry registered and inert (go-to-k/cdk-real-drift#1801);
`tests/unit/hooks/gate-if-matchers.test.ts` fences the `if:` spellings in
`.claude/settings.json`.

**A refusal message printed with `cat >&2 <<EOF` is an UNQUOTED heredoc**, so
`$( )`, backticks and `$var` in the body EXECUTE at refusal time instead of
printing — a gate RUNS the worked example it meant to print. QUOTE THE
DELIMITER (`<<'EOF'`) and interpolate the few live values with a separate
`printf`. Assert the RENDERED message in the suite, never a restatement of it.

**A blocking gate that cannot load the shared matcher exits 2.** So does one
whose helper is missing: an undefined function returns an EMPTY answer, and a
gate that then judges the wrong thing — or nothing — is worse than one that
declines. Name the missing symbol in the refusal.

**An unreadable target directory is likewise a REFUSAL**: a hook receives
command TEXT, not the shell's expansion, so `git -C "$W" commit` arrives
unexpanded and the resolver returns 2 rather than guessing. These shapes must
NOT be refused: an absolute `-C` or `cd` mooting an earlier unreadable one, a
`cd` AFTER the verb, and a leading literal `~`.

**Hooks must be bash 3.2 compatible.** `gate-command-recognition.test.sh`
exports `HOOK_BASH` so the HOOK, not just the suite, runs under the chosen
interpreter; run the suites under both `bash` and `/bin/bash`. CI runs
every `.claude/hooks/*.test.sh` and `tests/integration/_lib/*.test.sh` through
`vp run test:hooks`.

## The shared matcher (`.claude/hooks/_command-match.sh`)

Every Bash gate parses its command through this one library.

- Heredoc bodies and quoted spans are **NEUTRALISED to a placeholder, never
  deleted** — the verb EREs carry value sub-patterns and need the positions.
- **No non-empty command may segment to ZERO**, or every gate considers
  nothing and all of them exit 0 at once.
- **Over-approximate the TRIGGER, stay strict on RESOLUTION.** `GATE_FLAGS`
  enumerates no flag spellings, so an unlisted one WIDENS the match rather
  than losing it. `gh` takes `-R` / `--repo` / `-C` in either order, with all
  three separators (space, `=`, glued), and `GATE_GH_C` is literally
  `GATE_FLAGS` so every gh verb absorbs them identically.
- **Widening the absorber is necessary and NOT sufficient.** It makes the
  flagged command REACH the gate; the gate must then PARSE it, and a gate that
  chops the prefix with its own regex reads the WRONG argument at the same exit
  code. Strip with `BASH_REMATCH[0]` of the verb ERE that armed the gate —
  `gate_verb_args` is that strip — never with a local regex.
- **`gate_verb_args` strips exactly `BASH_REMATCH[0]` of the same regex that
  armed the gate**, so a gate cannot match one way and parse another. It emits
  one line per matching segment.
- **Equal exit codes are not enough** as a fence. `gate-command-recognition.test.sh`
  drives the REAL hooks and asserts what each one ASKED: the directory it
  consulted (`$PWD` at the markgate call), WHICH marker it verified, the PR
  number it resolved and the repo it named. A gate that sources the library
  and then asks the WRONG question is invisible to exit codes alone.
- The `$( )` opener scan reads the PHYSICAL line, is QUOTE-AWARE with a
  per-depth stack, skips `${…}` / `$((…))` and `#` comments whole, and BAILS
  to "no opener" on a line it cannot read to the end. It latches **QUOTED
  DELIMITERS ONLY**; an unquoted body is read as commands — a false refusal,
  never a miss.
- A MIS-closed span is worse than an unclosed one: a wrong index truncates the
  body and resumes with the enclosing quote still open, so the rest of the
  real body is parsed as prose and the verb inside it never starts a segment.
