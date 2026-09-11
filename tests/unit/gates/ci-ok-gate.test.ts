import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

/**
 * Fence for the two jobs `.github/workflows/ci.yml` grew when the `main` branch
 * ruleset started requiring a status check — `ci-ok` and `release-pr-not-stale`.
 *
 * `ci-ok` is the SINGLE check the ruleset requires, and with auto-merge armed on
 * the release PR and on dependabot PRs, nobody is reading the checks at the
 * moment a merge happens. So the failure that matters is not "went red when it
 * should have been green" — that is loud and self-correcting — but "went GREEN
 * having examined nothing", which is indistinguishable from a clean run at
 * every surface a human or a hook looks at. Three such vacuities are reachable:
 *
 *   1. A job is added to the file and not to `ci-ok`'s `needs:`. It is then
 *      outside the gate and can be red under a green `ci-ok`.
 *   2. `if: always()` is dropped. `ci-ok` is then SKIPPED whenever an upstream
 *      job fails — and a skipped required check counts as PASSING.
 *   3. `RESULTS` renders empty. `for r in ${RESULTS}` runs zero times and the
 *      step exits 0. The `EXPECTED_UPSTREAM` count is the floor, and it is only
 *      a floor while it EQUALS the `needs:` length, asserted here rather than
 *      trusted to the comment beside it.
 *
 * `release-pr-not-stale` is a CHECKER, so it carries the same obligation every
 * checker here does: prove it still REFUSES, not merely that it ran. Its body
 * is three git invocations, each of which rots silently — drop the `!` from the
 * `merge-base` test, drop the `--` from `rev-list`, shrink the file list, and it
 * passes on every input including the stale one it exists to refuse.
 *
 * Both shells are EXTRACTED from the workflow and EXECUTED, never re-typed: a
 * copy in this file would keep passing after the workflow's copy was broken.
 * The workflow is read as TEXT rather than through a YAML parser for the reason
 * `release-please-v0.test.ts` in this directory already records — this repo
 * ships no YAML library, and adding one as a devDependency only for a fence
 * would be a heavier change than the fence.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CI_YML = join(repoRoot, '.github', 'workflows', 'ci.yml');
const RELEASE_YML = join(repoRoot, '.github', 'workflows', 'release.yml');

function ci(): string {
  return readFileSync(CI_YML, 'utf8');
}

/** Everything from a step's `- name:` line up to the next step at that indent. */
function stepSlice(stepName: string): string {
  const yml = ci();
  const start = yml.indexOf(`- name: ${stepName}`);
  expect(
    start,
    `the step \`- name: ${stepName}\` is gone from .github/workflows/ci.yml. If it was ` +
      `renamed, update this extractor; if it was REMOVED, restore it — this suite then ` +
      `attests to nothing.`
  ).toBeGreaterThan(-1);
  const next = yml.indexOf('\n      - ', start);
  return yml.slice(start, next === -1 ? undefined : next);
}

