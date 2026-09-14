import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import { parse as parseYaml } from 'yaml';

/**
 * Fence for go-to-k/cdk-local#722: the published Node.js floor is ONE number
 * that lives in FIVE places, and before this fence each moved on its own.
 *
 *   1. `package.json` `engines.node` — what npm / pnpm enforce at install.
 *   2. `vite.config.ts` `pack.target` — the syntax level tsdown emits, i.e.
 *      what the shipped `dist/` actually needs to run.
 *   3. `.github/workflows/ci.yml` `runtime-compat` matrix — the Node versions
 *      the built artifact is smoke-tested on. Its MINIMUM is the floor CI
 *      actually proves; a matrix still carrying an older major after the
 *      engines bump keeps testing a runtime the package no longer promises,
 *      and one that skips the floor major proves nothing about it.
 *   4. The `ci-ok` comment in the same file, which names an EXPANDED matrix
 *      job (`runtime-compat (<major>)`) as its worked example.
 *   5. The prose that tells users what to install: `README.md`,
 *      `CONTRIBUTING.md`, `docs/getting-started.md`.
 *
 * Each surface is read from the tree and compared against ONE literal below.
 * `FLOOR` is deliberately not derived from `package.json`: a fence that reads
 * its expectation from one of the files it checks agrees with that file by
 * construction and only ever catches the other four. Raising the floor is a
 * one-line edit here plus every surface above, in the same PR.
 *
 * `ci.yml` is read through a REAL YAML parser (`yaml`, a devDependency added
 * for this fence). The other suites in this directory read workflow TEXT
 * because their subjects are block scalars executed verbatim; this one's
 * subject is a list under a known key, which is exactly what a text scan gets
 * wrong on the next respelling (`['22.12', '24']` vs. a block sequence) and a parser
 * gets right.
 */

/** The floor, as a full semver. Node 22.12.0 is the first 22.x with unflagged `require(esm)`. */
const FLOOR = '22.12.0';
const FLOOR_MAJOR = Number(FLOOR.split('.')[0]);
/**
 * The `major.minor` spelling the docs and the matrix's floor row use — the
 * bare major when the floor is an `.0` minor ("Node.js 24", not "24.0").
 */
function shortOf(floor: string): string {
  const [major, minor] = floor.split('.');
  return minor === '0' ? major! : `${major}.${minor}`;
}
const FLOOR_SHORT = shortOf(FLOOR);
const FLOOR_SHORT_RE = FLOOR_SHORT.replace('.', String.raw`\.`);
/** The full semver, escaped, for the surfaces that state `>=22.12.0`. */
const FLOOR_RE = FLOOR.replace(/\./g, String.raw`\.`);

/**
 * Spellings that advertised an OLDER floor, generated for every major below
 * the current one back to the oldest this package ever shipped on, as bounded
 * regexes restricted to a FLOOR CLAIM ("or later", "+", ">=", "runtime") — so
 * an EOL note ("Node 20 is past end of life") and a measurement ("On Node 20
 * / 22 the runtime swallows it") stay legal, and a docs file that keeps BOTH
 * the old and the new floor goes red on the old one.
 */
const OLDEST_EVER_SHIPPED_MAJOR = 18;
/**
 * The retired-floor patterns for a set of majors. A function rather than a
 * constant so the self-probe below can run it against the CURRENT floor and
 * prove the next bump's fence would catch today's sentences — `major.minor`
 * spellings included (`Node.js 22.12 or later` must be retired by the bump
 * to 24 exactly as `Node.js 20 or later` was by this one).
 *
 * KNOWN BOUND: a matrix ENUMERATION ("smoke-runs on Node 20 / 22 / 24") is
 * not retired, because "On Node 20 / 22 the runtime swallows it" — a
 * measurement in tests/setup.ts — has the same shape; such a sentence is
 * caught only when a doc pins it positively (or by the bump's own grep).
 */
function oldFloorSpellings(majors: ReadonlyArray<number>): ReadonlyArray<RegExp> {
  return majors.flatMap((m) => {
    // `20`, `v20`, `20.19`, `20.x`, `20 LTS` — a floor is stated at any
    // precision and with the decorations a release note uses; `\s+` between
    // tokens because the docs hard-wrap mid-sentence.
    const v = String.raw`v?${m}(?:\.\d+)*(?:\.x)?(?:\s+LTS)?`;
    return [
      String.raw`Node(?:\.js)?\s+${v}\s+(?:or|and)\s+(?:later|higher|newer|up)`,
      String.raw`Node(?:\.js)?\s+${v}\+`,
      String.raw`Node\s+${v}\s+runtime`,
      String.raw`Node\s+${v}\s+\(the\s+(?:runtime|exact\s+floor)`,
      // A bare version in the "must report `v20.19.0` or higher" shape.
      String.raw`v${m}(?:\.\d+)*(?:\.x)?\x60?\s+or\s+(?:later|higher|newer|up)`,
      // A range, anchored to a Node / engines mention within the same clause
      // so `Docker >= 20.10` stays legal; `(?!\d)` keeps `>=20` from matching
      // a `>=2026` date or a `>=200` count.
      String.raw`(?:Node(?:\.js)?\**|engines)[\s\S]{0,40}>=\s?${v}(?!\d)`,
    ].map((src) => new RegExp(src));
  });
}
const OLD_FLOOR_SPELLINGS = oldFloorSpellings(
  Array.from(
    { length: FLOOR_MAJOR - OLDEST_EVER_SHIPPED_MAJOR },
    (_, i) => OLDEST_EVER_SHIPPED_MAJOR + i
  )
);

