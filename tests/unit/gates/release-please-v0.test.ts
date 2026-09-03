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

  it('the publish job refuses a non-0 major before npm publish', () => {
    const workflow = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8');
    // Everything below is asserted against the publish JOB's slice of the
    // file (it is the last job, so slicing from its header reaches EOF) —
    // keeping the `if:` / permissions pins from being satisfied by a line
    // belonging to the release-please job.
    const publishJobIndex = workflow.indexOf('\n  publish:');
    expect(publishJobIndex, 'publish job missing from release.yml').toBeGreaterThan(-1);
    const publishJob = workflow.slice(publishJobIndex);

    // Publish only runs on an actual release (the release-PR merge), never on
    // the ordinary pushes that merely update the release PR. Exact
    // full-expression pin on the whole `if:` line: a weakening such as
    // `always() ||` prepended to the same expression must fail, which a
    // substring match would let through.
    expect(publishJob).toMatch(
      /^    if: \$\{\{ needs\.release-please\.outputs\.release_created == 'true' \}\}$/m,
    );

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
    // npm publish earlier in the file.
    const publishIndex = publishJob.search(/^\s*run: npm publish$/m);
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
