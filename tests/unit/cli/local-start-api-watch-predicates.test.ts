import { describe, it, expect } from 'vite-plus/test';
import * as path from 'node:path';
import { createWatchPredicates } from '../../../src/cli/commands/local-start-api.js';
import type { CdkWatchConfig } from '../../../src/cli/config-loader.js';

const ROOT = path.resolve('/proj');
const abs = (...parts: string[]): string => path.join(ROOT, ...parts);
const cfg = (over: Partial<CdkWatchConfig> = {}): CdkWatchConfig => ({
  include: ['**'],
  exclude: [],
  ...over,
});

describe('createWatchPredicates', () => {
  it('always excludes the output dir, node_modules, and .git', () => {
    const { ignored, excludePatterns } = createWatchPredicates({
      watchRoot: ROOT,
      output: 'cdk.out',
      watchConfig: cfg(),
    });
    expect(excludePatterns).toEqual(['cdk.out', 'cdk.context.json', 'node_modules', '.git']);
    expect(ignored(abs('cdk.out', 'asset.123', 'index.js'))).toBe(true);
    expect(ignored(abs('node_modules', 'foo', 'index.js'))).toBe(true);
    expect(ignored(abs('.git', 'HEAD'))).toBe(true);
    expect(ignored(abs('src', 'handler.ts'))).toBe(false);
  });

  it('excludes every file cdkl itself writes into the tree, by default (#888)', () => {
    const { ignored, shouldTrigger, excludePatterns } = createWatchPredicates({
      watchRoot: ROOT,
      output: 'out/synth',
      watchConfig: cfg(),
      tmpDir: abs('.tmp'),
    });
    expect(excludePatterns.slice(0, 3)).toEqual(['out/synth', '.tmp', 'cdk.context.json']);
    for (const p of [
      abs('out', 'synth', 'manifest.json'),
      abs('.tmp', 'cdkl-lambda-zip-x', 'a.js'),
      abs('cdk.context.json'),
    ]) {
      expect(ignored(p)).toBe(true);
      expect(shouldTrigger(p)).toBe(false);
    }
    // Anchored at the root: a same-named user path deeper in the tree still fires.
    expect(shouldTrigger(abs('src', '.tmp', 'handler.ts'))).toBe(true);
    expect(shouldTrigger(abs('sub', 'cdk.context.json'))).toBe(true);
    // A user-owned file is NOT cdkl's to exclude: it fires until the user lists it.
    expect(shouldTrigger(abs('app.log'))).toBe(true);
    const withUser = createWatchPredicates({
      watchRoot: ROOT,
      output: 'cdk.out',
      watchConfig: cfg({ exclude: ['*.log'] }),
    });
    expect(withUser.shouldTrigger(abs('app.log'))).toBe(false);
  });

  it('a temp dir outside the root or equal to it adds no exclude', () => {
    for (const tmpDir of [path.resolve('/elsewhere/tmp'), ROOT]) {
      const { excludePatterns } = createWatchPredicates({
        watchRoot: ROOT,
        output: 'cdk.out',
        watchConfig: cfg(),
        tmpDir,
      });
      expect(excludePatterns).toEqual(['cdk.out', 'cdk.context.json', 'node_modules', '.git']);
    }
  });

  it('never ignores the watch root itself, and ignores paths outside it', () => {
    const { ignored, shouldTrigger } = createWatchPredicates({
      watchRoot: ROOT,
      output: 'cdk.out',
      watchConfig: cfg(),
    });
    expect(ignored(ROOT)).toBe(false);
    expect(ignored(path.resolve('/elsewhere', 'x.ts'))).toBe(true);
    expect(shouldTrigger(ROOT)).toBe(false);
    expect(shouldTrigger(path.resolve('/elsewhere', 'x.ts'))).toBe(false);
  });

  it('shouldTrigger fires for an included source file and not for an excluded one', () => {
    const { shouldTrigger } = createWatchPredicates({
      watchRoot: ROOT,
      output: 'cdk.out',
      watchConfig: cfg({ exclude: ['*.md'] }),
    });
    expect(shouldTrigger(abs('src', 'handler.ts'))).toBe(true);
    expect(shouldTrigger(abs('README.md'))).toBe(false);
    expect(shouldTrigger(abs('cdk.out', 'tree.json'))).toBe(false);
  });

  it('honors a narrowed watch.include (non-included files do not trigger but are not pruned)', () => {
    const { ignored, shouldTrigger } = createWatchPredicates({
      watchRoot: ROOT,
      output: 'cdk.out',
      watchConfig: cfg({ include: ['src/**'] }),
    });
    expect(shouldTrigger(abs('src', 'a.ts'))).toBe(true);
    expect(shouldTrigger(abs('lib', 'a.ts'))).toBe(false);
    // include only gates the reload, never chokidar traversal — `lib/`
    // must still be descended (it is not excluded).
    expect(ignored(abs('lib', 'a.ts'))).toBe(false);
  });

  it('exclude wins over include (exclude checked first in shouldTrigger)', () => {
    const { shouldTrigger } = createWatchPredicates({
      watchRoot: ROOT,
      output: 'cdk.out',
      watchConfig: cfg({ include: ['**'], exclude: ['secrets/**'] }),
    });
    expect(shouldTrigger(abs('secrets', 'key.ts'))).toBe(false);
    expect(shouldTrigger(abs('app', 'key.ts'))).toBe(true);
  });

  it('handles an absolute --output that lives under the watch root', () => {
    const { ignored, excludePatterns } = createWatchPredicates({
      watchRoot: ROOT,
      output: abs('cdk.out'),
      watchConfig: cfg(),
    });
    expect(excludePatterns).toEqual(['cdk.out', 'cdk.context.json', 'node_modules', '.git']);
    expect(ignored(abs('cdk.out', 'x'))).toBe(true);
  });

  it('drops the output exclude when --output equals the watch root', () => {
    const { excludePatterns } = createWatchPredicates({
      watchRoot: ROOT,
      output: '.',
      watchConfig: cfg(),
    });
    expect(excludePatterns).toEqual(['cdk.context.json', 'node_modules', '.git']);
  });

  it('drops the output exclude when --output is outside the watch root (still loop-safe)', () => {
    const { ignored, excludePatterns } = createWatchPredicates({
      watchRoot: ROOT,
      output: path.join('..', 'shared-out'),
      watchConfig: cfg(),
    });
    // Not added as a glob (it is not under the root)...
    expect(excludePatterns).toEqual(['cdk.context.json', 'node_modules', '.git']);
    // ...but a watcher rooted at ROOT never reaches it, and the `..`
    // guard ignores it anyway, so re-synth writes there can't loop.
    expect(ignored(path.resolve('/shared-out', 'tree.json'))).toBe(true);
  });
});