/** That step's `run: |` body, dedented to what the runner hands to bash. */
function runBody(stepName: string): string {
  const lines = stepSlice(stepName).split('\n');
  const runIdx = lines.findIndex((l) => /^\s*run: \|\s*$/.test(l));
  expect(runIdx, `the \`${stepName}\` step has no \`run: |\` body`).toBeGreaterThan(-1);
  const first = lines[runIdx + 1] ?? '';
  const indent = (/^\s*/.exec(first)?.[0] ?? '').length;
  expect(indent, `the \`${stepName}\` step's run body is empty`).toBeGreaterThan(0);
  const body: string[] = [];
  for (const line of lines.slice(runIdx + 1)) {
    if (line.trim() === '') {
      body.push('');
      continue;
    }
    if ((/^\s*/.exec(line)?.[0] ?? '').length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

/** Job ids, read from below `jobs:` so `on:`'s own 2-space keys cannot leak in. */
function jobNames(): string[] {
  const yml = ci();
  const jobsAt = yml.indexOf('\njobs:\n');
  expect(jobsAt, 'no `jobs:` block in .github/workflows/ci.yml').toBeGreaterThan(-1);
  return [...yml.slice(jobsAt).matchAll(/^ {2}([a-zA-Z0-9_-]+):$/gm)].map((m) => m[1] as string);
}

function ciOkNeeds(): string[] {
  const m = /^ {4}needs: \[([^\]]*)\]$/m.exec(stepSliceForJob('ci-ok'));
  expect(m, 'ci-ok has no inline `needs: [...]` list').not.toBeNull();
  return (m as RegExpExecArray)[1]!.split(',').map((s) => s.trim());
}

/** Everything from a job's `  <id>:` line to the next job at that indent. */
function stepSliceForJob(jobId: string): string {
  const yml = ci();
  const header = `\n  ${jobId}:\n`;
  const start = yml.indexOf(header);
  expect(start, `job \`${jobId}\` is gone from .github/workflows/ci.yml`).toBeGreaterThan(-1);
  // Search AFTER the job's own header line — searching from `start + 1` finds
  // that very line at offset 0 and yields a one-character slice, which then
  // makes every `toContain` below fail for a reason that has nothing to do
  // with the workflow.
  const bodyAt = start + header.length;
  const next = yml.slice(bodyAt).search(/^ {2}[a-zA-Z0-9_-]+:$/m);
  const slice = next === -1 ? yml.slice(start) : yml.slice(start, bodyAt + next);
  // Non-vacuity: a slice that lost the body would satisfy every `not.toContain`
  // in this file while asserting nothing.
  expect(slice.length, `the extracted slice for job \`${jobId}\` is empty`).toBeGreaterThan(
    header.length
  );
  return slice;
}

function bashStatus(script: string, env: Record<string, string>, cwd?: string): {
  status: number;
  output: string;
} {
  try {
    const output = execFileSync('bash', ['-c', script], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: 'pipe',
    });
    return { status: 0, output };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('ci-ok — the single required status check', () => {
  it('gates every other job in the workflow', () => {
    const names = jobNames();
    // Non-vacuity floor: with one job the set equality below is trivially
    // satisfiable and this case attests to nothing.
    expect(
      names.length,
      'ci.yml has fewer jobs than when this fence was written — re-read it before lowering this floor.'
    ).toBeGreaterThanOrEqual(4);

    const gated = new Set(ciOkNeeds());
    const ungated = names.filter((n) => n !== 'ci-ok' && !gated.has(n));
    expect(
      ungated,
      `these ci.yml jobs are not in ci-ok's \`needs:\`, so they are outside the merge gate ` +
        `and can be red while the required check is green: ${ungated.join(', ')}. Add them ` +
        `to \`needs:\` and bump EXPECTED_UPSTREAM.`
    ).toEqual([]);

    const phantom = [...gated].filter((n) => !names.includes(n));
    expect(phantom, `ci-ok \`needs:\` names jobs that do not exist: ${phantom.join(', ')}`).toEqual(
      []
    );
  });

  it('runs even when an upstream job failed', () => {
    expect(stepSliceForJob('ci-ok')).toContain('if: always()');
  });

  it('declares the upstream count its shell checks against', () => {
    const m = /^ {6}EXPECTED_UPSTREAM: '(\d+)'$/m.exec(stepSliceForJob('ci-ok'));
    expect(m, 'ci-ok has no EXPECTED_UPSTREAM env entry').not.toBeNull();
    expect((m as RegExpExecArray)[1]).toBe(String(ciOkNeeds().length));
  });

  it('takes the results through env, not as inlined expression text', () => {
    expect(runBody('every upstream job succeeded or was skipped')).not.toContain('${{');
    expect(stepSliceForJob('ci-ok')).toContain('join(needs.*.result');
  });

  describe('the extracted step', () => {
    const script = () => runBody('every upstream job succeeded or was skipped');
    const run = (results: string) =>
      bashStatus(script(), { RESULTS: results, EXPECTED_UPSTREAM: '3' }).status;

    it('passes when every upstream job succeeded', () => {
      expect(run('success success success')).toBe(0);
    });

    it('passes when an upstream job was skipped', () => {
      expect(run('success skipped success')).toBe(0);
    });

    it('fails on a failed upstream job', () => {
      expect(run('success failure success')).not.toBe(0);
    });

    it('fails on a cancelled upstream job', () => {
      expect(run('success cancelled success')).not.toBe(0);
    });

    it('fails when the results render empty', () => {
      // THE case this floor exists for: the loop runs zero times, so without
      // the count check "all good" and "examined nothing" are the same exit 0.
      expect(run('')).not.toBe(0);
    });

    it('fails when fewer results arrive than the needs list declares', () => {
      expect(run('success success')).not.toBe(0);
    });
  });
});

describe('release-pr-not-stale', () => {
  const CHANGELOG = 'CHANGELOG.md';
  const MANIFEST = '.release-please-manifest.json';
  const STEP = 'release-please-owned files on main must be ancestors of this branch';

  interface Fixture {
    /** Bare remote the guard's `git fetch origin main` will read. */
    remote: string;
    /** Commit that last touched the file this fixture is about. */
    tip: string;
    /** The commit before it — what a branch left behind would be cut from. */
    base: string;
  }

  let scratch: string;
  let cloneSeq = 0;
  let changelogFixture: Fixture;
  let manifestFixture: Fixture;
  let noManifestFixture: Fixture;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        // Hermetic: a maintainer's global config must not decide the verdict.
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.invalid',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.invalid',
      },
    }).trim();
  }

  function commit(repo: string, file: string, body: string, subject: string): string {
    writeFileSync(join(repo, file), body);
    git(repo, 'add', file);
    git(repo, 'commit', '-q', '-m', subject);
    return git(repo, 'rev-parse', 'HEAD');
  }

  /**
   * A main history ending in a commit that touches ONLY `lastFile`, so a branch
   * cut at `base` is stale by that file and by nothing else — which is what
   * makes each arm of the production loop separately observable.
   *
   * `seedManifest: false` builds a history where the manifest NEVER existed, so
   * `git rev-list -1 ... -- <manifest>` comes back empty and the fail-closed
   * branch is reached with the CHANGELOG arm passing.
   */
  function makeRemote(name: string, lastFile: string, seedManifest = true): Fixture {
    const origin = join(scratch, `${name}-origin`);
    mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'main');
    writeFileSync(join(origin, CHANGELOG), '# Changelog\n\n## 0.1.0\n');
    if (seedManifest) writeFileSync(join(origin, MANIFEST), '{ ".": "0.1.0" }\n');
    git(origin, 'add', '.');
    git(origin, 'commit', '-q', '-m', 'chore(release): 0.1.0');
    const base = commit(origin, 'src.txt', 'work\n', 'feat: something');
    const tip =
      lastFile === CHANGELOG
        ? commit(origin, CHANGELOG, '# Changelog\n\n## 0.1.0 (normalized)\n', 'chore(docs): normalize')
        : commit(origin, MANIFEST, '{ ".": "0.1.0-edited" }\n', 'chore: hand-edit the manifest');

    const remote = join(scratch, `${name}-remote.git`);
    execFileSync('git', ['clone', '-q', '--bare', origin, remote], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    return { remote, tip, base };
  }

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cdklocal-release-stale-'));
    changelogFixture = makeRemote('changelog', CHANGELOG);
    manifestFixture = makeRemote('manifest', MANIFEST);
    // Main never had the manifest at all — the "cannot answer" path, with the
    // CHANGELOG arm deliberately able to pass so it cannot mask the verdict.
    noManifestFixture = makeRemote('nomanifest', CHANGELOG, false);
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  /** A release branch cut from `at`, with release-please's own commit on top. */
  function releaseBranchAt(fixture: Fixture, at: string): string {
    const wt = join(scratch, `wt-${cloneSeq++}`);
    execFileSync('git', ['clone', '-q', fixture.remote, wt], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    git(wt, 'checkout', '-q', '-b', 'release-please--branches--main', at);
    commit(wt, 'RELEASE_NOTE.txt', 'release-please commit\n', 'chore(release): 0.1.1');
    return wt;
  }

  const guard = (cwd: string) =>
    bashStatus(runBody(STEP), { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }, cwd);

  describe('the checkout the guard depends on', () => {
    // `refs/pull/N/merge` has the base already merged in, so every ancestry
    // question answers "yes" no matter how stale the branch is. Losing this
    // `ref:` is the one mutation that makes the whole job vacuous while its
    // shell is still perfectly correct — and a suite that reads only the
    // ancestry step stays green through it.
    it('takes the PR HEAD, not the default merge ref', () => {
      expect(stepSliceForJob('release-pr-not-stale')).toContain(
        'ref: ${{ github.event.pull_request.head.sha }}'
      );
    });

    it('fetches the full history the ancestry test needs', () => {
      expect(stepSliceForJob('release-pr-not-stale')).toContain('fetch-depth: 0');
    });
  });

  describe('each owned file separately', () => {
    it('passes on a release branch cut from current main', () => {
      const { status, output } = guard(releaseBranchAt(changelogFixture, 'origin/main'));
      expect(status).toBe(0);
      expect(output).not.toContain('::error::');
    });

    it('fails when main moved CHANGELOG.md after the branch was cut', () => {
      // The shape release-please leaves behind: a `chore(docs):` commit
      // produces no changelog entry, so it does not rebuild the PR, and merging
      // the stale branch reverts the normalization while GitHub reports
      // MERGEABLE.
      const { status, output } = guard(releaseBranchAt(changelogFixture, changelogFixture.base));
      expect(status).not.toBe(0);
      expect(output).toContain(CHANGELOG);
      expect(output).toContain(changelogFixture.tip);
      expect(output).toContain('re-run release.yml');
      // Only this arm may fire here — otherwise the case cannot tell a
      // per-file check from one that refuses everything.
      expect(output).not.toContain(`${MANIFEST} was last changed`);
    });

    it('fails when main moved the manifest after the branch was cut', () => {
      // Without this case the manifest arm never discriminates, and gating the
      // ancestry test on `[ "${f}" = "CHANGELOG.md" ]` survives the suite.
      const { status, output } = guard(releaseBranchAt(manifestFixture, manifestFixture.base));
      expect(status).not.toBe(0);
      expect(output).toContain(MANIFEST);
      expect(output).toContain(manifestFixture.tip);
      expect(output).not.toContain(`${CHANGELOG} was last changed`);
    });

    it('fails closed when an owned file has no history on main', () => {
      // "The guard cannot answer" must not read as "the guard found nothing
      // wrong". The CHANGELOG arm passes in this fixture, so the non-zero exit
      // can only come from the empty-tip branch.
      const { status, output } = guard(releaseBranchAt(noManifestFixture, 'origin/main'));
      expect(status).not.toBe(0);
      expect(output).toContain('cannot evaluate staleness');
      expect(output).toContain(MANIFEST);
      expect(output).not.toContain(`${CHANGELOG} has no commit history`);
    });
  });

  describe('the job stays wired to the thing it guards', () => {
    it('checks exactly the files release-please owns', () => {
      // Read the loop's actual subject list rather than asserting a substring
      // is absent — `not.toContain('package.json')` passes over an empty string
      // and over a shell that checks nothing at all.
      const m = /^for f in (.+); do$/m.exec(runBody(STEP));
      expect(m, "the guard's `for f in ...; do` loop is gone").not.toBeNull();
      expect((m as RegExpExecArray)[1]!.trim().split(/\s+/).sort()).toEqual(
        [CHANGELOG, MANIFEST].sort()
      );
    });

    it('is guarded by the branch prefix release-please actually produces', () => {
      expect(stepSliceForJob('release-pr-not-stale')).toContain(
        "if: startsWith(github.head_ref, 'release-please--')"
      );
      // RESIDUAL, stated rather than implied away: this repo has not yet had a
      // release-please-created PR (batched releases landed recently and no
      // release has been cut), so the prefix is release-please's documented
      // default rather than an observed branch name here. The FIRST release PR
      // must be checked — if its head does not start with `release-please--`,
      // this job skips on every PR and `ci-ok` stays green over it.
      //
      // `branch-prefix` is NOT a release-please config key, so asserting its
      // absence would be a fence over something that can never appear. What can
      // actually move the prefix is a release-please MAJOR, and the action is
      // SHA-pinned — so the pin's major is the real change vector: bumping it
      // must force a re-check, and dependabot's patch bumps must not.
      const pin = /googleapis\/release-please-action@[0-9a-f]{40} # v(\d+)/.exec(
        readFileSync(RELEASE_YML, 'utf8')
      );
      expect(pin, 'release.yml no longer SHA-pins googleapis/release-please-action').not.toBeNull();
      expect(
        (pin as RegExpExecArray)[1],
        'release-please was bumped to a new MAJOR. Its release branch prefix is a property ' +
          `of that major — re-verify that a release PR's head still starts with ` +
          "'release-please--' before updating this expectation."
      ).toBe('4');
    });
  });
});
