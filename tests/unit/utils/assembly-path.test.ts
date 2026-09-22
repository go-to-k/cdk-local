/**
 * Direct tests for the containment primitives.
 *
 * The resolver-level suite
 * (`tests/unit/local/local-asset-code-path-containment.test.ts`) enters through
 * `cdkl invoke` / `cdkl start-api`, and every path those build fully
 * `realpath`s — so the whole not-yet-existing branch of
 * `resolveThroughLinks` (the climb, the `readlink` arm, both budgets) and two
 * of `renderAssemblyPathEscape`'s three messages are unreachable from there.
 * Measured: deleting the climb outright left that suite green.
 *
 * These cases exist to make those branches deletable-with-a-red. Each one says
 * what goes wrong if the branch it covers is removed.
 */
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  absoluteAssemblyPathEscape,
  renderAssemblyPathEscape,
  resolveAssemblyPath,
} from '../../../src/utils/assembly-path.js';

const roots: string[] = [];

function tmp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cdkl-assembly-path-')));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('resolveAssemblyPath — lexical containment', () => {
  it('REFUSES a bare `..`, which names the parent of the directory', () => {
    // `isInside`'s `rel === '..'` arm. Every case in the resolver suite uses
    // `../<name>`, whose `rel` is `../<name>`; nothing there produces `rel`
    // exactly `'..'`. Drop the arm and this value resolves to the PARENT of
    // cdk.out and is reported CONTAINED — a directory that would then be
    // bind-mounted.
    const dir = tmp();

    const out = resolveAssemblyPath(dir, '..');

    expect(out.contained).toBe(false);
  });

  it('REFUSES a value naming the directory itself', () => {
    const dir = tmp();

    const out = resolveAssemblyPath(dir, '.');

    expect(out).toEqual({ contained: false, escape: 'lexical', path: dir });
  });

  it('does NOT refuse a sibling whose name merely starts with `..`', () => {
    // The separator-aware test. A bare `startsWith('..')` would reject this.
    const dir = tmp();
    mkdirSync(join(dir, '..hidden'));

    expect(resolveAssemblyPath(dir, '..hidden')).toEqual({
      contained: true,
      path: join(dir, '..hidden'),
    });
  });

  it('ACCEPTS a path under a component that does not exist yet', () => {
    // The CLIMB. `realpathSync` answers ENOENT for the whole path, so without
    // the climb both operands are unresolvable, the symlink arm goes silent,
    // and the verdict rests on the lexical arm alone.
    const dir = tmp();

    expect(resolveAssemblyPath(dir, 'absent/child')).toEqual({
      contained: true,
      path: join(dir, 'absent', 'child'),
    });
  });

  it('widens the bound with containWithin without weakening the rule', () => {
    const outer = tmp();
    const outdir = join(outer, 'cdk.out');
    const stage = join(outdir, 'assembly-MyStage');
    mkdirSync(stage, { recursive: true });
    mkdirSync(join(outdir, 'asset.abc123'));

    expect(resolveAssemblyPath(stage, '../asset.abc123', { containWithin: outdir })).toEqual({
      contained: true,
      path: join(outdir, 'asset.abc123'),
    });
    expect(resolveAssemblyPath(stage, '../../victim', { containWithin: outdir }).contained).toBe(
      false
    );
  });
});

