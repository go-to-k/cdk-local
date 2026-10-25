import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import {
  findFileAssetForObjectKey,
  parseWebFunctionBuildConfig,
  resolveWebFunctionArtifact,
} from '../../../src/local/web-function-artifact.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { AssetManifest } from '../../../src/types/assets.js';

const BOOTSTRAP_BUCKET = { 'Fn::Sub': 'cdk-hnb659fds-assets-${AWS::AccountId}-${AWS::Region}' };

const buildConfig = (key: unknown, extraCode: Record<string, unknown> = {}): unknown => ({
  CodeConfig: { S3Object: { Bucket: BOOTSTRAP_BUCKET, Key: key }, ...extraCode },
  RuntimeConfig: { Runtime: 'nodejs24.x' },
});

describe('parseWebFunctionBuildConfig', () => {
  it('reads the runtime and the S3Object of a CDK asset', () => {
    const parsed = parseWebFunctionBuildConfig('Rev', buildConfig('abc123.zip'));
    expect(parsed.runtime).toBe('nodejs24.x');
    expect(parsed.s3Object.key).toBe('abc123.zip');
    expect(parsed.s3Object.bucket).toEqual(BOOTSTRAP_BUCKET);
  });

  it('fails naming an unknown CodeConfig key rather than ignoring it', () => {
    expect(() =>
      parseWebFunctionBuildConfig('Rev', {
        CodeConfig: { ImageUri: 'x' },
        RuntimeConfig: { Runtime: 'nodejs24.x' },
      })
    ).toThrow(/CodeConfig\.ImageUri, which cdkl start-web-function does not support yet\. Supported: S3Object/);
  });

  it('fails on an unknown key even next to a supported S3Object', () => {
    expect(() => parseWebFunctionBuildConfig('Rev', buildConfig('k.zip', { Future: {} }))).toThrow(
      /CodeConfig\.Future/
    );
  });

  it('fails on an intrinsic S3Object.Key, saying the code must come from a CDK asset', () => {
    expect(() =>
      parseWebFunctionBuildConfig('Rev', buildConfig({ 'Fn::ImportValue': 'KeyExport' }))
    ).toThrow(/not a literal string.*must come from a CDK asset in this app/);
  });

  it('fails without a CodeConfig, and without an S3Object', () => {
    expect(() =>
      parseWebFunctionBuildConfig('Rev', { RuntimeConfig: { Runtime: 'nodejs24.x' } })
    ).toThrow(/has no BuildConfig\.CodeConfig object/);
    expect(() =>
      parseWebFunctionBuildConfig('Rev', {
        CodeConfig: {},
        RuntimeConfig: { Runtime: 'nodejs24.x' },
      })
    ).toThrow(/has no BuildConfig\.CodeConfig\.S3Object/);
  });

  it('passes VersionId through', () => {
    const parsed = parseWebFunctionBuildConfig('Rev', {
      CodeConfig: { S3Object: { Bucket: 'b', Key: 'k.zip', VersionId: 'v1' } },
      RuntimeConfig: { Runtime: 'nodejs24.x' },
    });
    expect(parsed.s3Object).toEqual({ bucket: 'b', key: 'k.zip', versionId: 'v1' });
  });

  it('fails without a literal runtime', () => {
    expect(() =>
      parseWebFunctionBuildConfig('Rev', { CodeConfig: { S3Object: { Key: 'k' } } })
    ).toThrow(/no literal BuildConfig\.RuntimeConfig\.Runtime/);
  });
});

describe('findFileAssetForObjectKey', () => {
  const manifest = (objectKey: string): AssetManifest => ({
    version: '52.0.0',
    files: {
      abc123: {
        displayName: 'Code',
        source: { path: 'asset.abc123', packaging: 'zip' },
        destinations: { d: { bucketName: 'b', objectKey } },
      },
    },
    dockerImages: {},
  });

  it('matches the destination objectKey exactly', () => {
    expect(findFileAssetForObjectKey(manifest('abc123.zip'), 'abc123.zip')?.hash).toBe('abc123');
  });

  it('matches a prefixed destination objectKey by its last segment', () => {
    expect(findFileAssetForObjectKey(manifest('pre/abc123.zip'), 'abc123.zip')?.hash).toBe(
      'abc123'
    );
  });

  it('matches a prefixed key only at a segment boundary', () => {
    const other: AssetManifest = {
      version: '52.0.0',
      files: {
        zzz: {
          displayName: 'Other',
          source: { path: 'asset.zzz', packaging: 'zip' },
          destinations: { d: { bucketName: 'b', objectKey: 'xkey.zip' } },
        },
      },
      dockerImages: {},
    };
    expect(findFileAssetForObjectKey(other, 'key.zip')).toBeUndefined();
  });

  it('falls back to the manifest entry keyed by the hash', () => {
    expect(findFileAssetForObjectKey(manifest('other.zip'), 'abc123.zip')?.hash).toBe('abc123');
  });

  it('returns undefined for a key no asset carries', () => {
    expect(findFileAssetForObjectKey(manifest('abc123.zip'), 'zzz.zip')).toBeUndefined();
  });
});

