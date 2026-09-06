# Session-wrap report: the full field reference

CLAUDE.md's "Every session-wrap / task-complete report" rule states the
contract; this file carries the complete field semantics, scales, and
templates. Read it when writing a wrap report or filing a deferral.

**The four TODO fields — decide them WHEN THE ITEM ARISES, not at wrap
time.** By wrap time the evidence for the call (which files were open,
which verification cycle was already being paid for) is gone, and a
retrospective guess is worth little. Record them **in the issue body**
so they outlive the session. The issue body and the report use the
SAME four lines, one field per line:

```text
Session-fit: now (do it in this session) | next (not this session) — <reason>
Severity: high | medium | low — <what stays broken while it is undone>
Effort: small (S) | medium (M) | large (L) — <which verification cycle it drags>
Estimate: <duration, e.g. ~1-3 h> — <what eats the time>
```

A report adds a fifth line, **`Notes`**, for session-specific context
(`none` when there is nothing); the issue body carries no `Notes`,
because what belongs there is only the part that outlives the session.
Four CLASSIFICATION lines, and they stay four — a filed issue body also
carries a **`Dup-check:`** line recording that the OPEN issue list was
searched for an issue already covering this root cause
(`/work-issues` §5), but that is a filing-time record rather than a
classification field: it is written once when the issue is created and
never re-decided on a claim. `.claude/hooks/issue-dup-check-gate.sh`
refuses `gh issue create` without it.

**The four answer four DIFFERENT questions and none derives from
another**: `Session-fit` is the decision, `Severity` the cost of
leaving it undone, `Effort` which verification cycle the fix drags,
`Estimate` the hours. In particular do not collapse `Severity` into
`Session-fit` — a `Severity: high` item can still be `next` (it needs
a new integ fixture has to be written) and a `low` one can be `now` (it lands in a file
this session already has open). The moment the two track each other,
`Severity` is a second spelling of the decision and the field is
wasted. Likewise `Effort` is not `Estimate`: "one integ run" is a kind
of cost, and how many hours it takes depends on which fixture.

**The keys are spelled identically everywhere** — issue body, English
report, Japanese report; never translated or renamed per context.
**No bare tokens**, because a value must be readable without knowing
the internal scale: write `Session-fit: next (not this session)` and
never a lone `next`; `Effort: large (L)` and never a lone `L`;
`Severity` as a word and **never as an initial** (the initials collide
with `Effort`'s both ways — `M` is `medium` on either scale, and `L`
would be *low*, the least urgent thing there is, against *large*, the
biggest); and always BOTH `Effort` and `Estimate` — dropping the
duration and keeping the letter is exactly the failure this split
exists to end.

**`Severity` and `Effort` are ALSO LABELS on a filed issue.** The two
lines stay exactly as written — nothing about the report or the body
changes — and the same two values are mirrored onto the issue as
`severity:high` / `severity:medium` / `severity:low` and
`effort:small` / `effort:medium` / `effort:large`. Prose is invisible
to every query the backlog is actually triaged with, so ranking by
`Severity` costs one `gh issue view` per candidate while
`gh issue list --label severity:high` is one call. Set them at filing
time (`gh issue create ... --label severity:high --label effort:large`)
and again when a claim rewrites an old packed body into the four-line
shape (`gh issue edit <n> --add-label ...`), which is where `Severity`
first exists for most of the backlog. **Only these two get labels**:
`Session-fit` is re-decided at claim time and a label silently
disagreeing with the body is worse than none, and `Estimate` is a
free-form duration whose informative half — what actually eats the
time — is exactly what a label cannot hold. The prefixed full words
are the "no bare tokens" rule applied to a label: the two scales share
the token `medium`, and their initials collide in the dangerous
direction. Enforced by
`.claude/hooks/issue-classification-label-gate.sh`, which refuses a
`gh issue create` / `gh issue edit` whose body states a value the
issue's labels do not carry. **The PR inherits them automatically** —
`.github/workflows/pr-inherit-issue-labels.yml` copies every label of
the issues a PR closes onto the PR itself (add-only, minus the
release-management family), so never hand-add them to a PR. The copy
runs when the PR is opened, reopened, or its body edited, reading the
labels the issue carries AT THAT MOMENT — which is why the label
belongs on the issue at CLAIM time, before the lane's PR exists.