describe('resolveAssemblyPath — the symlink arm', () => {
  it('REFUSES a DANGLING link that would land outside', () => {
    // A dangling link is indistinguishable from an absent file to
    // `realpathSync`, and that difference is the point: the caller resolves
    // the path and uses it, and the link decides where that lands.
    const outer = tmp();
    const dir = join(outer, 'cdk.out');
    mkdirSync(dir);
    symlinkSync(join(outer, 'absent-victim'), join(dir, 'dangling'), 'dir');

    const out = resolveAssemblyPath(dir, 'dangling');

    expect(out.contained).toBe(false);
    expect(out.contained === false && out.escape).toBe('symlink');
    expect(out.contained === false && out.escape === 'symlink' && out.realPath).toBe(
      join(outer, 'absent-victim')
    );
  });

  it("folds a dangling target's leading `..` against the link's REAL directory", () => {
    // The `resolve(realParent, link)` in `resolveThroughLinks`. Fold against
    // the LEXICAL parent instead — the exact mistake its comment warns about —
    // and this escape reads as CONTAINED. Measured: it does.
    //
    //   cdk.out/aliasdir       -> <outside>/d2          (live directory link)
    //   <outside>/d2/leaf      -> ../secret             (relative, DANGLING)
    //
    // Correct answer: <outside>/secret, outside cdk.out.
    const outer = tmp();
    const dir = join(outer, 'cdk.out');
    const d2 = join(outer, 'd2');
    mkdirSync(dir);
    mkdirSync(d2);
    symlinkSync(d2, join(dir, 'aliasdir'), 'dir');
    symlinkSync('../secret', join(d2, 'leaf'));

    const out = resolveAssemblyPath(dir, 'aliasdir/leaf');

    expect(out.contained).toBe(false);
    expect(out.contained === false && out.escape === 'symlink' && out.realPath).toBe(
      join(outer, 'secret')
    );
  });

  it('is unaffected by the DIRECTORY itself being reached through a link', () => {
    // Both operands go through the same resolver, so an assembly directory
    // that is itself a link (macOS spells `/tmp` as `/private/tmp`) does not
    // make every candidate look like an escape.
    const outer = tmp();
    const real = join(outer, 'real-out');
    mkdirSync(real);
    mkdirSync(join(real, 'asset.abc123'));
    const link = join(outer, 'cdk.out');
    symlinkSync(real, link, 'dir');

    expect(resolveAssemblyPath(link, 'asset.abc123')).toEqual({
      contained: true,
      path: join(link, 'asset.abc123'),
    });
  });

  it('terminates on a symbolic-link cycle instead of spinning or throwing', () => {
    // MAX_LINK_HOPS. The OS gives up first (ELOOP), so an exhausted budget
    // answers "unresolvable" and leaves the lexical verdict standing rather
    // than refusing — safe, because nothing can open through such a chain.
    const dir = tmp();
    symlinkSync(join(dir, 'b'), join(dir, 'a'), 'dir');
    symlinkSync(join(dir, 'a'), join(dir, 'b'), 'dir');

    const started = Date.now();
    expect(() => resolveAssemblyPath(dir, 'a')).not.toThrow();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('spends MAX_PATH_COMPONENTS and then gives up, rather than overflowing', () => {
    // The budget's VALUE, asserted from both sides so the case cannot pass
    // with the budget removed: a count-based "does it throw" probe is
    // sub-floor, because the engine's own stack limit lands somewhere above
    // it. Under the budget the symlink arm still answers; over it the climb
    // gives up and the lexical verdict stands (the documented fail-open,
    // recorded on the constant).
    const outer = tmp();
    const dir = join(outer, 'cdk.out');
    mkdirSync(dir);
    symlinkSync(outer, join(dir, 'link'), 'dir');
    const under = (n: number): string =>
      `link/${Array.from({ length: n }, (_, i) => `d${i}`).join('/')}/leaf`;

    expect(resolveAssemblyPath(dir, under(990)).contained).toBe(false);
    expect(resolveAssemblyPath(dir, under(1010)).contained).toBe(true);
  });

  it('re-applies an ABSENT leaf under the link its parent really points at', () => {
    // The non-link half of the climb: `join(realParent, basename(target))`.
    // Return `target` instead and a live directory link with an absent leaf
    // reads as CONTAINED — the same class as the dangling-target fold above,
    // and the shape `cdkl start-api` hits, since it resolves without an
    // existence check.
    const outer = tmp();
    const dir = join(outer, 'cdk.out');
    const d2 = join(outer, 'd2');
    mkdirSync(dir);
    mkdirSync(d2);
    symlinkSync(d2, join(dir, 'aliasdir'), 'dir');

    const out = resolveAssemblyPath(dir, 'aliasdir/absent-asset');

    expect(out.contained).toBe(false);
    expect(out.contained === false && out.escape === 'symlink' && out.realPath).toBe(
      join(d2, 'absent-asset')
    );
  });
});

describe('absoluteAssemblyPathEscape', () => {
  it('reports an absolute path outside the bound', () => {
    const outer = tmp();
    const dir = join(outer, 'cdk.out');
    mkdirSync(dir);
    mkdirSync(join(outer, 'victim'));

    expect(absoluteAssemblyPathEscape(dir, join(outer, 'victim'))).toEqual({
      contained: false,
      escape: 'lexical',
      path: join(outer, 'victim'),
    });
  });

  it('treats the bound ITSELF as inside', () => {
    // An asset path legitimately names a DIRECTORY, unlike every caller of
    // `resolveAssemblyPath`, which reads a file.
    const dir = tmp();

    expect(absoluteAssemblyPathEscape(dir, dir)).toBeUndefined();
  });

  it('does NOT report an escape for a different SPELLING of a path inside', () => {
    // The real-path exoneration. `/tmp -> /private/tmp` on macOS makes two
    // spellings of one directory routine rather than exotic, and a false
    // "treat this assembly as untrusted" is what costs the warning its
    // meaning. Here the BOUND is the link and the value is the real path.
    const outer = tmp();
    const real = join(outer, 'real-out');
    mkdirSync(real);
    mkdirSync(join(real, 'src'));
    const boundViaLink = join(outer, 'cdk.out');
    symlinkSync(real, boundViaLink, 'dir');

    expect(absoluteAssemblyPathEscape(boundViaLink, join(real, 'src'))).toBeUndefined();
  });

  it('keeps the escape when the real paths CANNOT be looked up', () => {
    // `undefined` from the resolver is "could not look", which must not be
    // read as "the kernel says it is inside". Weaken the exoneration to
    // `reallyOutside !== true` and a value outside the bound that the kernel
    // refuses to resolve — here an ELOOP cycle — is silently accepted.
    const outer = tmp();
    const dir = join(outer, 'cdk.out');
    mkdirSync(dir);
    symlinkSync(join(outer, 'cyc-b'), join(outer, 'cyc-a'), 'dir');
    symlinkSync(join(outer, 'cyc-a'), join(outer, 'cyc-b'), 'dir');

    expect(absoluteAssemblyPathEscape(dir, join(outer, 'cyc-a'))).toEqual({
      contained: false,
      escape: 'lexical',
      path: join(outer, 'cyc-a'),
    });
  });

  it('still reports an escape when the real paths disagree too', () => {
    // The exoneration must not swallow a genuine escape: both operands
    // resolve, and they resolve apart.
    const outer = tmp();
    const dir = join(outer, 'cdk.out');
    mkdirSync(dir);
    mkdirSync(join(outer, 'victim'));

    expect(absoluteAssemblyPathEscape(dir, join(outer, 'victim'))?.escape).toBe('lexical');
  });

  it('reports a symlink escape for a path inside the bound that leads out', () => {
    const outer = tmp();
    const dir = join(outer, 'cdk.out');
    mkdirSync(dir);
    mkdirSync(join(outer, 'victim'));
    const link = join(dir, 'asset.link');
    symlinkSync(join(outer, 'victim'), link, 'dir');

    expect(absoluteAssemblyPathEscape(dir, link)).toEqual({
      contained: false,
      escape: 'symlink',
      path: link,
      realPath: join(outer, 'victim'),
    });
  });

  it('does NOT report a link that points AT the bound', () => {
    const outer = tmp();
    const dir = join(outer, 'cdk.out');
    mkdirSync(dir);
    const selfLink = join(dir, 'self');
    symlinkSync(dir, selfLink, 'dir');

    expect(absoluteAssemblyPathEscape(dir, selfLink)).toBeUndefined();
  });
});

describe('renderAssemblyPathEscape', () => {
  it('names the directory itself rather than claiming it is outside itself', () => {
    const dir = tmp();

    const said = renderAssemblyPathEscape(
      { contained: false, escape: 'lexical', path: dir },
      dir,
      'mount it'
    );

    expect(said).toContain('names the directory');
    expect(said).not.toContain('outside');
  });

  it('says where a symbolic link leads', () => {
    const outer = tmp();
    const dir = join(outer, 'cdk.out');
    mkdirSync(dir);

    const said = renderAssemblyPathEscape(
      {
        contained: false,
        escape: 'symlink',
        path: join(dir, 'link'),
        realPath: join(outer, 'victim'),
      },
      dir,
      'mount it'
    );

    expect(said).toContain('leads through a symbolic link to');
    expect(said).toContain(join(outer, 'victim'));
  });

  it('does not claim a link pointing AT the directory is outside it', () => {
    // The base is compared as the KERNEL sees it, because that is what
    // `realPath` is. Without that, `-a /tmp/cdk.out` on macOS prints
    // "outside '/tmp/cdk.out'" about a path that IS that directory.
    const dir = tmp();

    const said = renderAssemblyPathEscape(
      { contained: false, escape: 'symlink', path: join(dir, 'self'), realPath: dir },
      dir,
      'mount it'
    );

    expect(said).toContain('a symbolic link to the directory');
    expect(said).not.toContain('outside');
  });

  it('completes "Refusing to ..." with the caller\'s own verb', () => {
    const dir = tmp();

    expect(
      renderAssemblyPathEscape(
        { contained: false, escape: 'lexical', path: join(dir, '..', 'x') },
        dir,
        'mount it'
      )
    ).toContain('Refusing to mount it.');
  });

  it('FLATTENS control characters out of every rendered path', () => {
    // The message exists FOR a hand-modified assembly, so the path is
    // attacker-chosen and lands on a log line. `path.resolve` preserves
    // `\x1b[2K\r` and `\n`, which erase the line and forge benign ones in its
    // place — and for the absolute arm the warning IS the whole mitigation.
    const dir = tmp();
    const hostile = join(dir, '..', 'evil\u001b[2K\rINFO  all good\nINFO  done');

    const said = renderAssemblyPathEscape(
      { contained: false, escape: 'lexical', path: hostile },
      dir,
      'mount it'
    );

    expect(said).not.toMatch(/[\n\r\u001b]/);
    expect(said).toContain('evil');
  });
});
