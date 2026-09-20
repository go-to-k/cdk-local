---
name: review-pr
description: Recommend the right reviewer set for a PR from what it touches. Outputs a concrete plan (1 reviewer by default, plus the security lens or the spec + test axes when a trigger fires) with ready-to-paste Agent dispatch prompts.
argument-hint: "<PR-number>"
---

# PR Review Recommendation

Decide which reviewers a PR warrants and print the dispatch prompts. The skill
itself never spawns reviewers: the **main session orchestrator** reading its
output issues the `Agent` calls.

## The reviewer rule

- **1 `pr-code-reviewer` by default.** Every PR gets this one.
- **Add `pr-spec-reviewer` + `pr-test-reviewer`** when the `src/**` part of the
  diff exceeds **400 changed lines** or **8 files**.
- **Add a security-lens review** when the diff touches a secret / credential /
  process-launch / Docker-exec surface (see the list below). This repo has no
  `pr-security-reviewer` agent — dispatch a SECOND `pr-code-reviewer` carrying an
  explicit security question instead of inventing an agent that does not exist.
- **Reviewers run ONCE, on the FINAL sha** — after the last fix-back commit, not
  on an intermediate one. Reviewing early wastes the pass: the diff grows
  underneath it.
- **A fix round is re-checked by MESSAGING the same reviewer** (SendMessage to
  its agent id), never by dispatching a fresh one — the original still holds the
  context of what it flagged and what it already cleared.
- `pr-spec-reviewer` needs a design doc, or the bodies of the issues the PR says
  it closes. With neither, skip it and say so — spec review against nothing is
  noise.

When genuinely unsure between one reviewer and three, take three. Reviewers are
read-only and run in parallel; cost is not a tiebreaker for review depth.

## Steps

1. **Fetch the PR's stats and paths:**

   ```bash
   gh pr view <N> --json title,headRefName,files \
     -q '{title, branch: .headRefName, paths: [.files[].path]}'
   ```

2. **Measure the `src/**` part of the diff** — generated artifacts, lockfiles,
   docs and tests do not carry reviewer surface and do not count toward the
   threshold:

   ```bash
   gh pr view <N> --json files \
     -q '[.files[] | select(.path | startswith("src/"))]
         | {files: length, loc: (map(.additions + .deletions) | add // 0)}'
   ```

   `loc > 400` OR `files > 8` → add the spec and test axes.

3. **Scan `paths` for the security surface.** Any hit adds the security-lens
   pass, at any size:
   - _Credential / secret material_ — `src/utils/role-arn.ts`,
     `src/utils/profile-resolver.ts`, `src/utils/aws-proxy.ts`,
     `src/cli/commands/local-profile-credentials-file.ts`,
     `src/local/ecs-secrets-resolver.ts`, `src/local/ssm-parameter-resolver.ts`,
     `src/local/ecs-task-runner.ts`
   - _Inbound auth: verification, enforcement, request signing_ —
     `src/local/cognito-jwt.ts`, `src/local/lambda-authorizer.ts`,
     `src/local/sigv4-verify.ts`, `src/local/authorizer-resolver.ts`,
     `src/local/authorizer-cache.ts`, `src/local/front-door-auth.ts`,
     `src/local/agentcore-serve-auth.ts`, `src/local/agentcore-sigv4-sign.ts`,
     `src/local/http-server.ts`, `src/local/front-door-server.ts`,
     `src/local/agentcore-http-server.ts`, `src/local/websocket-server.ts`,
     `src/utils/url-authority.ts`
   - _Untrusted code / argv / archive + path traversal_ —
     `src/utils/docker-cmd.ts`, `src/local/docker-runner.ts`,
     `src/local/docker-image-builder.ts`, `src/local/ecr-puller.ts`,
     `src/assets/docker-build.ts`, `src/local/image-override-engine.ts`,
     `src/local/cloudfront-function-runtime.ts`, `src/local/studio-dispatch.ts`,
     `src/local/studio-serve-manager.ts`, `src/local/studio-option-catalog.ts`,
     `src/local/cloudfront-static-origin.ts`, `src/local/lambda-resolver.ts`,
     `src/local/agentcore-s3-bundle.ts`, `src/local/layer-arn-materializer.ts`

   The list is a floor, not a closed set: a module not on it that handles a
   secret, verifies a caller, or launches a process still earns the pass.

4. **Render the recommendation** (template below) and hand it to the
   orchestrator, which dispatches, waits for every reviewer, and synthesizes the
   findings into a verdict. Blockers (correctness bugs, security issues, test
   gaps) go back to the implementing agent; re-check them by messaging the
   reviewer that raised them.

## Output template

```
Reviewers: <pr-code-reviewer | + security lens | + spec + test>

PR #<N>: <title>
Branch: <branch>
src/** diff: <loc> lines across <files> files
Triggers:
  - <size threshold crossed / security path hit / "none">

Rationale: <one line>
```

Then emit one dispatch block per reviewer:

```
  Agent {
    subagent_type: "pr-code-reviewer",
    description: "PR <N> code review",
    prompt: |
      Review PR <N> (branch <branch>). Read your role definition at
      `.claude/agents/pr-code-reviewer.md` (relative to the repo root) and
      follow it. Review the FINAL sha; report file:line citations with severity.
  }
```

For the **security lens**, a second `pr-code-reviewer` with the tracing question
made explicit:

```
  Agent {
    subagent_type: "pr-code-reviewer",
    description: "PR <N> security review",
    prompt: |
      Review PR <N> (branch <branch>) through a SECURITY lens. Read
      `.claude/agents/pr-code-reviewer.md` and follow it, with this as the
      load-bearing question: for every sensitive value this diff touches
      (credential, secret, token, signing input, env var injected into a
      container, process argv), trace it from where it is WRITTEN to EVERY
      reader — log line, console output, cache, persisted file, container env,
      outbound request, error message. Report any reader that receives it
      unmasked, plus injection, path-traversal and deletion-safety issues.
      Touched security paths: <list them>.
  }
```

For the **spec + test axes** (dispatch in the same message as the code
reviewer, so they run in parallel):

```
  Agent {
    subagent_type: "pr-spec-reviewer",
    description: "PR <N> spec compliance review",
    prompt: |
      Review PR <N> (branch <branch>) against its spec. Read
      `.claude/agents/pr-spec-reviewer.md` and follow it.
      Spec: <design doc path, or the bodies of the issues the PR closes>
  }

  Agent {
    subagent_type: "pr-test-reviewer",
    description: "PR <N> test adequacy review",
    prompt: |
      Review PR <N> (branch <branch>) for test adequacy. Read
      `.claude/agents/pr-test-reviewer.md` and follow it.
  }
```

## Important

- **Never dispatch from inside this skill.** It recommends; the orchestrator
  acts.
- Extend any prompt with PR-specific context (concerns to deep-dive, files to
  focus on). The blocks are starting templates, not final prompts.
- The available agents are `pr-code-reviewer`, `pr-spec-reviewer` and
  `pr-test-reviewer` under `.claude/agents/`. Do not name any other.
