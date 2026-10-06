import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vite-plus/test';
import * as main from '../../src/index.js';
import * as internal from '../../src/internal.js';

describe('package export surface', () => {
  it('exposes the stable public API from the main entry', () => {
    // A representative slice of the semver-covered public surface. These
    // must never silently disappear from `cdk-local` (the main entry).
    const publicSymbols = [
      'createLocalInvokeCommand',
      'createLocalInvokeAgentCoreCommand',
      'createLocalStartApiCommand',
      'createLocalRunTaskCommand',
      'createLocalStartServiceCommand',
      'createLocalStartAlbCommand',
      'createLocalListCommand',
      'createLocalStudioCommand',
      'setEmbedConfig',
      'getEmbedConfig',
      'resetEmbedConfig',
    ];
    for (const sym of publicSymbols) {
      expect(main, `main entry is missing public symbol ${sym}`).toHaveProperty(sym);
    }
  });

  it('exposes low-level building blocks from the cdk-local/internal entry', () => {
    const internalKeys = Object.keys(internal);
    expect(internalKeys.length).toBeGreaterThan(0);
    // Spot-check a few internal-only helpers a shim host consumes.
    expect(internal).toHaveProperty('pickRefLogicalId');
    expect(internal).toHaveProperty('resolveLambdaArnIntrinsic');
    // Issue #570: the two credential-error policy entry points. Their JSDoc in
    // `src/internal.ts` advertises them as a host-reuse contract, which is not
    // a contract at all unless something fails when they disappear.
    expect(internal).toHaveProperty('describeAwsFailureForWarn');
    expect(internal).toHaveProperty('describeCredentialLoadFailure');
    // Issue #784: a host with its own container-env builder (cdkd's
    // `local invoke`) needs the dynamic-reference resolver.
    expect(internal).toHaveProperty('resolveDynamicReferencesInEnv');
    expect(internal).toHaveProperty('DynamicReferenceResolver');
    expect(internal).toHaveProperty('keysNotFromTemplate');
  });

  it('does NOT leak internal building blocks into the main entry', () => {
    // The internal surface is reachable ONLY via `cdk-local/internal`; the
    // main entry must not re-export it (otherwise those symbols would be
    // frozen into the semver-covered public API). If someone re-adds an
    // `export * from './internal.js'` to the main entry, this breaks loudly.
    const leaked = Object.keys(internal).filter((key) => key in main);
    expect(leaked, `internal symbols leaked into the main entry: ${leaked.join(', ')}`).toEqual([]);
  });

  it('every package.json export points at a file `vp pack` emits', async () => {
    // A subpath whose target no pack entry produces resolves to
    // ERR_MODULE_NOT_FOUND for every consumer (`./state-provider` shipped that
    // way from the first release).
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      main: string;
      types: string;
      bin: Record<string, string>;
      exports: Record<string, string | Record<string, string>>;
    };
    const { default: config } = await import('../../vite.config.ts');
    const entries = Object.keys((config as { pack: { entry: Record<string, string> } }).pack.entry);
    const emitted = new Set(entries.flatMap((name) => [`./dist/${name}.js`, `./dist/${name}.d.ts`]));
    const normalize = (p: string): string => (p.startsWith('./') ? p : `./${p}`);
    const targets: Array<[string, string]> = [
      ['main', pkg.main],
      ['types', pkg.types],
      ...Object.entries(pkg.bin).map(([name, p]): [string, string] => [`bin.${name}`, p]),
      ...Object.entries(pkg.exports).flatMap(([subpath, target]): Array<[string, string]> =>
        typeof target === 'string'
          ? [[`exports["${subpath}"]`, target]]
          : Object.entries(target).map(([cond, p]): [string, string] => [
              `exports["${subpath}"].${cond}`,
              p,
            ])
      ),
    ];
    for (const [field, path] of targets) {
      expect(emitted, field).toContain(normalize(path));
    }
  });
});
