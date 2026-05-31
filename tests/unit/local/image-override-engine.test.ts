import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  buildImageOverrideTag,
  ImageOverrideError,
  parseImageOverrideFlags,
  resolveImageOverrides,
} from '../../../src/local/image-override-engine.js';

/**
 * Issue #238 — engine-level coverage. The picker / boot-prompt branches
 * are TTY-gated via `isInteractive()` and a real `@clack/prompts`
 * `multiselect` / `text` would require a live terminal — exercised at
 * the binding-test level (TTY=false short-circuit) here. The parser +
 * Stage-1 explicit resolution + tag derivation are fully unit-tested.
 */

function makeTmpDockerfile(name = 'Dockerfile'): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cdkl-override-engine-'));
  const file = path.join(dir, name);
  writeFileSync(file, 'FROM scratch\n');
  return file;
}

describe('parseImageOverrideFlags (issue #238)', () => {
  it('parses explicit <svc>=<dockerfile> form into the explicit map', () => {
    const out = parseImageOverrideFlags({
      imageOverride: ['AppService=./services/app/Dockerfile'],
    });
    expect(out.explicit.size).toBe(1);
    expect(out.explicit.get('AppService')).toBe('./services/app/Dockerfile');
    expect(out.pickerPaths).toEqual([]);
  });

  it('parses picker-form bare <dockerfile> into pickerPaths in CLI order', () => {
    const out = parseImageOverrideFlags({
      imageOverride: ['./a/Dockerfile', './b/Dockerfile'],
    });
    expect(out.explicit.size).toBe(0);
    expect(out.pickerPaths).toEqual(['./a/Dockerfile', './b/Dockerfile']);
  });

  it('supports mixed explicit + picker-form in one invocation', () => {
    const out = parseImageOverrideFlags({
      imageOverride: ['Svc=./a/Dockerfile', './b/Dockerfile'],
    });
    expect(out.explicit.get('Svc')).toBe('./a/Dockerfile');
    expect(out.pickerPaths).toEqual(['./b/Dockerfile']);
  });

  it('rejects an empty bare value', () => {
    expect(() => parseImageOverrideFlags({ imageOverride: [''] })).toThrow(
      /empty string/
    );
  });

  it('rejects a duplicate explicit mapping for the same service', () => {
    expect(() =>
      parseImageOverrideFlags({
        imageOverride: ['Svc=./a/Dockerfile', 'Svc=./b/Dockerfile'],
      })
    ).toThrow(ImageOverrideError);
  });

  it('rejects an explicit form with empty service or empty dockerfile side', () => {
    expect(() => parseImageOverrideFlags({ imageOverride: ['=./a/Dockerfile'] })).toThrow();
    expect(() => parseImageOverrideFlags({ imageOverride: ['Svc='] })).toThrow();
  });

  it('parses --image-build-arg into globals.buildArgs preserving order', () => {
    const out = parseImageOverrideFlags({
      imageBuildArg: ['A=1', 'B=2'],
    });
    expect(Array.from(out.globals.buildArgs.entries())).toEqual([
      ['A', '1'],
      ['B', '2'],
    ]);
  });

  it('rejects malformed --image-build-arg (no =)', () => {
    expect(() => parseImageOverrideFlags({ imageBuildArg: ['BAD'] })).toThrow(/KEY=VAL/);
  });

  it('rejects --image-build-arg with empty key', () => {
    expect(() => parseImageOverrideFlags({ imageBuildArg: ['=value'] })).toThrow(/KEY=VAL/);
  });

  it('parses --image-build-secret id=src into globals.buildSecrets', () => {
    const out = parseImageOverrideFlags({
      imageBuildSecret: ['npmrc=./.npmrc', 'token=./token.txt'],
    });
    expect(out.globals.buildSecrets.get('npmrc')).toBe('./.npmrc');
    expect(out.globals.buildSecrets.get('token')).toBe('./token.txt');
  });

  it('rejects --image-build-secret with empty id or src', () => {
    expect(() => parseImageOverrideFlags({ imageBuildSecret: ['=src'] })).toThrow();
    expect(() => parseImageOverrideFlags({ imageBuildSecret: ['id='] })).toThrow();
  });

  it('parses --image-target into globals.targetStage', () => {
    const out = parseImageOverrideFlags({ imageTarget: 'builder' });
    expect(out.globals.targetStage).toBe('builder');
  });

  it('rejects an empty --image-target', () => {
    expect(() => parseImageOverrideFlags({ imageTarget: '' })).toThrow();
  });
});

