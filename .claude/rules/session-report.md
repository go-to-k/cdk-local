# Session-wrap report: the full field reference

CLAUDE.md states the contract; this file carries the field semantics, scales and
templates. Read it when writing a wrap report or filing a deferral.

**The four TODO fields — decide them WHEN THE ITEM ARISES, not at wrap time.**
By wrap time the evidence for the call (which files were open, which
verification cycle was already paid for) is gone. Record them **in the issue
body** so they outlive the session. The issue body and the report use the SAME
four lines, one field per line:

```text
Session-fit: now (do it in this session) | next (not this session) — <reason>
Severity: high | medium | low — <what stays broken while it is undone>
Effort: small (S) | medium (M) | large (L) — <which verification cycle it drags>
Estimate: <duration, e.g. ~1-3 h> — <what eats the time>
```

A report adds a fifth line, **`Notes`**, for session-specific context (`none`
when there is nothing); the issue body carries no `Notes` — what belongs there
is only what outlives the session. Before filing, SEARCH the open issues for one
already covering the same root cause; duplicates split the evidence.

**The four answer four DIFFERENT questions and none is a spelling of another**
(one sanctioned link: `Severity: high` forces `now` unless external input blocks
it). `Session-fit` is the decision, `Severity` the cost of leaving it undone,
`Effort` which verification cycle the fix drags, `Estimate` the hours.
Do not collapse `Severity` into `Session-fit` — a `Severity: high` item can
still be `next` (external input) and a `low` one is usually `now` (it lands in a
file this session already has open); `Severity` says what a USER suffers,
`Session-fit` what THIS session does. Likewise `Effort` is not `Estimate`: "one
integ run" is a kind of cost; its hours depend on which fixture.

**The keys are spelled identically everywhere** — issue body, English report,
Japanese report; never translated or renamed. **No bare tokens**, because a
value must be readable without knowing the internal scale: write
`Session-fit: next (not this session)` and never a lone `next`; `Effort: large
(L)` and never a lone `L`; `Severity` as a word and **never as an initial** (the
initials collide with `Effort`'s both ways — `M` is `medium` on either scale,
and `L` would be *low*, the least urgent thing there is, against *large*); and
always BOTH `Effort` and `Estimate`.

**`Severity` and `Effort` are ALSO LABELS on a filed issue.** The two lines stay
as written, and the same values are mirrored onto the issue as
`severity:high|medium|low` and `effort:small|medium|large` — prose is invisible
to every query the backlog is triaged with. Set them at filing
(`gh issue create ... --label severity:high --label effort:large`) and again
when a claim rewrites an old packed body into the four-line shape. **Only these
two get labels**: `Session-fit` is re-decided at claim time and a label silently
disagreeing with the body is worse than none, and `Estimate`'s informative half
— what eats the time — a label cannot hold. The prefixed full words apply the
"no bare tokens" rule to labels: the two scales share `medium` and their
initials collide. **The PR inherits them automatically** —
`.github/workflows/pr-inherit-issue-labels.yml` copies every label of the issues
a PR closes onto the PR (add-only, minus the release-management family), so
never hand-add them to a PR. It reads the issue's labels when the PR is opened,
reopened or its body edited — which is why the label belongs on the ISSUE at
CLAIM time, before the lane's PR exists.

## Scales

`Severity`: `high` = a wrong result, data loss, a security surface, or something
a user hits in normal operation; `medium` = a capability is missing but there is
a workaround, or it shows up only under a specific condition; `low` = internal
tidiness, invisible to users. **Rate what a user experiences, never why this
session should do it** — "leaving main self-inconsistent" is a `Session-fit: now`
trigger, not a Severity level; rating it `high` smuggles that trigger through
the wrong field, and `high` forces `now`, so a misrated one cannot be re-judged.

`Effort` measures the verification tail, not the edit: `small` = edit plus unit
tests, riding verification this session already pays for; `medium` = one
re-review round, or a run of an EXISTING integ fixture this session was not
otherwise going to run; `large` = a NEW integ fixture has to be WRITTEN, or a
behavior change needing its own PR plus review.

## `now` is the DEFAULT; `next` needs one of two reasons

**Write the CONTEXT TEST before the decision**: list the files the fix touches
or must read to be made correctly (tests and docs included), and say, per file,
whether this session already READ it — read, edited, or reviewed in a diff; a
reviewer's read set counts like an author's. ONE loaded file makes the
item `now`: a fresh session re-pays install, build, the module read and the
evidence re-derivation before its first edit, while this session pays the edit
alone. Precedence: reason (a) asks whether the work CAN finish here and is
decided first; (b) is what the test gates.

