# Tooling backlog

This file holds findings about cdk-local's **own tooling** — Claude Code
hooks, the markgate gate, `.claude/rules/**`, `.claude/skills/**`, CI fences
and the integration-test harness. None of them is a cdk-local defect: no user
can hit any of these by running the CLI, so none of them belongs on the issue
tracker, which is for cdk-local behaviour a user CAN hit.

**How an item gets here.** Write one row when a tooling weakness is observed.
That is all — nothing is built on a first occurrence. A new hook, gate, CI
fence, rule paragraph or test-of-prose is added only on the SECOND occurrence
of the same failure. "Cost is not a tiebreaker for verification depth" governs
verifying PRODUCT changes and explicitly does not reach here.

**How an item graduates.** A row becomes a GitHub issue when someone actually
starts working it, and not before — the issue is then the working record, and
the row here says which issue took it. An unworked row stays a row.

**The criterion a hook has to clear to exist at all.** A PreToolUse hook may
BLOCK only when the harm completes at the moment of the action AND lands
irreversibly on a THIRD PARTY's artifact, on ANOTHER SESSION's work, or on the
MAINTAINER's AWS account. Everything else becomes a sentence in
`.claude/CLAUDE.md`, a CI unit test on `src/**`, or nothing. The full
statement, with the roster it produced, is in
[.claude/rules/hooks.md](../.claude/rules/hooks.md).

## Policy decisions recorded here

- **Hook fail-open on exotic shell shapes is ACCEPTED.** A gate's matcher can
  be walked past with quoting, heredocs, `$( )`, `bash -c`, `eval`, case arms
  or redirections. These hooks steer a COOPERATIVE agent away from foot-guns;
  they are not a security boundary, and `main` is protected server-side by a
  GitHub ruleset. Finding one more such shape is therefore **not issue-worthy**
  and not backlog-worthy.
- **Tooling findings are not issues.** Hooks, the gate, rules, skills, CI
  fences and the integ harness are not behaviour a user can hit. Record the
  finding here; it becomes an issue only when someone starts working it.
- **Nothing is built on a FIRST occurrence — the second-occurrence rule.**
  "It would have caught this" is the first occurrence. A hook, gate, fence,
  rule paragraph or skill step is added only after the same failure has
  happened twice.
- **Prose fences are RETIRED.** A test whose subject is the wording, byte size
  or citation count of agent-instruction prose does not clear the criterion
  above: nothing a user can hit depends on it, and the machinery costs more to
  keep honest than the drift it catches. Do not reintroduce one; a recurring
  prose defect is recorded here and, on a SECOND occurrence, fixed in the
  prose.
- **The English-only rule is enforced from CI, not by a hook.** The
  PreToolUse gate that carried it was kept as a stated exception when the hook
  layer was cut, because it was the repo's only enforcement. That exception is
  now RESOLVED: `scripts/check-pr-non-english-text.ts` and
  `scripts/check-gh-body-english.ts` do the job from CI, over the artifact
  rather than over an agent's command text.
- **Each sibling repo keeps its own flow text.** A lesson learned in cdkd or
  cdk-real-drift is NOT mirrored into this repo's skills, and vice versa. Only
  the PRODUCT contract with cdkd — the public library surface, checked by
  `/check-cdkd-parity` — crosses the boundary.

## Coverage the tooling shrink gave up

Recorded as first occurrences, per the rule above. Each was verified clean by
hand at the time of removal, and none is rebuilt until it bites a second time.

