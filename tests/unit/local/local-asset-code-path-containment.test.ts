/**
 * `Metadata['aws:asset:path']` becomes a read-only BIND MOUNT at `/var/task`
 * (or `/opt` for a layer) in a container running handler code the same
 * assembly supplied (go-to-k/cdkd#3534, applying the decision recorded in
 * go-to-k/cdkd#3494).
 *
 * Both resolvers — `cdkl invoke`'s in `src/local/lambda-resolver.ts` and
 * `cdkl start-api`'s in `src/cli/commands/local-start-api.ts` — spelled the
 * resolution as `isAbsolute(p) ? p : resolve(cdkOutDir, p)`, so `..` folded
 * exactly as `join` does and left the assembly silently.
 *
 * THE TWO SHAPES ARE ANSWERED DIFFERENTLY, and the asymmetry is the whole
 * decision, so each site asserts BOTH arms:
 *
 * - a RELATIVE escape (`../throwaway-victim`) is REFUSED — no real synth emits
 *   one;
 * - an ABSOLUTE value is ACCEPTED, with a WARNING naming the path when it
 *   leaves the asset outdir and SILENCE when it does not. `cdk synth
 *   --no-staging` emits exactly that shape (the asset's absolute source
 *   directory), so refusing it would reject the output of a documented CDK CLI
 *   flag.
 *
 * The relative case asserts `warn` was NOT called, and the absolute one
 * asserts it WAS: a regression that collapsed the two arms into one behaviour
 * would otherwise leave a suite that still passes.
 *
 * THE WIRING PAIR is the part a guard-only suite misses. Every top-level shape
 * has `manifestDir === assetOutdir`, so the whole suite stays green with the
 * bound argument dropped at a call site. Each site therefore also gets a Stage
 * manifest, where the two differ:
 *
 * - `../asset.<hash>` ACCEPTED — reds if the bound collapses to the manifest
 *   directory (fails closed, refusing every legitimate Stage asset);
 * - `../../victim` REFUSED from that same manifest — reds if the bound is
 *   widened past the app outdir (fails open).
 */
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assetPathDirs, resolveLambdaTarget } from '../../../src/local/lambda-resolver.js';
import { resolveLambdaByLogicalId } from '../../../src/cli/commands/local-start-api.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { TemplateResource } from '../../../src/types/resource.js';
import { getLogger } from '../../../src/utils/logger.js';

const roots: string[] = [];

function tmp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cdkl-local-asset-')));
  roots.push(dir);
  return dir;
}

interface Assembly {
  /** The app's outdir — the containment bound. */
  outdir: string;
  /** The directory the manifest lives in; differs from `outdir` for a Stage. */
  manifestDir: string;
  /** A throwaway directory OUTSIDE the outdir. Never a real sensitive path. */
  outer: string;
  stack: StackInfo;
}

/**
 * An assembly whose one Lambda carries `assetPath`. `stage` puts the manifest
 * in `cdk.out/assembly-MyStage/` while its asset stays staged in `cdk.out`,
 * which is what `cdk synth` does for a `cdk.Stage`.
 */
