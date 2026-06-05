import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import {
  resolveLambdaTarget,
  materializeAssetCodeDir,
} from '../../../src/local/lambda-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { CloudFormationTemplate, TemplateResource } from '../../../src/types/resource.js';

// Build a minimal StackInfo whose single Lambda points `aws:asset:path` at
// `assetPath` (relative to the cdk.out dir that `assetManifestPath` lives in).
function makeStack(
  cdkOutDir: string,
  assetPath: string,
  extraResources = {},
  extraProps: Record<string, unknown> = {}
): StackInfo {
  const lambda: TemplateResource = {
    Type: 'AWS::Lambda::Function',
    Properties: {
      Runtime: 'nodejs20.x',
      Handler: 'index.handler',
      ...extraProps,
    },
    Metadata: { 'aws:asset:path': assetPath },
  };
  const template: CloudFormationTemplate = {
    Resources: { Fn: lambda, ...extraResources },
  };
  return {
    stackName: 'TestStack',
    displayName: 'TestStack',
    artifactId: 'TestStack',
    template,
    assetManifestPath: join(cdkOutDir, 'TestStack.assets.json'),
    dependencyNames: [],
  };
}

describe('materializeAssetCodeDir', () => {
  let root: string;
  const made: string[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cdkl-zip-asset-test-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
  });

  it('passes an already-unzipped asset directory through untouched (no tmpDir)', () => {
    const dir = join(root, 'asset.dir');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.js'), 'exports.handler = () => {};');

    const out = materializeAssetCodeDir(dir);
    expect(out.dir).toBe(dir);
    expect(out.tmpDir).toBeUndefined();
  });

  it('extracts a .zip asset to a fresh temp dir and returns it as tmpDir', () => {
    const zipPath = join(root, 'asset.abc.zip');
    writeFileSync(
      zipPath,
      zipSync({
        'index.js': strToU8('exports.handler = () => ({ ok: true });'),
        'lib/util.js': strToU8('module.exports = 1;'),
      })
    );

    const out = materializeAssetCodeDir(zipPath);
    made.push(out.dir);
    expect(out.tmpDir).toBe(out.dir);
    expect(out.dir).not.toBe(zipPath);
    expect(readFileSync(join(out.dir, 'index.js'), 'utf-8')).toContain('ok: true');
    expect(readFileSync(join(out.dir, 'lib/util.js'), 'utf-8')).toBe('module.exports = 1;');
  });

  it('makes extracted files executable so a provided.* runtime bootstrap can be fork/exec-ed', () => {
    // fflate's unzipSync drops unix modes, so without restoring the executable
    // bit a `provided.*` custom runtime's `bootstrap` is written 0644 and RIE
    // fails the invoke with `Runtime.InvalidEntrypoint` /
    // `fork/exec /var/runtime/bootstrap: permission denied`.
    const zipPath = join(root, 'asset.boot.zip');
    writeFileSync(
      zipPath,
      zipSync({ bootstrap: strToU8('#!/bin/sh\nexec /usr/bin/true\n'), 'data.json': strToU8('{}') })
    );
    const out = materializeAssetCodeDir(zipPath);
    made.push(out.dir);
    // 0o111 = any execute bit set.
    expect(statSync(join(out.dir, 'bootstrap')).mode & 0o111).not.toBe(0);
    expect(statSync(join(out.dir, 'data.json')).mode & 0o111).not.toBe(0);
  });

  it('rejects a .zip entry that escapes the extraction root (zip-slip)', () => {
    const zipPath = join(root, 'evil.zip');
    writeFileSync(zipPath, zipSync({ '../escape.js': strToU8('pwned') }));
    expect(() => materializeAssetCodeDir(zipPath)).toThrow(/escapes the target dir/);
  });

  it('throws an actionable error when the asset file is not a readable ZIP', () => {
    const notZip = join(root, 'asset.bin.zip');
    writeFileSync(notZip, 'this is not a zip archive');
    expect(() => materializeAssetCodeDir(notZip)).toThrow(/could not be read as a ZIP archive/);
  });

  it('throws an actionable error (not a raw ENOENT) when the asset path is missing', () => {
    // Callers whose own resolver does not validate existence (e.g. start-api's
    // local resolveAssetCodePath) rely on this guard for a friendly message.
    expect(() => materializeAssetCodeDir(join(root, 'nope.zip'))).toThrow(/does not exist/);
  });
});

describe('resolveLambdaTarget asset code path (zip vs directory)', () => {
  let cdkOut: string;

  beforeEach(() => {
    cdkOut = mkdtempSync(join(tmpdir(), 'cdkl-zip-resolve-test-'));
  });
  afterEach(() => {
    rmSync(cdkOut, { recursive: true, force: true });
  });

  it('resolves codePath to a .zip asset FILE (Code.fromAsset of a zip)', () => {
    const zipName = 'asset.deadbeef.zip';
    writeFileSync(join(cdkOut, zipName), zipSync({ 'index.js': strToU8('x') }));
    const stack = makeStack(cdkOut, zipName);

    const resolved = resolveLambdaTarget('Fn', [stack]);
    expect(resolved.kind).toBe('zip');
    if (resolved.kind === 'zip') {
      expect(resolved.codePath).toBe(join(cdkOut, zipName));
    }
  });

  it('still resolves codePath to an unzipped asset directory (the common case)', () => {
    const dirName = 'asset.cafef00d';
    mkdirSync(join(cdkOut, dirName), { recursive: true });
    writeFileSync(join(cdkOut, dirName, 'index.js'), 'x');
    const stack = makeStack(cdkOut, dirName);

    const resolved = resolveLambdaTarget('Fn', [stack]);
    expect(resolved.kind).toBe('zip');
    if (resolved.kind === 'zip') {
      expect(resolved.codePath).toBe(join(cdkOut, dirName));
    }
  });

  it('errors clearly when the asset path does not exist', () => {
    const stack = makeStack(cdkOut, 'asset.missing.zip');
    expect(() => resolveLambdaTarget('Fn', [stack])).toThrow(/does not exist/);
  });

  it('carries the declared architecture (so the container runs at the right --platform)', () => {
    const dirName = 'asset.arch';
    mkdirSync(join(cdkOut, dirName), { recursive: true });
    writeFileSync(join(cdkOut, dirName, 'index.js'), 'x');

    const arm = resolveLambdaTarget('Fn', [makeStack(cdkOut, dirName, {}, { Architectures: ['arm64'] })]);
    expect(arm.kind).toBe('zip');
    if (arm.kind === 'zip') expect(arm.architecture).toBe('arm64');

    // Default (no Architectures) is x86_64, matching AWS.
    const def = resolveLambdaTarget('Fn', [makeStack(cdkOut, dirName)]);
    if (def.kind === 'zip') expect(def.architecture).toBe('x86_64');
  });
});