| What is no longer checked | Was checked by | State at removal |
| --- | --- | --- |
| Per-file byte caps over `.claude/skills/**` | `skill-file-payload.test.ts` | the budgets are now stated in `.claude/CLAUDE.md`'s Tooling Policy and checked by hand |
| `/work-issues`'s launch-mode probe executes correctly | `work-issues-launch-mode.test.ts` | the probe itself is unchanged; only the prose around it was trimmed |
| The fully qualified `owner/repo#N` reference shape in `.claude/**` | `work-issues-skill-refs.test.ts` | NOT clean — five in-repo `#N` prose references remain; the shape rule survives as a sentence and matters for text PUBLISHED to GitHub |
| Every markgate `include:` glob matches a real file | `markgate-include-globs.test.ts` | clean — one gate remains, with two globs (`src/**`, `tests/integration/**`), both non-empty |
| A staged blob carrying a C0 control byte is refused at COMMIT time | `control-char-gate.sh` | replaced, and strictly stronger: `tests/unit/no-control-bytes.test.ts` scans every tracked text file in CI, whatever shape the commit command took |
| A `Closes (#N)` parens form in a PR body | `closes-paren-form-gate.sh` | its subject is a PR body, not the repo, so there is nothing to re-verify; the rule survives as a sentence |
| A bare `#N` auto-link in a PR / issue body | `pr-body-item-number-gate.sh` | same; the rule survives as a sentence — write `owner/repo#N` |
| A `Dup-check:` LINE in a new issue body | `issue-dup-check-gate.sh` | same; the duplicate SEARCH stays a filing step, only the LINE requirement is gone |
| `Severity:` / `Effort:` body-vs-label agreement at filing time | `issue-classification-label-gate.sh` | same; the labels stay, and CI still copies them onto the PR |
| A `Session-fit: next` deferred for a PR-shaped reason | `issue-deferral-criteria-gate.sh` | same; the rule survives in `.claude/rules/session-report.md` |
| A doc example handing inline JSON to a file-path CLI flag | `docs-inline-json-flag-gate.sh` | clean — the gate's own regex, run over `docs/`, `README.md`, `.claude/` and `src/`, returns zero matches |
| Non-English writing-system characters in a PR diff, refused BEFORE `gh pr create` | `non-english-text-gate.sh` | replaced, and strictly stronger: `scripts/check-pr-non-english-text.ts` in `pr-content-checks.yml` checks the ARTIFACT, so the web UI, a fork PR and every non-`gh` client are covered for the first time. `scripts/check-gh-body-english.ts` adds the title / body / comment surfaces the hook never saw. The one thing lost is TIMING on an issue or a comment, where the text is public before the check reports |

## Open tooling items

These are the issues currently on the tracker whose subject is the tooling
rather than cdk-local. They are listed here so the record survives, and are to
be closed on the tracker. A row marked **moot** names a mechanism this shrink
deleted.