describe('resolveWebFunctionArtifact', () => {
  let outdir: string;
  let stack: StackInfo;

  const writeManifest = (files: AssetManifest['files']): void => {
    writeFileSync(
      join(outdir, 'App.assets.json'),
      JSON.stringify({ version: '52.0.0', files, dockerImages: {} })
    );
  };

  beforeEach(() => {
    outdir = mkdtempSync(join(tmpdir(), 'webfn-artifact-'));
    stack = {
      stackName: 'App',
      displayName: 'App',
      artifactId: 'App',
      template: { Resources: {} },
      assetManifestPath: join(outdir, 'App.assets.json'),
      assetOutdir: outdir,
      dependencyNames: [],
    } as StackInfo;
  });
  afterEach(() => rmSync(outdir, { recursive: true, force: true }));

  it('resolves a directory asset to its staged directory', async () => {
    mkdirSync(join(outdir, 'asset.abc123'));
    writeFileSync(join(outdir, 'asset.abc123', 'index.js'), '// server');
    writeManifest({
      abc123: {
        displayName: 'Code',
        source: { path: 'asset.abc123', packaging: 'zip' },
        destinations: { d: { bucketName: 'b', objectKey: 'abc123.zip' } },
      },
    });
    const art = await resolveWebFunctionArtifact(
      stack,
      'Rev',
      parseWebFunctionBuildConfig('Rev', buildConfig('abc123.zip'))
    );
    expect(art).toEqual({
      kind: 'zip',
      runtime: 'nodejs24.x',
      codeDir: join(outdir, 'asset.abc123'),
      assetHash: 'abc123',
    });
  });

  it('extracts a .zip file asset into a temp dir the caller removes', async () => {
    writeFileSync(
      join(outdir, 'asset.def456.zip'),
      zipSync({ 'index.js': strToU8('// zipped server') })
    );
    writeManifest({
      def456: {
        displayName: 'Code',
        source: { path: 'asset.def456.zip', packaging: 'file' },
        destinations: { d: { bucketName: 'b', objectKey: 'def456.zip' } },
      },
    });
    const art = await resolveWebFunctionArtifact(
      stack,
      'Rev',
      parseWebFunctionBuildConfig('Rev', buildConfig('def456.zip'))
    );
    expect(art.kind).toBe('zip');
    if (art.kind !== 'zip') return;
    expect(art.tmpDir).toBeDefined();
    expect(readFileSync(join(art.codeDir, 'index.js'), 'utf8')).toBe('// zipped server');
    rmSync(art.tmpDir!, { recursive: true, force: true });
  });

  it('fails naming bucket and key when no local asset matches', async () => {
    writeManifest({});
    await expect(
      resolveWebFunctionArtifact(
        stack,
        'Rev',
        parseWebFunctionBuildConfig('Rev', {
          CodeConfig: { S3Object: { Bucket: 'my-deploy-bucket', Key: 'code/web.zip' } },
          RuntimeConfig: { Runtime: 'nodejs24.x' },
        })
      )
    ).rejects.toThrow(
      /bucket my-deploy-bucket, key code\/web\.zip\) matches no file asset.*runs code that comes from a CDK asset in this app/
    );
  });

  it('fails the same way for a stack with no asset manifest', async () => {
    const bare = { ...stack, assetManifestPath: undefined } as StackInfo;
    await expect(
      resolveWebFunctionArtifact(
        bare,
        'Rev',
        parseWebFunctionBuildConfig('Rev', buildConfig('abc123.zip'))
      )
    ).rejects.toThrow(/matches no file asset in this app's cdk\.out/);
  });

  it('explains a source.executable asset, which has no staged bundle', async () => {
    writeManifest({
      abc123: {
        displayName: 'Code',
        source: { executable: ['./build.sh'] } as never,
        destinations: { d: { bucketName: 'b', objectKey: 'abc123.zip' } },
      },
    });
    await expect(
      resolveWebFunctionArtifact(
        stack,
        'Rev',
        parseWebFunctionBuildConfig('Rev', buildConfig('abc123.zip'))
      )
    ).rejects.toThrow(/has no source\.path \(it is produced by source\.executable.*asset of a directory or a \.zip/);
  });

  it('refuses an asset source that climbs out of the assembly', async () => {
    writeManifest({
      abc123: {
        displayName: 'Code',
        source: { path: '../../etc', packaging: 'zip' },
        destinations: { d: { bucketName: 'b', objectKey: 'abc123.zip' } },
      },
    });
    await expect(
      resolveWebFunctionArtifact(
        stack,
        'Rev',
        parseWebFunctionBuildConfig('Rev', buildConfig('abc123.zip'))
      )
    ).rejects.toThrow(/Refusing to mount it/);
  });
});
