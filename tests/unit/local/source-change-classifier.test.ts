import { describe, it, expect } from 'vite-plus/test';
import {
  classifySourceChange,
  type ReloadAssetContext,
} from '../../../src/local/source-change-classifier.js';

/**
 * Phase 4 of issue #214 — classifier unit lock.
 *
 * Each `it.each` row is a `(changedPaths, ctx) → expected verdict`
 * triple. The classifier is pure + synchronous, so this is the
 * authoritative spec — any future change to the rebuild-trigger /
 * compiled-language / Dockerfile heuristics MUST update a row here.
 */

const baseCtx: ReloadAssetContext = {
  oldAssetHash: 'oldhash',
  newAssetHash: 'newhash',
  newAssetSourceDir: '/tmp/cdk.out/asset.newhash',
  dockerFile: 'Dockerfile',
};

describe('classifySourceChange', () => {
  it('returns rebuild when no asset context is supplied (image is not a CDK asset)', () => {
    const v = classifySourceChange(['/repo/webapp/server.sh'], undefined);
    expect(v.kind).toBe('rebuild');
    expect(v.reason.toLowerCase()).toContain('not a cdk');
  });

  it('returns rebuild when no paths changed (defensive)', () => {
    const v = classifySourceChange([], baseCtx);
    expect(v.kind).toBe('rebuild');
    expect(v.reason.toLowerCase()).toContain('no changed paths');
  });

  it('returns rebuild when the asset hash did not flip across the synth (CDK construct edit)', () => {
    // The user edited `lib/stack.ts` to add an env var. The synth
    // re-ran and produced the same asset hash for the running
    // container's image, but the task spec changed (new env). Soft-
    // reload would `docker cp` identical files and `docker restart`
    // with the OLD task spec → the new env silently wouldn't apply.
    // The classifier MUST force rebuild here.
    const v = classifySourceChange(
      ['/repo/lib/stack.ts'],
      { ...baseCtx, oldAssetHash: 'same', newAssetHash: 'same' }
    );
    expect(v.kind).toBe('rebuild');
    expect(v.reason).toContain('asset hash unchanged');
  });

  it('returns rebuild when the OLD asset hash is missing (image kind changed mid-watch)', () => {
    // Unusual but possible: the user replaced an ECR pin with a CDK
    // fromAsset image mid-watch. The OLD service had no assetHash;
    // the NEW one does. Defensive default to rebuild — we have no
    // basis for the soft-reload comparison.
    const ctx: ReloadAssetContext = {
      newAssetHash: 'newhash',
      newAssetSourceDir: '/tmp/cdk.out/asset.newhash',
      dockerFile: 'Dockerfile',
    };
    const v = classifySourceChange(['/repo/webapp/server.sh'], ctx);
    expect(v.kind).toBe('rebuild');
    expect(v.reason).toContain('asset hash unchanged');
  });

  it('returns soft-reload for a single interpreted source file', () => {
    const v = classifySourceChange(['/repo/webapp/server.sh'], baseCtx);
    expect(v.kind).toBe('soft-reload');
    if (v.kind === 'soft-reload') {
      expect(v.newAssetSourceDir).toBe('/tmp/cdk.out/asset.newhash');
    }
  });

  it('returns soft-reload for multiple interpreted source files', () => {
    const v = classifySourceChange(
      ['/repo/webapp/server.sh', '/repo/webapp/util.js', '/repo/webapp/handler.py'],
      baseCtx
    );
    expect(v.kind).toBe('soft-reload');
  });

  it('returns rebuild when the Dockerfile is among the changed paths', () => {
    const v = classifySourceChange(
      ['/repo/webapp/server.sh', '/repo/webapp/Dockerfile'],
      baseCtx
    );
    expect(v.kind).toBe('rebuild');
    expect(v.reason).toContain('Dockerfile');
  });

  it('returns rebuild for a Dockerfile.<variant> sibling (Dockerfile.prod / Dockerfile.dev)', () => {
    const v1 = classifySourceChange(['/repo/Dockerfile.prod'], baseCtx);
    expect(v1.kind).toBe('rebuild');
    expect(v1.reason).toContain('Dockerfile.prod');
    const v2 = classifySourceChange(['/repo/Dockerfile.dev'], baseCtx);
    expect(v2.kind).toBe('rebuild');
  });

  it('respects a non-default Dockerfile basename (ctx.dockerFile)', () => {
    const ctx: ReloadAssetContext = { ...baseCtx, dockerFile: 'BuildSpec' };
    const v = classifySourceChange(['/repo/webapp/BuildSpec'], ctx);
    expect(v.kind).toBe('rebuild');
    expect(v.reason).toContain('BuildSpec');
  });

  it.each([
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'requirements.txt',
    'pyproject.toml',
    'poetry.lock',
    'Pipfile.lock',
    'go.mod',
    'go.sum',
    'Cargo.toml',
    'Cargo.lock',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
  ])('returns rebuild on dependency-manifest edit: %s', (basename) => {
    const v = classifySourceChange([`/repo/webapp/${basename}`], baseCtx);
    expect(v.kind).toBe('rebuild');
    expect(v.reason).toContain(basename);
  });

  // Locks the FULL `COMPILED_LANGUAGE_EXTENSIONS` set the classifier
  // declares; a row-per-extension keeps the spec rigid so a future
  // refactor that drops one of these extensions trips a test instead
  // of silently flipping the verdict for that language.
  it.each([
    'main.go',
    'lib.rs',
    'App.java',
    'Build.kts',
    'App.kt',
    'main.scala',
    'Program.cs',
    'main.swift',
    'main.fs',
    'main.fsx',
    'main.c',
    'main.cc',
    'main.cpp',
    'main.cxx',
    'app.h',
    'app.hpp',
    'main.zig',
    'main.ml',
    'main.mli',
    'Main.elm',
    'Main.hs',
    'main.dart',
  ])(
    'returns rebuild for compiled-language source: %s (soft-reload would leave the binary stale)',
    (basename) => {
      const v = classifySourceChange([`/repo/webapp/${basename}`], baseCtx);
      expect(v.kind).toBe('rebuild');
      expect(v.reason).toContain('compiled-language');
    }
  );

  it('handles a custom Dockerfile basename that includes a subdirectory in the asset manifest (loader-side normalization)', () => {
    // Verifies the boundary contract: the classifier compares its
    // `ctx.dockerFile` field against `path.basename(changedPath)`.
    // Callers (the emulator's `loadAssetContextForTarget`) MUST
    // normalize `source.dockerFile` to a basename before populating
    // ctx — otherwise an edit to `dockerfiles/Prod.Dockerfile` would
    // silently route to soft-reload. This test row locks that
    // contract: when `ctx.dockerFile` is already a basename
    // (post-normalization), an edit to the same basename triggers
    // rebuild.
    const ctx: ReloadAssetContext = { ...baseCtx, dockerFile: 'Prod.Dockerfile' };
    const v = classifySourceChange(['/repo/dockerfiles/Prod.Dockerfile'], ctx);
    expect(v.kind).toBe('rebuild');
    expect(v.reason).toContain('Prod.Dockerfile');
  });

  it.each(['.sh', '.js', '.mjs', '.cjs', '.ts', '.py', '.rb'])(
    'returns soft-reload for an interpreted-language source: handler%s',
    (ext) => {
      const v = classifySourceChange([`/repo/webapp/handler${ext}`], baseCtx);
      expect(v.kind).toBe('soft-reload');
    }
  );

  it('returns rebuild when a mix of source files includes a Dockerfile (one trigger wins)', () => {
    const v = classifySourceChange(
      ['/repo/webapp/server.sh', '/repo/webapp/handler.py', '/repo/webapp/Dockerfile'],
      baseCtx
    );
    expect(v.kind).toBe('rebuild');
  });

  it('returns rebuild when a mix includes a compiled-language source (one trigger wins)', () => {
    const v = classifySourceChange(
      ['/repo/webapp/server.sh', '/repo/cmd/main.go'],
      baseCtx
    );
    expect(v.kind).toBe('rebuild');
  });

  it('is case-insensitive on the file extension check', () => {
    const v = classifySourceChange(['/repo/webapp/HANDLER.GO'], baseCtx);
    expect(v.kind).toBe('rebuild');
  });

  it('soft-reload verdict carries the newAssetSourceDir from the asset context', () => {
    const v = classifySourceChange(['/repo/webapp/server.sh'], baseCtx);
    if (v.kind !== 'soft-reload') throw new Error('expected soft-reload');
    expect(v.newAssetSourceDir).toBe(baseCtx.newAssetSourceDir);
  });
});