| Issue | Title |
| --- | --- |
| [#583](https://github.com/go-to-k/cdk-local/issues/583) | fix(integ): local-invoke-assume-role fails ~50% of runs, at a different step each time, and it is not the emulation fault |
| [#589](https://github.com/go-to-k/cdk-local/issues/589) | fix(integ): local-start-alb-websocket fails every run on arm64 at the ECS WebSocket echo round-trip |
| [#591](https://github.com/go-to-k/cdk-local/issues/591) | fix(integ): 30 fixtures hard-code a TCP port and 7 kill -9 whoever holds it, so two lanes break each other |
| [#594](https://github.com/go-to-k/cdk-local/issues/594) | chore(ci): nothing runs the integ fixtures, so a fixture can be red on main indefinitely |
| [#654](https://github.com/go-to-k/cdk-local/issues/654) | fix(integ): 20 fixtures lose the failing assertion under output truncation, so a red run cannot be localized |
| [#655](https://github.com/go-to-k/cdk-local/issues/655) | chore(hooks): pr-inherit-issue-labels never fires, because its regex rejects the qualified closing-reference form this repo uses |
| [#661](https://github.com/go-to-k/cdk-local/issues/661) | fix(hooks): verify-pr marker re-freshens from check/docs alone, at a sha it never walked *(moot: the mechanism it reports was deleted)* |
| [#662](https://github.com/go-to-k/cdk-local/issues/662) | fix(test): agentcore-ws-client bridge test waits a fixed 120ms, so it flakes under full-suite load |
| [#664](https://github.com/go-to-k/cdk-local/issues/664) | fix(integ): fixture cleanup docker-rm-f every cdkl- container on the host, destroying a concurrent run |
| [#665](https://github.com/go-to-k/cdk-local/issues/665) | chore(work-issues): the IN-PLACE detach fallback moves HEAD to origin/main instead of restoring where the tree was left |
| [#673](https://github.com/go-to-k/cdk-local/issues/673) | chore(work-issues): mirror cdkd#2452's three retro lessons (gh -R, carve-out probing, mirror ordering) *(moot: the mechanism it reports was deleted)* |
| [#676](https://github.com/go-to-k/cdk-local/issues/676) | chore(work-issues): mirror two flow lessons from the cdkd 2026-09-02 run — LAUNCH_BRANCH is never one to RENAME, and a deferral reason the promotion check contradicts *(moot: the mechanism it reports was deleted)* |
| [#677](https://github.com/go-to-k/cdk-local/issues/677) | test(gates): C0-only scans let U+00A0 / U+FEFF into source and commit messages |
| [#678](https://github.com/go-to-k/cdk-local/issues/678) | test(rules): hook-suite case counts in .claude/rules/hooks.md are unfenced and drift silently *(moot: the mechanism it reports was deleted)* |
| [#698](https://github.com/go-to-k/cdk-local/issues/698) | chore(work-issues): mirror five flow lessons from the cdkd 2026-09-04 run — scope tripwire, cwd-safe reads, count dispositions, late-round independence, markgate on PATH *(moot: the mechanism it reports was deleted)* |
| [#705](https://github.com/go-to-k/cdk-local/issues/705) | chore(work-issues): mirror six flow lessons from the cdkd 2026-09-05 run — cumulative budgets at triage, symmetric tree ownership, fence population, chat-language prompts, replaced assertions, Docker path discrimination *(moot: the mechanism it reports was deleted)* |
| [#706](https://github.com/go-to-k/cdk-local/issues/706) | fix(hooks): pr-review-gate's fix-back up-bias is erased by flattening the branch before merge *(moot: the mechanism it reports was deleted)* |
| [#708](https://github.com/go-to-k/cdk-local/issues/708) | chore(work-issues): mirror three flow lessons from the cdkd 2026-09-05 run -- the filing-time worktree test, `gh pr checks` parsing, and re-deriving committed numbers after the last rebase *(moot: the mechanism it reports was deleted)* |
| [#710](https://github.com/go-to-k/cdk-local/issues/710) | chore(work-issues): mirror two flow lessons from the cdkd 2026-09-05 run — the worktree probe reads one commit, and a lane report is its deliverable *(moot: the mechanism it reports was deleted)* |
| [#711](https://github.com/go-to-k/cdk-local/issues/711) | chore(work-issues): mirror three flow lessons from the 2026-09-06 cdkd run — cascade blocker COUNT, `Resuming agent`, and retro set attribution *(moot: the mechanism it reports was deleted)* |
| [#712](https://github.com/go-to-k/cdk-local/issues/712) | fix(hooks): the deferral gate passes a body delivered through a process substitution *(moot: the mechanism it reports was deleted)* |
| [#713](https://github.com/go-to-k/cdk-local/issues/713) | fix(hooks): two residual deferral-gate shapes — CRLF defeats the newline restore, and the writer arm judges the writer's arguments *(moot: the mechanism it reports was deleted)* |
| [#714](https://github.com/go-to-k/cdk-local/issues/714) | docs(rules): hooks.md claims path-based auto-loading it does not have (no paths: frontmatter anywhere) *(moot: the mechanism it reports was deleted)* |
| [#715](https://github.com/go-to-k/cdk-local/issues/715) | chore(work-issues): floor the COMPARAND, not just the walk, and spell an injected defect the way its source does |
| [#716](https://github.com/go-to-k/cdk-local/issues/716) | chore(work-issues): mirror five prose-verification and deferral-reason lessons from cdkd's retro *(moot: the mechanism it reports was deleted)* |
| [#725](https://github.com/go-to-k/cdk-local/issues/725) | chore(work-issues): mirror six flow lessons from the cdkd go-to-k/cdkd#3005 run — premise EFFECT, run a correction, table-driven regex is the same instrument, realpath a scratch root, forward cwd drift, a killed run is no verdict *(moot: the mechanism it reports was deleted)* |
| [#726](https://github.com/go-to-k/cdk-local/issues/726) | chore(work-issues): mirror two flow lessons from the cdkd go-to-k/cdkd#3079 run — a green probe licenses adding a case per arm, never deleting the guard; read which assertion the pre-fix control fired *(moot: the mechanism it reports was deleted)* |