describe('resolveImageOverrides Stage 1: explicit mappings (issue #238)', () => {
  it('binds an explicit mapping to a pinned target', async () => {
    const dockerfile = makeTmpDockerfile();
    const rawFlags = parseImageOverrideFlags({
      imageOverride: [`AppService=${dockerfile}`],
    });
    const overrides = await resolveImageOverrides({
      rawFlags,
      pinnedTargets: ['AppService'],
    });
    expect(overrides.size).toBe(1);
    const entry = overrides.get('AppService');
    expect(entry?.dockerfile).toBe(dockerfile);
    expect(entry?.contextDir).toBe(path.dirname(dockerfile));
  });

  it('drops an explicit mapping naming a non-pinned target with a warning', async () => {
    const dockerfile = makeTmpDockerfile();
    const rawFlags = parseImageOverrideFlags({
      imageOverride: [`NotPinned=${dockerfile}`],
    });
    const overrides = await resolveImageOverrides({
      rawFlags,
      pinnedTargets: ['AppService'],
    });
    expect(overrides.size).toBe(0);
  });

  it('hard-errors when the explicit Dockerfile path does not exist', async () => {
    const rawFlags = parseImageOverrideFlags({
      imageOverride: ['AppService=/nonexistent/path/Dockerfile'],
    });
    await expect(
      resolveImageOverrides({
        rawFlags,
        pinnedTargets: ['AppService'],
      })
    ).rejects.toBeInstanceOf(ImageOverrideError);
  });

  it('threads build-args / build-secrets / target-stage globals into every entry', async () => {
    const dockerfile = makeTmpDockerfile();
    const rawFlags = parseImageOverrideFlags({
      imageOverride: [`Svc=${dockerfile}`],
      imageBuildArg: ['NODE_ENV=production'],
      imageBuildSecret: ['npmrc=./.npmrc'],
      imageTarget: 'release',
    });
    const overrides = await resolveImageOverrides({
      rawFlags,
      pinnedTargets: ['Svc'],
    });
    const entry = overrides.get('Svc');
    expect(entry?.buildArgs.get('NODE_ENV')).toBe('production');
    expect(entry?.buildSecrets.get('npmrc')).toBe('./.npmrc');
    expect(entry?.targetStage).toBe('release');
  });
});

describe('resolveImageOverrides Stage 2: picker form (non-TTY skip) (issue #238)', () => {
  it('skips picker-form Dockerfile paths when not interactive (non-TTY context)', async () => {
    // In the vitest runner, stdin / stdout are typically NOT TTYs, so the
    // picker branch falls through to its non-TTY warn-and-skip path. The
    // result: no override is produced from a picker-form path here, which
    // is the expected CI/non-TTY behaviour.
    const dockerfile = makeTmpDockerfile();
    const rawFlags = parseImageOverrideFlags({
      imageOverride: [dockerfile],
    });
    const overrides = await resolveImageOverrides({
      rawFlags,
      pinnedTargets: ['AppService'],
      noInteractive: true,
    });
    expect(overrides.size).toBe(0);
  });
});

describe('resolveImageOverrides Stage 3: boot prompt (non-TTY skip) (issue #238)', () => {
  it('skips the boot prompt when noInteractive=true', async () => {
    const rawFlags = parseImageOverrideFlags({});
    const overrides = await resolveImageOverrides({
      rawFlags,
      pinnedTargets: ['Pinned1', 'Pinned2'],
      interactiveBootPrompt: true,
      noInteractive: true,
    });
    expect(overrides.size).toBe(0);
  });

  it('returns an empty map when there are no flags and no prompt opt-in', async () => {
    const rawFlags = parseImageOverrideFlags({});
    const overrides = await resolveImageOverrides({
      rawFlags,
      pinnedTargets: ['Pinned1'],
    });
    expect(overrides.size).toBe(0);
  });
});

describe('buildImageOverrideTag (issue #238)', () => {
  const baseEntry = {
    dockerfile: '/abs/Dockerfile',
    contextDir: '/abs',
    buildArgs: new Map<string, string>(),
    buildSecrets: new Map<string, string>(),
  };

  it('produces a deterministic tag for the same inputs', () => {
    const tag1 = buildImageOverrideTag('AppService', baseEntry);
    const tag2 = buildImageOverrideTag('AppService', baseEntry);
    expect(tag1).toBe(tag2);
  });

  it('differs by service target', () => {
    const tagA = buildImageOverrideTag('A', baseEntry);
    const tagB = buildImageOverrideTag('B', baseEntry);
    expect(tagA).not.toBe(tagB);
  });

  it('differs when Dockerfile path differs', () => {
    const tag1 = buildImageOverrideTag('Svc', baseEntry);
    const tag2 = buildImageOverrideTag('Svc', { ...baseEntry, dockerfile: '/other/Dockerfile' });
    expect(tag1).not.toBe(tag2);
  });

  it('differs when build args / secrets / target-stage differ', () => {
    const tag0 = buildImageOverrideTag('Svc', baseEntry);
    const tag1 = buildImageOverrideTag('Svc', {
      ...baseEntry,
      buildArgs: new Map([['K', 'V']]),
    });
    const tag2 = buildImageOverrideTag('Svc', {
      ...baseEntry,
      buildSecrets: new Map([['s', 'v']]),
    });
    const tag3 = buildImageOverrideTag('Svc', { ...baseEntry, targetStage: 'builder' });
    expect(new Set([tag0, tag1, tag2, tag3]).size).toBe(4);
  });

  it('emits a :local suffix so the tag never pretends to be a real registry', () => {
    const tag = buildImageOverrideTag('Svc', baseEntry);
    expect(tag.endsWith(':local')).toBe(true);
  });

  it('slugifies a CDK path with slashes into a docker-tag-safe segment', () => {
    const tag = buildImageOverrideTag('MyStack/AppService', baseEntry);
    // No `/` allowed in tag NAME segment (Docker rejects it).
    const repo = tag.split(':')[0]!;
    expect(repo).not.toMatch(/\//);
  });
});