/**
 * Every prose file that states the floor to a reader, each with the exact
 * phrase it uses — pinned positively so the file cannot satisfy the fence
 * with a `22.12` that is a date or another product's version.
 */
const DOCS_STATING_THE_FLOOR: ReadonlyArray<readonly [file: string, statement: RegExp]> = [
  ['README.md', new RegExp(String.raw`\*\*Node\.js\s+${FLOOR_SHORT_RE}\s+or\s+later\*\*`)],
  ['CONTRIBUTING.md', new RegExp(String.raw`targets\s+\*\*Node\.js\s+${FLOOR_SHORT_RE}\s+or\s+later\*\*`)],
  // The CI paragraph names the floor row of the matrix a second time.
  ['CONTRIBUTING.md', new RegExp(String.raw`on\s+Node\s+${FLOOR_SHORT_RE}\s+\(the\s+exact\s+floor\)`)],
  ['docs/getting-started.md', new RegExp(String.raw`\*\*Node\.js\s+${FLOOR_SHORT_RE}\s+or\s+later\*\*`)],
  // The same line states the floor a second time, as the version `node
  // --version` must report; pinned separately so the self-probe sees it.
  ['docs/getting-started.md', new RegExp(String.raw`\x60v${FLOOR_RE}\x60\s+or\s+higher`)],
  ['.claude/CLAUDE.md', new RegExp(String.raw`engines\s+declares\s+\x60>=${FLOOR_RE}\x60`)],
];

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8');
}