- **`now`** — any of: a file the fix touches is loaded (above); skipping it
  leaves main self-inconsistent (docs contradicting shipped code, a stale
  rationale comment, a fixture that no longer discriminates); it blocks another
  lane; it rides an EXISTING integ fixture; its evidence exists only in this
  session (a live repro, a measurement); the user cannot use the result yet
  (unreleased — "merged" is not done);
  **leaving it loose compounds** — an integ fixture not yet written for a
  subsystem this session holds, a pattern landed at some sites and not others, a
  guard with a known hole: the cost grows FOR THE REPO every session, and a
  deferred fixture is the piece that never lands; or **`Severity: high`** — a
  wrong result, data loss, or a security surface — unless (a) blocks it. **Residuals of a just-merged lane** — polish, nits,
  parity gaps, sibling sites a review named — are the hottest context there is;
  "only a residual" names no cost. Writing a NEW integ fixture is
  `Effort: large`, a cost to record, never a reason to defer.
- **`next`** — ONLY one of: (a) external input (a quota, an upstream fix, a host
  this machine is not, a file held by another lane's OPEN PR, or a maintainer
  decision already asked through `AskUserQuestion` and unanswered; a routine
  call is yours to make); or (b) the work is COLD AND HEAVY — nothing the fix
  touches or must read was read this session, no `now` criterion fires, AND
  doing it here is clearly WORSE than fresh, not merely as costly: name the
  modules to load and why loading them beside THIS session's context degrades
  the work. Cold alone is not (b) — a small cold fix is `now`.
  (b) is legitimate, but RARE: fired twice in one run, or on an item with a
  loaded file, it is the reflex rather than the reason (`/work-issues` §10-0
  counts them). **Nothing about the SESSION
  is a reason**: its length, the context left, "it has done enough", a wrap
  report already drafted, the PR already merged. The wrap reflex fires exactly
  when the context is richest, which is why it produces `next` — so re-run the
  context test on every `next` before the final report.

**Calibration: RUNNING an existing integ is not a reason to defer.** A passing
run is minutes, and if the session is running one for its lane anyway, a fix riding
the same fixture costs zero — the same run refreshes the same gate. What is
genuinely expensive is WRITING a new fixture, and an integ that FAILS. Both are
`Effort` / `Estimate` lines, not reasons: the fixture is written cheapest while
the subsystem is loaded, and unbounded here is unbounded next session too.
Review of a larger diff grows superlinearly — but that is a reason to SPLIT the
PR, not to end the session.

**PR SHAPE is not a reason.** "It needs its own PR" is a `now` item that gets
its own PR; the bar is the SESSION, not the diff. Neither is "separate review
surface" / "unreviewable". An N-sites SWEEP is `next` ONLY on reason (a) — its
files are loaded by construction — so state it that way and file an umbrella
naming every site.

**A newly DISCOVERED bug is `now` even in a COLD subsystem.** Its expensive part
is the EVIDENCE — the repro you built, what you watched happen, the number you
measured — which is exactly what an issue body cannot carry cheaply, unless that
evidence is already PERSISTED in the repo (a committed fixture), when (b)
applies as usual. If you defer it anyway, put the EVIDENCE in the issue body,
not just the diagnosis.

**A reason about the FILING SESSION's own STATE expires when that session
does** — "the session that found it budgeted no integ run", "that lane's scope
was frozen at its final review round". Of that family only "the file is held by
another open PR's diff" survives, as reason (a), ending at that merge. A PR can
be named on either side of this line, so ask which the sentence is ABOUT — the
session, or the PR (which is never a reason at all; see PR SHAPE above).

So prefer a reason the WORK owns. A session-state clause is legal only as the
EXPIRY event of a `next` reason: name the event that ENDS it on the same line —
"unblocked the moment that PR merges" — so a later reader can see, without
asking anyone, that the reason has expired. "No file overlap with this session's
lanes" needs it too: it is a claim about a MOVING target, since the lane keeps
editing after the reason is written. Only the question "what ends this?"
separates an expired reason from a live one, and `/work-issues`
`references/retro.md` §10-0 re-asks it of every `next`.

**Before writing `next`, NAME the command the next session will run to verify
the fix.** Every deferral predicts that a later session can finish the work, and
an unstated prediction is never checked: the reason line decays into naming the
KIND of work ("a fixture change"), which is the MEANS rather than the purpose.
Do not write `Session-fit: next` until you can name the concrete command (the
fixture, not "the integ"; the assertion that goes red to green, not "a test")
and say a FRESH session can run it. Being generative rather than a lookup, this
catches what no trigger list contains: a verifier bound to this host (CPU
architecture, a Docker image's platform), to this account (a `*-from-cfn-stack`
fixture's `cdk deploy`), or one that does not exist.

**`Session-fit: next` is not on the menu inside a cross-repo scope.** When the
user framed the work as "do this across the repos in one session", anything
discovered inside that scope is `now`. Three tells force it: (1) you are about
to file the SAME issue body in more than one repo — the split the framing exists
to end; (2) the fix is mechanical and its evidence is live right now; (3) the
user already said "finish it here" for the surrounding task, so a discovery
inside it inherits that instruction. The four fields exist to make a deferral
HONEST, not to make one available: a defensible-looking `Effort` / `Estimate`
written for work this session is already positioned to do is the tell that
classification has turned into excuse.

## Template

**One field per line — never pack two onto one**, with the field names and their
order identical every time. A field with nothing to say gets an explicit `none`,
never omission:

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