**Scales.** `Severity`: `high` = a wrong result, data loss, a security
surface, or something a user hits in normal operation; `medium` = a
capability is missing but there is a workaround, or it only shows up
under a specific condition; `low` = internal tidiness, invisible to
users. **Rate what a user experiences, never why this session should do
it** — "leaving main self-inconsistent" is a `Session-fit: now` trigger,
not a Severity level, and copying it here makes that flavour of `high`
permanently un-`next`-able. `Effort` measures the
verification tail rather than the edit: `small` = edit plus unit
tests, riding verification this session already pays for; `medium` = one
re-review round, or a run of an EXISTING integ fixture this session was not
otherwise going to run; `large` = a NEW integ fixture has to be WRITTEN, or a
behavior change needing its own PR plus review.

**Calibration: RUNNING an existing integ is not a reason to defer.** Measured
over the 268 rows of cdkd's `docs/_generated/integ-last-run.tsv` on 2026-08-20:
median run 85 s, mean 4.6 min, p90 8.8 min. A passing run costs a few hundred
tokens. If the session is running one for its current lane anyway, a fix riding
the same fixture costs zero — the same run refreshes the same gate. What is
genuinely expensive is WRITING a new fixture, and an integ that FAILS
(unbounded, and paid again next session). Defer on those.

Review of a larger diff also grows superlinearly, and that cost is real — but
it is a reason to SPLIT the PR, not to end the session, and it belongs under
`Effort`. This paragraph listed it as a third thing to "defer on" until
2026-09-05 — the criterion the NEXT paragraph refuses, arriving through the
back door one paragraph early; a body wording it as `unreviewable` is now
refused by `.claude/hooks/issue-deferral-criteria-gate.sh`, so the two halves
of this file would have contradicted each other AND the gate.

