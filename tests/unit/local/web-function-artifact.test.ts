import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import {
  parseWebFunctionBuildConfig,
  resolveWebFunctionArtifact,
} from '../../../src/local/web-function-artifact.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { AssetManifest } from '../../../src/types/assets.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

const BOOTSTRAP_BUCKET = { 'Fn::Sub': 'cdk-hnb659fds-assets-${AWS::AccountId}-${AWS::Region}' };

/** `Fn.select(index, upload.objectKeys)` as CDK synthesizes it. */
const selectObjectKey = (index: unknown, deployment = 'Upload'): unknown => ({
  'Fn::Select': [index, { 'Fn::GetAtt': [deployment, 'SourceObjectKeys'] }],
});

/** A stack with one BucketDeployment `Upload` of the given sources. */
const deploymentTemplate = (
  sourceObjectKeys: unknown[],
  extra: Record<string, unknown> = {}
): CloudFormationTemplate => ({
  Resources: {
    Upload: {
      Type: 'Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C',
      Properties: {
        ServiceToken: { 'Fn::GetAtt': ['Handler', 'Arn'] },
        SourceBucketNames: sourceObjectKeys.map(() => BOOTSTRAP_BUCKET),
        SourceObjectKeys: sourceObjectKeys,
        DestinationBucketName: { Ref: 'Bucket' },
        Prune: false,
        OutputObjectKeys: true,
        ...extra,
      },
    },
  },
});

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

  it('names the BucketDeployment extract: false shape as supported in that error', () => {
    expect(() =>
      parseWebFunctionBuildConfig(
        'Rev',
        buildConfig({ 'Fn::ImportValue': 'KeyExport' }),
        deploymentTemplate(['abc123.zip'], { Extract: false })
      )
    ).toThrow(/BucketDeployment with extract: false passing Fn\.select\(<i>, deployment\.objectKeys\)/);
  });

  it("resolves Fn.select(i, deployment.objectKeys) of an extract: false deployment to its i-th source", () => {
    const template = deploymentTemplate(['first111.zip', 'second22.zip'], { Extract: false });
    const parsed = parseWebFunctionBuildConfig('Rev', buildConfig(selectObjectKey(1)), template);
    expect(parsed.s3Object.key).toBe('second22.zip');
    expect(parsed.s3Object.deployment).toEqual({ logicalId: 'Upload', index: 1 });
    expect(parsed.s3Object.bucket).toEqual(BOOTSTRAP_BUCKET);
  });

  it('fails the same selection without the template, as a non-literal key, without offering it', () => {
    let message = '';
    try {
      parseWebFunctionBuildConfig('Rev', buildConfig(selectObjectKey(0)));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/not a literal string.*whose key synthesizes as a literal\.$/);
    expect(message).not.toMatch(/BucketDeployment/);
  });

  it.each([
    ['absent (the default)', {}],
    ['true', { Extract: true }],
    ["'true'", { Extract: 'true' }],
  ])('refuses a deployment whose Extract is %s, which unpacks the zip', (_label, extra) => {
    expect(() =>
      parseWebFunctionBuildConfig(
        'Rev',
        buildConfig(selectObjectKey(0)),
        deploymentTemplate(['abc123.zip'], extra)
      )
    ).toThrow(
      expect.objectContaining({
        code: 'LOCAL_START_WEB_FUNCTION_CODE_KEY_DEPLOYMENT_EXTRACTS',
        message: expect.stringMatching(
          /selects source 0 of BucketDeployment Upload, which does not set extract to a literal false.*Set extract: false/
        ),
      })
    );
  });

  it.each([
    ['an index past the sources', selectObjectKey(2), ['a.zip'], {}, /has only 1 source\(s\)/],
    [
      'a source that is not a literal asset key',
      selectObjectKey(0),
      [{ 'Fn::GetAtt': ['Other', 'Key'] }],
      {},
      /SourceObjectKeys entry is not a literal string/,
    ],
    [
      'a destinationKeyPrefix',
      selectObjectKey(0),
      ['a.zip'],
      { DestinationBucketKeyPrefix: 'site/' },
      /sets a destinationKeyPrefix.*Remove destinationKeyPrefix/,
    ],
    [
      'outputObjectKeys: false',
      selectObjectKey(0),
      ['a.zip'],
      { OutputObjectKeys: false },
      /sets outputObjectKeys: false/,
    ],
  ])('refuses %s', (_label, key, sources, extra, message) => {
    expect(() =>
      parseWebFunctionBuildConfig(
        'Rev',
        buildConfig(key),
        deploymentTemplate(sources, { Extract: false, ...extra })
      )
    ).toThrow(
      expect.objectContaining({
        code: 'LOCAL_START_WEB_FUNCTION_CODE_KEY_DEPLOYMENT_SOURCE_UNRESOLVED',
        message: expect.stringMatching(message),
      })
    );
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

  it('fails when the asset source is missing from cdk.out', async () => {
    writeManifest({
      abc123: {
        displayName: 'Code',
        source: { path: 'asset.abc123', packaging: 'zip' },
        destinations: { d: { bucketName: 'b', objectKey: 'abc123.zip' } },
      },
    });
    await expect(
      resolveWebFunctionArtifact(stack, 'Rev', parseWebFunctionBuildConfig('Rev', buildConfig('abc123.zip')))
    ).rejects.toThrow(/source .*asset\.abc123 does not exist\. Re-synthesize/);
  });

  it('fails when the asset source is a plain file, not a bundle', async () => {
    writeFileSync(join(outdir, 'asset.abc123.txt'), 'x');
    writeManifest({
      abc123: {
        displayName: 'Code',
        source: { path: 'asset.abc123.txt', packaging: 'file' },
        destinations: { d: { bucketName: 'b', objectKey: 'abc123.zip' } },
      },
    });
    await expect(
      resolveWebFunctionArtifact(stack, 'Rev', parseWebFunctionBuildConfig('Rev', buildConfig('abc123.zip')))
    ).rejects.toThrow(/is neither a directory nor a \.zip archive/);
  });

  it('resolves a BucketDeployment (extract: false) source to that asset\'s staged directory', async () => {
    mkdirSync(join(outdir, 'asset.abc123'));
    writeFileSync(join(outdir, 'asset.abc123', 'index.js'), '// deployed server');
    writeManifest({
      abc123: {
        displayName: 'Upload/Asset1',
        source: { path: 'asset.abc123', packaging: 'zip' },
        destinations: { d: { bucketName: 'b', objectKey: 'abc123.zip' } },
      },
    });
    const template = deploymentTemplate(['abc123.zip'], { Extract: false });
    const art = await resolveWebFunctionArtifact(
      { ...stack, template },
      'Rev',
      parseWebFunctionBuildConfig('Rev', buildConfig(selectObjectKey(0)), template)
    );
    expect(art).toEqual({
      kind: 'zip',
      runtime: 'nodejs24.x',
      codeDir: join(outdir, 'asset.abc123'),
      assetHash: 'abc123',
    });
  });

  it('names the deployment source when its key matches no asset', async () => {
    writeManifest({});
    const template = deploymentTemplate(['zzz999.zip'], { Extract: false });
    await expect(
      resolveWebFunctionArtifact(
        { ...stack, template },
        'Rev',
        parseWebFunctionBuildConfig('Rev', buildConfig(selectObjectKey(0)), template)
      )
    ).rejects.toThrow(/key zzz999\.zip \(source 0 of BucketDeployment Upload\)\) matches no file asset/);
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