function assembly(
  assetPath: string,
  opts: { stage?: boolean; omitBound?: boolean; layer?: boolean } = {}
): Assembly {
  const outer = tmp();
  const outdir = join(outer, 'cdk.out');
  const manifestDir = opts.stage ? join(outdir, 'assembly-MyStage') : outdir;
  mkdirSync(manifestDir, { recursive: true });
  // A THROWAWAY victim, created so the `existsSync` check in the invoke
  // resolver cannot mask the containment verdict with a "does not exist".
  mkdirSync(join(outer, 'throwaway-victim'));
  mkdirSync(join(outdir, 'asset.abc123'));
  mkdirSync(join(outdir, 'nested'), { recursive: true });
  writeFileSync(join(manifestDir, 'Stk.assets.json'), JSON.stringify({ version: '54.0.0' }));

  const fn: TemplateResource = {
    Type: 'AWS::Lambda::Function',
    Properties: {
      Runtime: 'nodejs20.x',
      Handler: 'index.handler',
      ...(opts.layer ? { Layers: [{ Ref: 'Lyr' }] } : {}),
    },
    // In the LAYER cases the subject under test is the layer's own metadata,
    // so the function's must be a benign path that still resolves from
    // wherever this assembly's manifest sits.
    Metadata: {
      'aws:asset:path': opts.layer
        ? opts.stage
          ? '../asset.abc123'
          : 'asset.abc123'
        : assetPath,
    },
  };
  const resources: Record<string, TemplateResource> = { Fn: fn };
  if (opts.layer) {
    resources['Lyr'] = {
      Type: 'AWS::Lambda::LayerVersion',
      Properties: {},
      Metadata: { 'aws:asset:path': assetPath },
    };
  }

  const stack: StackInfo = {
    stackName: 'Stk',
    displayName: 'Stk',
    artifactId: 'Stk',
    assetManifestPath: join(manifestDir, 'Stk.assets.json'),
    // `omitBound` reproduces a hand-built StackInfo carrying no `assetOutdir`,
    // which must fall back to the manifest directory — never wider.
    ...(opts.omitBound ? {} : { assetOutdir: outdir }),
    dependencyNames: [],
    template: { Resources: resources },
  };

  return { outdir, manifestDir, outer, stack };
}

/** Point the function's (or layer's) `aws:asset:path` at `value`. */
function setAssetPath(a: Assembly, logicalId: string, value: string): void {
  (a.stack.template.Resources![logicalId]!.Metadata as Record<string, string>)[
    'aws:asset:path'
  ] = value;
}

// Restore spies from a hook, NOT as the last statement of each case: a
// trailing `warn.mockRestore()` never runs when an assertion above it throws,
// so ONE failing case would leak a silencing `warn` stub into every case after
// it in the file — including the "stays SILENT" ones, which would then pass
// for the wrong reason. `tests/setup.ts` installs no global restore.
afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function warnSpy(): { said: () => string } {
  const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
  return { said: () => warn.mock.calls.map((c) => String(c[0])).join('\n') };
}

/** The two sites, called through each one's own public entry point. */
const SITES = [
  {
    name: 'cdkl invoke (lambda-resolver)',
    call: (a: Assembly): string =>
      (resolveLambdaTarget('Stk:Fn', [a.stack]) as { codePath: string }).codePath,
  },
  {
    name: 'cdkl start-api',
    call: (a: Assembly): string =>
      (resolveLambdaByLogicalId('Fn', [a.stack]) as { codePath: string }).codePath,
  },
] as const;

