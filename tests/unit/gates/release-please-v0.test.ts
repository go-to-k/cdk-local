import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

/**
 * v0 release fence.
 *
 * cdk-local deliberately stays at major version 0 — a v1.0.0 release must be
 * impossible to ship by accident. Releases are batched via release-please
 * (release-please-config.json + .github/workflows/release.yml), and the v0
 * requirement rests on two independent layers this suite pins:
 *
 *   1. `bump-minor-pre-major: true` — while the version is < 1.0.0, a
 *      breaking-change commit bumps MINOR (0.x.0), never 1.0.0. Without it,
 *      release-please's default maps a `feat!:` / BREAKING CHANGE footer
 *      straight to 1.0.0.
 *   2. The publish job's guard step — it hard-fails before `npm publish`
 *      when the computed major is not 0, which also covers the paths layer 1
 *      cannot (a manual `Release-As: 1.0.0` footer, a hand-edited manifest).
 *
 * Losing either layer is silent until the wrong tag exists, so both are
 * fenced here rather than trusted. The version-shaped assertions on the
 * manifest and package.json are the same invariant read from the state
 * files: they go red the moment anything moves the tracked version out of
 * 0.x, and deleting them is the deliberate act a real 1.0.0 would require.
 *
 * The workflow assertions read release.yml as TEXT rather than through a
 * YAML parser: unlike the sibling cdkd (whose runtime `yaml` dependency its
 * twin of this suite borrows), this repo ships no YAML library, and adding
 * one as a devDependency only for this fence would be a heavier change than
 * the fence itself. The strings pinned here are exact-match load-bearing
 * lines, the same idiom the hook suites in this directory's neighbours use.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('release-please v0 fence', () => {
  it('bump-minor-pre-major keeps breaking changes below 1.0.0', () => {
    const config = JSON.parse(readFileSync(join(repoRoot, 'release-please-config.json'), 'utf8'));
    const pkg = config.packages?.['.'];
    expect(pkg).toBeDefined();
    expect(pkg['release-type']).toBe('node');
    expect(pkg['bump-minor-pre-major']).toBe(true);
  });

  it('release PR titles keep the chore(release) convention', () => {
    const config = JSON.parse(readFileSync(join(repoRoot, 'release-please-config.json'), 'utf8'));
    const pattern = config.packages?.['.']?.['pull-request-title-pattern'];
    // chore(release) passes the pr-title-check workflow and, squashed, does
    // not feed a feat/fix bump back into the next release computation.
    expect(pattern).toMatch(/^chore\(release\): /);
    expect(pattern).toContain('${version}');
  });

  it('the tracked versions are still 0.x', () => {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, '.release-please-manifest.json'), 'utf8'),
    );
    expect(manifest['.']).toMatch(/^0\./);
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    expect(pkg.version).toMatch(/^0\./);
  });

  /**
   * CHANGELOG.md format conformance.
   *
   * release-please's Changelog updater (updaters/changelog.js) finds where to
   * insert the next release with
   *
   *   const position = content.search(/\n###? v?[0-9[]/s);
   *
   * and splices the new entry in FRONT of that match. The leading `\n` is
   * load-bearing: a file that BEGINS with a version header never matches its
   * own top entry, so the search lands on the SECOND header and every release
   * is filed one section too low — compounding, since it repeats at the same
   * spot each time. The `##`/`###` alternation is a second cause on the same
   * line: semantic-release wrote H1 (`# [x.y.z]`) headers for minor/major
   * bumps, which the regex cannot see at all.
   *
   * Measured live on go-to-k/cdkd#2503, whose first real release PR ordered
   * the file 0.285.13, 0.285.14, 0.285.12. This repo's CHANGELOG.md was
   * normalized to release-please's own format (a `# Changelog` title block at
   * the TOP, every version header H2) so the file stays conformant with
   * nothing to do per release.
   */
  it('release-please splices the next entry at the TOP of CHANGELOG.md', () => {
    const changelog = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
    // The updater's own expression, verbatim.
    const spliceAt = changelog.search(/\n###? v?[0-9[]/s);
    const firstHeaderAt = changelog.search(/^#{1,3} v?[0-9[]/m);
    expect(spliceAt, 'release-please found no insertion point at all').toBeGreaterThan(-1);
    expect(firstHeaderAt, 'CHANGELOG.md carries no version header').toBeGreaterThan(-1);
    // Asserting the OUTCOME rather than either cause: the splice point must
    // sit immediately before the FIRST version header (the `\n` the search
    // consumes is the one-character offset), so a missing title block, an H1
    // top entry, or any third cause all fail here.
    expect(
      spliceAt + 1,
      'the next release would be spliced below the newest entry, not above it',
    ).toBe(firstHeaderAt);
  });

  it('every version header is the H2 form release-please emits', () => {
    const changelog = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
    expect(
      changelog.match(/^# v?[0-9[].*$/gm) ?? [],
      'H1 version headers are invisible to release-please\'s `###?` search',
    ).toEqual([]);
    // Floor, so the case cannot pass vacuously on an emptied or restructured
    // file: the normalization converted 148 H1 headers on top of 110 already
    // H2, and the count only grows from here.
    expect((changelog.match(/^## v?[0-9[].*$/gm) ?? []).length).toBeGreaterThanOrEqual(258);
  });

  it('the publish job refuses a non-0 major before npm publish', () => {
    const workflow = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8');
    // Everything below is asserted against the publish JOB's slice of the
    // file — keeping the `if:` / permissions pins from being satisfied by a
    // line belonging to a SIBLING job. The slice is bounded on both sides:
    // it starts at the publish job header and ends at the next indent-2 job
    // header if one exists (today publish is last and the slice reaches
    // EOF, but a job appended after it must not be able to satisfy these
    // pins on publish's behalf — review round 3's vacuous-pass finding).
    const publishJobIndex = workflow.indexOf('\n  publish:');
    expect(publishJobIndex, 'publish job missing from release.yml').toBeGreaterThan(-1);
    const afterHeader = workflow.slice(publishJobIndex + '\n  publish:'.length);
    const nextJobHeader = afterHeader.match(/\n  [\w-]+:\n/);
    const publishJob = nextJobHeader
      ? workflow.slice(
          publishJobIndex,
          publishJobIndex + '\n  publish:'.length + nextJobHeader.index!,
        )
      : workflow.slice(publishJobIndex);

    // Publish only runs on an actual release (the release-PR merge), never on
    // the ordinary pushes that merely update the release PR. Exact
    // full-expression pin on the whole `if:` line (indent-exact, like every
    // line pin in this case): a weakening such as `always() ||` prepended to
    // the same expression must fail, which a substring match would let
    // through.
    expect(
      publishJob,
      'publish job `if:` must gate on exactly release_created == true',
    ).toMatch(/^    if: \$\{\{ needs\.release-please\.outputs\.release_created == 'true' \}\}$/m);

    // npm OIDC trusted publishing needs the id-token grant on the publish
    // job; losing it turns every real release into a publish failure.
    expect(publishJob, 'publish job must carry id-token: write').toMatch(
      /^      id-token: write$/m,
    );

    // The guard's load-bearing refusals. Each arm's body is bounded at its
    // own terminator (the first following `fi` line for the if-arms, `;;`
    // for the case arm) before asserting `exit 1` inside it — an unbounded
    // window can be satisfied by a NEIGHBORING arm's exit 1, so softening
    // one arm to a warning would stay green (found in review round 2 here
    // and in the cdkd twin, go-to-k/cdkd@67a0a166).
    const pkgArm = publishJob.match(
      /if \[ "\$PKG_VERSION" != "\$VERSION" \]; then\n([^]*?)\n\s*fi\n/,
    );
    expect(pkgArm, 'PKG_VERSION mismatch arm missing').not.toBeNull();
    expect(pkgArm![1], 'PKG_VERSION mismatch arm must hard-fail').toContain('exit 1');

    const majorArm = publishJob.match(/if \[ "\$MAJOR" != "0" \]; then\n([^]*?)\n\s*fi\n/);
    expect(majorArm, 'MAJOR != 0 arm missing').not.toBeNull();
    expect(majorArm![1], 'MAJOR != 0 arm must hard-fail').toContain('exit 1');

    // The 0.* case arm is the third, independent spelling of the same fence:
    // its default `*)` branch must refuse too.
    expect(publishJob).toContain('0.*)');
    const caseArm = publishJob.match(/\*\)\n([^]*?)\n\s*;;/);
    expect(caseArm, 'case default arm missing').not.toBeNull();
    expect(caseArm![1], 'case default arm must hard-fail').toContain('exit 1');

    // Exact pin on purpose: any flag added to npm publish (e.g.
    // --provenance) must be a deliberate test edit, not a silent drift of
    // what ships. Also distinct from the header comment's prose mention of
    // npm publish earlier in the file. Indent-exact (8 spaces: a step's
    // `run:` key), consistent with the `if:` / id-token pins above.
    const publishIndex = publishJob.search(/^        run: npm publish$/m);
    expect(
      publishIndex,
      'no step whose run is exactly `npm publish` (a flag change must update this pin)',
    ).toBeGreaterThan(-1);
    const guardIndex = publishJob.indexOf('"$MAJOR" != "0"');
    expect(guardIndex, 'v0 guard must run before npm publish').toBeLessThan(publishIndex);
  });

  it('the release-please action is pinned to a full commit sha', () => {
    const workflow = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8');
    expect(workflow).toMatch(/uses: googleapis\/release-please-action@[0-9a-f]{40}( |$)/m);
  });
});
