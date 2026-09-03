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
    // Publish only runs on an actual release (the release-PR merge), never on
    // the ordinary pushes that merely update the release PR.
    expect(workflow).toMatch(
      /if: \$\{\{ needs\.release-please\.outputs\.release_created == 'true' \}\}/,
    );

    // The guard's load-bearing refusal: computed major != 0 exits non-zero
    // before npm publish can run.
    const guardIndex = workflow.indexOf('"$MAJOR" != "0"');
    expect(guardIndex, 'v0 guard condition missing from release.yml').toBeGreaterThan(-1);
    const guardBlock = workflow.slice(guardIndex, guardIndex + 400);
    expect(guardBlock, 'v0 guard must hard-fail (exit 1)').toContain('exit 1');

    // `run: npm publish` is the STEP, distinct from the header comment's
    // prose mention of npm publish earlier in the file.
    const publishIndex = workflow.indexOf('run: npm publish');
    expect(publishIndex, 'npm publish step missing').toBeGreaterThan(-1);
    expect(guardIndex, 'v0 guard must run before npm publish').toBeLessThan(publishIndex);
  });

  it('the release-please action is pinned to a full commit sha', () => {
    const workflow = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8');
    expect(workflow).toMatch(/uses: googleapis\/release-please-action@[0-9a-f]{40}( |$)/m);
  });
});