for (const site of SITES) {
  describe(`aws:asset:path containment — ${site.name}`, () => {
    it('ACCEPTS an absolute value that escapes, and WARNS naming the path', () => {
      // THE `cdk synth --no-staging` SHAPE. Under
      // `aws:cdk:disable-asset-staging` upstream writes the asset's absolute
      // SOURCE directory, normally outside the outdir. Refusing it would
      // reject the output of a documented CDK CLI flag, so it is accepted and
      // the escape is a warning instead.
      const a = assembly('/placeholder');
      const victim = join(a.outer, 'throwaway-victim');
      setAssetPath(a, 'Fn', victim);
      const warn = warnSpy();

      expect(site.call(a)).toBe(victim);

      // The needle the five SILENT cases below assert the ABSENCE of. Assert
      // it in the positive case too, or a reworded warning makes all five
      // vacuous at once.
      expect(warn.said()).toMatch(/aws:asset:path/);
      expect(warn.said()).toMatch(/absolute/);
      // Naming the path is the whole point of the warning: an absolute path
      // the user did not expect has to be VISIBLE, not silent.
      expect(warn.said()).toContain(victim);
      expect(warn.said()).toMatch(/bind-mount/);
      expect(warn.said()).toMatch(/--no-staging/);
      expect(warn.said()).toMatch(/treat this assembly as untrusted/);
    });

    it('ACCEPTS an absolute value INSIDE the outdir, and stays SILENT', () => {
      // Nothing escaped, so there is nothing to warn about — a warning here
      // would train the reader to ignore the one that matters.
      const a = assembly('/placeholder');
      const inside = join(a.outdir, 'asset.abc123');
      setAssetPath(a, 'Fn', inside);
      const warn = warnSpy();

      expect(site.call(a)).toBe(inside);
      expect(warn.said()).not.toMatch(/aws:asset:path/);
    });

    it('WARNS for an absolute path INSIDE the outdir that leads out via a SYMLINK', () => {
      // The ONLY shape where an absolute path inside the bound is not silent,
      // and the only thing the warning's symbolic-link clause renders. Without
      // this case, deleting the real-path block in
      // `absoluteAssemblyPathEscape`, flipping its `!isInside`, or dropping
      // the ternary in the warning all stay green. It is also the shape a
      // hostile assembly would reach for once a lexical escape is refused and
      // a plain absolute one is loud.
      const a = assembly('/placeholder');
      const link = join(a.outdir, 'asset.link');
      symlinkSync(join(a.outer, 'throwaway-victim'), link, 'dir');
      setAssetPath(a, 'Fn', link);
      const warn = warnSpy();

      expect(site.call(a)).toBe(link);

      expect(warn.said()).toMatch(/through a symbolic link to/);
      expect(warn.said()).toContain(join(a.outer, 'throwaway-victim'));
    });

    it('ACCEPTS a value naming the asset outdir ITSELF, by either spelling', () => {
      // The two arms must agree that the bound is not an escape. The RELATIVE
      // spelling reaches `resolveAssemblyPath`, whose `isInside` is false for
      // an empty `path.relative` — right for a caller that reads a FILE, wrong
      // here, where the value is a directory to mount.
      const rel = assembly('.');
      expect(site.call(rel)).toBe(rel.outdir);

      const abs = assembly('/placeholder');
      setAssetPath(abs, 'Fn', abs.outdir);
      const warn = warnSpy();
      expect(site.call(abs)).toBe(abs.outdir);
      // ...and the absolute spelling must not warn about it either, which is
      // the `target !== resolvedBound` clause in `absoluteAssemblyPathEscape`.
      expect(warn.said()).not.toMatch(/aws:asset:path/);
    });

    it('ACCEPTS the outdir reached through a symlink to itself, without warning', () => {
      // The second otherwise-unfenced clause: `realTarget !== realBound`. The
      // link must live INSIDE the outdir, or the LEXICAL arm fires first and
      // returns before the real-path arm can exonerate it. Placed inside, the
      // value is lexically contained and resolves through the link to exactly
      // the bound, which is the only way to reach the clause under test.
      const a = assembly('/placeholder');
      const selfLink = join(a.outdir, 'self-link');
      symlinkSync(a.outdir, selfLink, 'dir');
      setAssetPath(a, 'Fn', selfLink);
      const warn = warnSpy();

      expect(site.call(a)).toBe(selfLink);
      expect(warn.said()).not.toMatch(/aws:asset:path/);
    });

    it('REFUSES an escaping relative value, and does NOT warn', () => {
      const a = assembly('../throwaway-victim');

      expect(() => site.call(a)).toThrow(/outside '/);
      expect(() => site.call(a)).toThrow(/hand-modified or generated by a non-CDK toolchain/);
      // A RELATIVE escape is still REFUSED, and that asymmetry is the
      // decision: an absolute path has a legitimate producer
      // (`cdk synth --no-staging`), `../../victim` has none. So this must
      // THROW, not warn — a regression that relaxed it into a warning
      // alongside the absolute arm would otherwise look like success.
      const warn = warnSpy();
      expect(() => site.call(a)).toThrow();
      expect(warn.said()).toBe('');
    });

    it('REFUSES one that stays inside lexically but leads out through a symlink', () => {
      const a = assembly('link/throwaway-victim');
      symlinkSync(a.outer, join(a.manifestDir, 'link'), 'dir');

      expect(() => site.call(a)).toThrow(/leads through a symbolic link to/);
    });

    it('still ACCEPTS an ordinary sibling asset directory', () => {
      const a = assembly('asset.abc123');

      expect(site.call(a)).toBe(join(a.outdir, 'asset.abc123'));
    });

    it('still ACCEPTS one that normalises back inside', () => {
      const a = assembly('nested/../asset.abc123');

      expect(site.call(a)).toBe(join(a.outdir, 'asset.abc123'));
    });

    it('REFUSES a bare `..`, which names the parent of the outdir', () => {
      // `isInside`'s `rel === '..'` arm, which no `../<name>` case reaches.
      // Drop it and this mounts the directory cdk.out sits in.
      const a = assembly('..');

      expect(() => site.call(a)).toThrow(/outside '/);
    });

    it('REFUSES a relative value resolving through a link to the outdir ITSELF', () => {
      // The two arms DISAGREE here, deliberately rather than by accident, and
      // the disagreement is fenced so it stays a decision. The ABSOLUTE arm
      // accepts a link pointing at the bound for the same reason the
      // re-spelling exoneration exists: NOTHING LEAVES THE BOUND, so a warning
      // would be a false alarm, and the arm's whole worth is that an alarm
      // means something. The RELATIVE arm refuses it because refusing costs
      // nothing there: no synth emits a link back to the outdir under an asset
      // path, and the refusal already reads correctly
      // ("a symbolic link to the directory ... itself") rather than as a
      // generic escape.
      const a = assembly('self-link');
      symlinkSync(a.outdir, join(a.manifestDir, 'self-link'), 'dir');

      expect(() => site.call(a)).toThrow(/a symbolic link to the directory/);
    });

    it('stays SILENT for an absolute value inside the outdir by ANOTHER SPELLING', () => {
      // The real-path exoneration in `absoluteAssemblyPathEscape`. Two
      // spellings of one directory are routine (macOS resolves `/tmp` to
      // `/private/tmp`), and a lexical-only verdict tells the user to treat
      // their own assembly as untrusted because of one. Drop the exoneration
      // and this reds.
      const a = assembly('/placeholder');
      const realOut = join(a.outer, 'real-out');
      mkdirSync(join(realOut, 'asset.xyz'), { recursive: true });
      // The BOUND becomes the link; the value is the same place spelled real.
      const linked = join(a.outer, 'linked-out');
      symlinkSync(realOut, linked, 'dir');
      (a.stack as { assetOutdir?: string }).assetOutdir = linked;
      (a.stack as { assetManifestPath?: string }).assetManifestPath = join(
        linked,
        'Stk.assets.json'
      );
      writeFileSync(join(realOut, 'Stk.assets.json'), '{}');
      setAssetPath(a, 'Fn', join(realOut, 'asset.xyz'));
      const warn = warnSpy();

      expect(site.call(a)).toBe(join(realOut, 'asset.xyz'));
      expect(warn.said()).not.toMatch(/aws:asset:path/);
    });

    it('FLATTENS control characters out of the refusal', () => {
      // The path is assembly-chosen and lands on a log line; `path.resolve`
      // preserves `\x1b[2K\r` and `\n`, which erase the line and forge
      // benign ones in its place.
      const a = assembly('../evil\u001b[2K\rINFO  asset verified\nINFO  done');

      expect(() => site.call(a)).toThrow(/outside '/);
      let message = '';
      try {
        site.call(a);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).not.toMatch(/[\n\r\u001b]/);
    });

    it('CAPS the refusal too, not only the warning', () => {
      // The cap inside `renderAssemblyPathEscape` is on the REFUSAL arm, which
      // had no length assertion while the warn arm did — measured, dropping it
      // gave a 200 363-character message. Leaving one arm of the same failure
      // fenced and the other not is the odd state, so both are pinned.
      const a = assembly(`../${'x'.repeat(200000)}`);

      let message = '';
      try {
        site.call(a);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message.length).toBeLessThan(4000);
      expect(message).toMatch(/truncated/);
    });

    // ---- the WIRING pair -------------------------------------------------
    // Both cases live BELOW a Stage manifest, the only shape in which the
    // bound and the resolution base differ. A top-level case cannot see the
    // bound at all.

    it("WIRING: ACCEPTS a Stage's `../asset.<hash>`, bounded by the app outdir", () => {
      const a = assembly('../asset.abc123', { stage: true });

      // Reds if the call site stops passing `stack.assetOutdir`: the bound
      // collapses to `cdk.out/assembly-MyStage/` and every Stage asset is
      // refused as hand-modified.
      expect(site.call(a)).toBe(join(a.outdir, 'asset.abc123'));
    });

    it('WIRING: REFUSES `../../throwaway-victim` from that same Stage manifest', () => {
      const a = assembly('../../throwaway-victim', { stage: true });

      // Reds if the bound is widened past the app outdir — the failure mode a
      // refusal-only suite reads as success.
      expect(() => site.call(a)).toThrow(/outside '/);
    });

    it('WIRING: an absolute path in the app outdir is SILENT below a Stage manifest', () => {
      // The ABSOLUTE arm has its own bound, and a top-level shape cannot see
      // it — `manifestDir === assetOutdir` there, so a probe swapping one for
      // the other stays green. Below a Stage they differ, and this asset sits
      // in the app outdir, OUTSIDE the Stage's manifest directory. Bound
      // correctly there is no warning; bound to `manifestDir`, cdk-local cries
      // wolf on every Stage asset that `--no-staging` made absolute.
      const a = assembly('/placeholder', { stage: true });
      const inside = join(a.outdir, 'asset.abc123');
      setAssetPath(a, 'Fn', inside);
      const warn = warnSpy();

      expect(site.call(a)).toBe(inside);
      expect(warn.said()).not.toMatch(/aws:asset:path/);
    });

    it('WIRING: with no assetManifestPath, the BASE falls back to the outdir, not the cwd', () => {
      // `AssemblyReader` always sets `assetOutdir` but may leave
      // `assetManifestPath` undefined. Taking `process.cwd()` as the base then
      // makes base and bound DISJOINT — nothing under the cwd is inside
      // `cdk.out` — so every asset path is refused with a message blaming the
      // assembly. Fail-closed, never a hole, but a wrong diagnosis.
      const a = assembly('asset.abc123');
      delete (a.stack as { assetManifestPath?: string }).assetManifestPath;

      expect(site.call(a)).toBe(join(a.outdir, 'asset.abc123'));
    });

    it('WIRING: a PRESENT bound is never replaced by the assembly-derived base', () => {
      // THE TRUST BOUNDARY. `assetOutdir` comes from the user's `--app` /
      // `--output`; `manifestDir` is derived from the assembly's own
      // `manifest.json` (cx-api resolves `AssetManifestArtifact.file` out of
      // it), so the BASE is attacker-controlled and the BOUND is not. An
      // earlier revision dropped a present bound whenever it was not an
      // ancestor of the base, to improve the diagnosis for a host that
      // supplied a nonsense one — and a planted `file` pointing out of the
      // assembly then carried the bound with it, so a plain relative value
      // resolved CONTAINED with no refusal and no warning.
      const a = assembly('asset.abc123');
      // A planted manifest path two levels above the outdir.
      (a.stack as { assetManifestPath?: string }).assetManifestPath = join(
        a.outer,
        '..',
        'Stk.assets.json'
      );
      setAssetPath(a, 'Fn', 'throwaway-victim');

      expect(() => site.call(a)).toThrow(/outside '/);
    });

    it('WIRING: a host bound that is DISJOINT from the base refuses, rather than widening', () => {
      // Fail-closed with a wrong diagnosis is the accepted cost; the
      // alternative reopened the hole above.
      const a = assembly('asset.abc123');
      (a.stack as { assetOutdir?: string }).assetOutdir = 'cdk.out';

      expect(() => site.call(a)).toThrow(/outside '/);
    });

    it('WIRING: an EMPTY assetOutdir is treated as ABSENT, not as the cwd', () => {
      const a = assembly('asset.abc123');
      (a.stack as { assetOutdir?: string }).assetOutdir = '';

      expect(site.call(a)).toBe(join(a.outdir, 'asset.abc123'));
    });

    it('CAPS an unbounded path instead of letting it flood the line', () => {
      // The warn fires BEFORE any existence check, so the path never has to
      // exist: an unbounded one scrolls the leading clause off screen and
      // blows a bounded log line.
      const a = assembly('/placeholder');
      setAssetPath(a, 'Fn', join(a.outer, 'x'.repeat(200000)));
      // The LOGICAL ID is assembly-chosen too, and is interpolated first.
      a.stack.template.Resources!['L'.repeat(200000)] =
        a.stack.template.Resources!['Fn']!;
      delete a.stack.template.Resources!['Fn'];
      const warn = warnSpy();

      // `invoke` throws on the existence check AFTER warning, which is itself
      // the point: the warning fires first, so the path need not exist.
      try {
        (site.name.includes('start-api')
          ? resolveLambdaByLogicalId('L'.repeat(200000), [a.stack])
          : resolveLambdaTarget(`Stk:${'L'.repeat(200000)}`, [a.stack])) as unknown;
      } catch {
        /* the existence check, not the subject here */
      }

      expect(warn.said().length).toBeLessThan(4000);
      expect(warn.said()).toMatch(/truncated/);
    });

    it('names the Stage SUB-ASSEMBLY layout in the refusal instead of blaming the user', () => {
      // `--app cdk.out/assembly-MyStage` makes that directory the assembly
      // root, so the Stage's assets — staged into the APP's outdir by
      // `cdk synth` — are one level above it and CDK's own `../asset.<hash>`
      // escapes. The generic provenance sentence would accuse a hand-modified
      // assembly of a layout CDK produced, and the user would hunt a tamper
      // that did not happen (go-to-k/cdk-local#746).
      const a = assembly('../asset.abc123', { stage: true });
      // Read AS a sub-assembly: the Stage directory is the root.
      (a.stack as { assetOutdir?: string }).assetOutdir = a.manifestDir;

      expect(() => site.call(a)).toThrow(/cdk\.Stage sub-assembly/);
      expect(() => site.call(a)).toThrow(/is not a tamper/);
    });

    it('does NOT offer the Stage hint for a NON-climbing escape below a Stage bound', () => {
      // The hint's `..` test, not just its directory-name test. Below a
      // sub-assembly bound a value that escapes through a SYMLINK rather than
      // through `..` has nothing to do with the staged-asset layout, so the
      // reassuring clause would be noise on it.
      const a = assembly('link/throwaway-victim', { stage: true });
      (a.stack as { assetOutdir?: string }).assetOutdir = a.manifestDir;
      symlinkSync(a.outer, join(a.manifestDir, 'link'), 'dir');

      let message = '';
      try {
        site.call(a);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toMatch(/symbolic link/);
      expect(message).not.toMatch(/sub-assembly/);
    });

    it('does NOT offer the Stage hint for an ordinary escape', () => {
      // The hint must not become noise on every refusal: a top-level assembly
      // escaping with `../throwaway-victim` has nothing to do with a Stage.
      const a = assembly('../throwaway-victim');

      expect(() => site.call(a)).toThrow(/outside '/);
      let message = '';
      try {
        site.call(a);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).not.toMatch(/sub-assembly/);
    });

    it('WIRING: a StackInfo with no assetOutdir falls back to the manifest directory', () => {
      // Never WIDER than the base. Under a Stage manifest that costs the
      // legitimate `../asset.<hash>`, which is the deliberate trade: a missing
      // bound narrows, it does not open.
      const a = assembly('../asset.abc123', { stage: true, omitBound: true });

      expect(() => site.call(a)).toThrow(/outside '/);
    });
  });
}

describe('aws:asset:path — the messages AFTER the containment verdict', () => {
  // The containment verdict is not the only place the value is rendered. A
  // CONTAINED relative path still reaches `cdkl invoke`'s existence check,
  // which prints it — and that branch is MORE reachable than the warning,
  // since any relative value with no `..` gets there. Measured before the fix:
  // it carried ESC/CR/LF verbatim and had no length bound, so the same
  // forgery and the same flood worked on it.
  it('FLATTENS and CAPS the "does not exist" message', () => {
    const a = assembly('placeholder');
    setAssetPath(a, 'Fn', `absent\u001b[2K\rINFO  asset verified\nINFO  done${'x'.repeat(200000)}`);

    let message = '';
    try {
      resolveLambdaTarget('Stk:Fn', [a.stack]);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/does not exist/);
    expect(message).not.toMatch(/[\n\r\u001b]/);
    expect(message.length).toBeLessThan(4000);
  });

  it('FLATTENS and CAPS the "is not a directory" message', () => {
    const a = assembly('placeholder');
    const name = `file\u001b[2K\rINFO  verified${'x'.repeat(200000)}`;
    // A FILE, so the directory check is what refuses it.
    writeFileSync(join(a.outdir, name.slice(0, 200)), '');
    setAssetPath(a, 'Fn', name.slice(0, 200));

    let message = '';
    try {
      resolveLambdaTarget('Stk:Fn', [a.stack]);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/is not a directory/);
    expect(message).not.toMatch(/[\n\r\u001b]/);
  });
});

describe('aws:asset:path containment — cdkl invoke layer assets', () => {
  // `resolveLambdaLayers` resolves a same-stack `AWS::Lambda::LayerVersion`
  // through the SAME helper, and its result bind-mounts at `/opt`.
  const layerPath = (a: Assembly): string =>
    (resolveLambdaTarget('Stk:Fn', [a.stack]) as { layers: { assetPath: string }[] }).layers[0]!
      .assetPath;

  it('ACCEPTS an absolute layer asset path, and WARNS naming it', () => {
    // A layer's directory mounts at `/opt`, so it takes the same decision as
    // the function's own — including the `--no-staging` shape, which CDK emits
    // for a `LayerVersion` asset exactly as it does for a function's.
    const a = assembly('/placeholder', { layer: true });
    const victim = join(a.outer, 'throwaway-victim');
    setAssetPath(a, 'Lyr', victim);
    const warn = warnSpy();

    expect(layerPath(a)).toBe(victim);
    expect(warn.said()).toContain(victim);
  });

  it('REFUSES an escaping layer asset path', () => {
    const a = assembly('../throwaway-victim', { layer: true });

    expect(() => layerPath(a)).toThrow(/outside '/);
  });

  it("ACCEPTS a Stage's `../asset.<hash>` layer, bounded by the app outdir", () => {
    const a = assembly('../asset.abc123', { layer: true, stage: true });

    expect(layerPath(a)).toBe(join(a.outdir, 'asset.abc123'));
  });
});

describe('assetPathDirs — the bound the two sites are given', () => {
  // Asserted DIRECTLY rather than through a resolver, because the interesting
  // failure is cwd-dependent: `path.resolve('')` is the cwd, so dropping the
  // empty-string guard only shows up when the cwd is an ANCESTOR of the base —
  // which is the ordinary case (`cdkl` run from the project root with `cdk.out`
  // below it) and never the case for a /tmp fixture. Through a resolver the
  // mutant passes for the wrong reason.
  it('treats an EMPTY assetOutdir as absent, whatever the cwd is', () => {
    const outer = tmp();
    const outdir = join(outer, 'cdk.out');

    expect(
      assetPathDirs({
        assetManifestPath: join(outdir, 'Stk.assets.json'),
        assetOutdir: '',
      } as unknown as StackInfo)
    ).toEqual({ manifestDir: outdir, assetOutdir: outdir });
  });

  it('uses a PRESENT bound as given, even when it is disjoint from the base', () => {
    const outer = tmp();
    const outdir = join(outer, 'cdk.out');

    // Fail-closed: every path under the base is then outside the bound. The
    // alternative — dropping the bound — lets an assembly-controlled manifest
    // path widen it.
    expect(
      assetPathDirs({
        assetManifestPath: join(outdir, 'Stk.assets.json'),
        assetOutdir: 'cdk.out',
      } as unknown as StackInfo).assetOutdir
    ).toBe('cdk.out');
  });
});