describe('the published Node.js floor is one number across every surface', () => {
  it('names a real major, and the derived spellings are non-vacuous', () => {
    // Non-vacuity: `Number('')` is 0 and `Number('x')` is NaN, either of which
    // would make the matrix comparison below meaningless.
    expect(Number.isInteger(FLOOR_MAJOR)).toBe(true);
    expect(FLOOR_MAJOR).toBeGreaterThan(OLDEST_EVER_SHIPPED_MAJOR);
    expect(OLD_FLOOR_SPELLINGS.length).toBeGreaterThan(0);
    // Both arms of the `.0`-minor rule, on values the fence does not read.
    expect(shortOf('22.12.0')).toBe('22.12');
    expect(shortOf('24.0.0')).toBe('24');
    // The prose table is pinned by NAME: a loop over an emptied or shortened
    // table registers nothing and passes in silence.
    expect(DOCS_STATING_THE_FLOOR.map(([file]) => file)).toEqual([
      'README.md',
      'CONTRIBUTING.md',
      'CONTRIBUTING.md',
      'docs/getting-started.md',
      'docs/getting-started.md',
      '.claude/CLAUDE.md',
    ]);
  });

  it('the retired-spelling generator fires on floor claims and not on notes about a version', () => {
    const patterns = oldFloorSpellings([20]);
    const fires = (text: string): boolean => patterns.some((p) => p.test(text));
    for (const claim of [
      'Node.js 20 or later',
      'Node 20+',
      'Node.js 20.19 and later',
      'Node.js 20.x or later',
      'Node.js v20 or later',
      'Node 20 LTS or later',
      'Node.js 20 or newer',
      'Node 20 or up',
      'Node.js 20+',
      'runs on v20.x or later',
      'must report `v20.19.0` or higher',
      'with a Node 20 runtime target',
      'on Node 20.19 (the exact floor) and 24',
      'engines >= 20.0.0',
      'engines\n  declares `>=20`',
    ]) {
      expect(fires(claim), `"${claim}" is a floor claim and must fire`).toBe(true);
    }
    for (const note of [
      'Node.js 20 is past end of life',
      'Node 20 or earlier is past end of life and no longer supported',
      'On Node 20 / 22 the runtime swallows it silently',
      'measured >= 2026-09-14',
      'across >= 200 fixtures',
      'the nodejs20.x Lambda runtime',
      'Docker >= 20.10 for --add-host',
    ]) {
      expect(fires(note), `"${note}" claims no floor and must not fire`).toBe(false);
    }
  });

  describe('the retired-spelling generator would catch every CURRENT floor sentence at the next bump', () => {
    // Run the generator as the NEXT bump will, with today's floor as the old
    // one, against the sentences the docs carry today: each must be retired,
    // or the fence's "keeps both floors goes red" promise is only true for a
    // floor whose minor happens to be 0.
    for (const [doc, statement] of DOCS_STATING_THE_FLOOR) {
      it(`${doc}: ${statement}`, () => {
        const sentence = read(doc).match(statement)?.[0] ?? '';
        expect(sentence, `${doc} has no floor sentence to probe`).not.toBe('');
        expect(
          oldFloorSpellings([FLOOR_MAJOR]).some((p) => p.test(sentence)),
          `${doc}: "${sentence}" would survive the next bump`
        ).toBe(true);
      });
    }
  });

  it('package.json engines.node declares exactly >=FLOOR', () => {
    const pkg = JSON.parse(read('package.json')) as { engines?: { node?: string } };
    expect(pkg.engines?.node, 'package.json has no engines.node').toBeDefined();
    expect(pkg.engines?.node, 'package.json engines.node is not the floor').toBe(`>=${FLOOR}`);
  });

  it('vite.config.ts pack target is the floor major, declared exactly once', () => {
    const matches = [...read('vite.config.ts').matchAll(/target:\s*'node(\d+)'/g)];
    // Fail CLOSED on both sides: zero matches means the pack target moved to
    // a spelling this fence cannot see; two means a second target now decides
    // what some artifact needs, and this fence reads only the first.
    expect(
      matches.length,
      `expected exactly one \`target: 'node<N>'\` in vite.config.ts, found ${matches.length}`
    ).toBe(1);
    expect(Number(matches[0]![1])).toBe(FLOOR_MAJOR);
  });

  describe('.github/workflows/ci.yml', () => {
    const ci = () =>
      parseYaml(read('.github/workflows/ci.yml')) as {
        jobs?: Record<string, { strategy?: { matrix?: { 'node-version'?: unknown } } }>;
      };

    it('runtime-compat smoke-tests the EXACT floor first and nothing older', () => {
      const versions = ci().jobs?.['runtime-compat']?.strategy?.matrix?.['node-version'];
      expect(Array.isArray(versions), 'runtime-compat has no node-version matrix').toBe(true);
      const rows = versions as unknown[];
      // Rows are quoted strings so YAML cannot reshape them (an unquoted 22.10
      // parses as the float 22.1); refuse anything else rather than coerce it.
      for (const row of rows) {
        expect(typeof row, `non-string matrix row ${String(row)}`).toBe('string');
        expect(row as string).toMatch(/^\d+(\.\d+)?$/);
      }
      // The FIRST row is the floor itself, major.minor, so the smoke executes
      // the bundle on the promised minimum — a bare major resolves to the
      // newest 22.x and proves nothing about 22.12.
      expect(rows[0]).toBe(FLOOR_SHORT);
      const majors = rows.map((v) => Number((v as string).split('.')[0]));
      // The minimum IS the floor CI proves — not "contains the floor": a
      // matrix of [20, 22, 24] contains 22 and still tests a runtime the
      // package no longer promises.
      expect(Math.min(...majors)).toBe(FLOOR_MAJOR);
      expect(majors.every((m) => m >= FLOOR_MAJOR)).toBe(true);
      // The dev / CI pin (`.node-version`) is the runtime the suite itself
      // runs on; the built CLI must be smoked there too, or the matrix can
      // quietly drop the version every contributor actually uses.
      const devPinMajor = Number(read('.node-version').trim().split('.')[0]);
      expect(majors).toContain(devPinMajor);
    });

    it("ci-ok's worked example names an expanded job that exists", () => {
      const text = read('.github/workflows/ci.yml');
      expect(text).toContain(`runtime-compat (${FLOOR_SHORT})`);
      // Any OTHER expanded name in the file is an example from a row that no
      // longer exists (the bare `(22)` and the retired `(20)` included).
      expect(text).not.toMatch(
        new RegExp(String.raw`runtime-compat \((?!${FLOOR_SHORT_RE}\))[\d.]+\)`)
      );
    });
  });

  describe('user-facing prose states the floor and nothing older', () => {
    for (const [doc, statement] of DOCS_STATING_THE_FLOOR) {
      it(`${doc} carries ${statement} and no older floor claim`, () => {
        const text = read(doc);
        expect(text, `${doc} no longer carries its floor statement ${statement}`).toMatch(
          statement
        );
        for (const old of OLD_FLOOR_SPELLINGS) {
          expect(text, `${doc} still says ${old}`).not.toMatch(old);
        }
      });
    }
  });
});