**PR SHAPE is not one of those reasons, and a gate now says so.**
`/work-issues` §5 ("'It needs its own PR' is NOT a `next` reason — it is a
`now` item that gets its own PR; the bar is the SESSION, not the diff") is
enforced at the filing site by
`.claude/hooks/issue-deferral-criteria-gate.sh`, which refuses a
`gh issue create` whose `Session-fit: next` reason reads `own PR` /
`separate PR` / `share a PR` / `independent` or `separate review surface` /
`own review` / `unreviewable`. The N-sites SWEEP §5 sanctions is still a
genuine `next`, but state it in the criteria's terms — "a sweep whose residue
carries its own verification … file an umbrella naming every site" — because
review size is the signal, not the criterion. `.claude/rules/hooks.md` carries
the measurement, and the 2026-09-05 reversal that put `unreviewable` back in
the vocabulary alongside the sibling repos.

**A newly DISCOVERED bug is not a residual.** A residual (deferred polish, a
nit, a parity gap) is fully describable, so writing it down loses nothing. A
discovery's expensive part is the EVIDENCE behind it — the repro you built,
what you watched actually happen, the number you measured — and that is exactly
what an issue body cannot carry cheaply. When a bug surfaces mid-session, ask
which it is: if the evidence is session-only, finish it now unless a genuine
defer criterion fires, and if you must defer it anyway, put the EVIDENCE in the
issue body, not just the diagnosis.

**A reason about the FILING SESSION's own STATE expires when that session
does.** It is a different failure from the one `/work-issues`
`references/implement.md` §5-c refuses outright — that one is a claim about
the PULL REQUEST ("it needs its own review surface"), which is never a
deferral reason at all. This one is a claim about the SESSION that filed it:
"the file is held by another open PR's diff", "the session that found it
budgeted no integ run", "that lane's scope was frozen at its final review
round". A PR can be named on either side, so the mention is not the tell —
ask which of the two the sentence is ABOUT. Session-state clauses are legal
and merely go STALE, and deciding-once does not protect them, because it
freezes the DECISION and not the PREMISE.

So prefer a reason the WORK owns. When a session-state clause is written
anyway, name the event that ENDS it on the same line — "unblocked the moment
that PR merges" is the model, because it is what lets a later reader see,
without asking anyone, that the reason has expired. The "no file overlap with
this session's lanes" reason needs it too: that is a claim about a MOVING
target, since the lane keeps editing after the reason is written
(go-to-k/cdkd#2440 was deferred on exactly it, and the same lane's merged PR
then changed that very file `+9/-2`). `/work-issues` `references/retro.md`
§10-0 re-checks every `next` at the end of a run, and this shape has been
caught in consecutive sibling runs — go-to-k/cdkd#2544 by that end-of-run
check, go-to-k/cdkd#2595 by the session that later claimed it.
Nothing mechanical closes it — the wording of an expired reason is
unremarkable, and only the question "what ends this?" separates it from a
live one.

**Before writing `next`, NAME the command the next session will run to
verify the fix.** Every deferral is a PREDICTION that a later session can
finish the work, and an unstated prediction is never checked: the reason
line decays into naming the KIND of work ("a fixture change", "a
different subsystem"), which is the MEANS rather than the purpose. You
may not write `Session-fit: next` until you can name the concrete
command (the fixture, not "the integ"; the assertion that goes red to
green, not "a test") and say a FRESH session will be able to run it. The
check is generative rather than a lookup, so it catches what no
enumerated trigger list contains: a verifier bound to this host (CPU
architecture, the platform of a Docker image, the daemon), to this
account (a `*-from-cfn-stack` integ fixture's `cdk deploy`), or one that
does not exist yet. On 2026-08-26 go-to-k/cdk-local#560 was deferred as "a
fixture / base-image change" when the real verification was two
`start-api` fixtures ON AN arm64 HOST, which a fresh session may not
have; on amd64 they never emulate, so a run there cannot see the fault.
`/work-issues` §5 carries the worked version, beside the filing recipe.

**`Session-fit: next` is not on the menu inside a cross-repo scope.** When the
user framed the work as "do this across the repos in one session", anything
discovered inside that scope is `now`, and three tells force it: (a) you are
about to file the SAME issue body in more than one repo, which is the split
the framing exists to end and not triage; (b) the fix is mechanical and its
evidence is live right now, with the repro built, the files open, and a gate
cycle already running; (c) the user already said "finish it here" for the
surrounding task, so a discovery inside that task inherits the instruction
instead of getting a budget of its own. The four fields exist to make a
deferral HONEST, not to make one available: a defensible-looking `Effort` /
`Estimate` written for work this session is already positioned to do is the
tell that the classification has turned into an excuse. On 2026-08-20 a
session asked to consolidate one `/work-issues` lesson across cdkd, cdk-local
and cdk-real-drift found that every PreToolUse gate was inert, fixed the
matchers in all three, and then filed the remaining script-level gap as three
separate issues, reproducing exactly the per-repo split the user had asked to
end. Fixing it in the same PRs was the correct move, and is what happened
once the user objected.

**One field per line — never pack two onto one**, and keep the field
names and their order identical every time. A field with nothing to
say gets an explicit `none`, never omission:

```text
## Remaining work
- TODO #<N> — <what it is>
  - Session-fit: now (do it in this session) | next (not this session) — <one line>
  - Severity: high | medium | low — <what stays broken while it is undone>
  - Effort: small (S) | medium (M) | large (L) — <which verification cycle it drags>
  - Estimate: <duration> — <what eats the time>
  - Notes: <session-specific context | none>
- Won't-do — <what>
  - Why: <one line>
  - Recorded: <PR body | in-code comment | issue>
(or the single line: Nothing remaining)
```
