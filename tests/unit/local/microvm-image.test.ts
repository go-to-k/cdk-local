import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import {
  disposeMicrovmCodeArtifact,
  readMicrovmImageConfig,
  resolveMicrovmCodeArtifact,
  resolveMicrovmImageTarget,
  s3KeyOfUri,
} from '../../../src/local/microvm-image.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { AssetManifest } from '../../../src/types/assets.js';

const URI = {
  'Fn::Sub': 's3://cdk-hnb659fds-assets-${AWS::AccountId}-${AWS::Region}/abc123.zip',
};

const image = (props: Record<string, unknown> = {}) => ({
  Type: 'AWS::Lambda::MicrovmImage',
  Properties: { Name: 'my-image', CodeArtifact: { Uri: URI }, ...props },
});

const stackOf = (name: string, resources: Record<string, unknown>, extra: Partial<StackInfo> = {}) =>
  ({
    stackName: name,
    displayName: name,
    artifactId: name,
    template: { Resources: resources },
    dependencyNames: [],
    ...extra,
  }) as unknown as StackInfo;

describe('s3KeyOfUri', () => {
  it('reads the key of a literal, an Fn::Sub and an Fn::Join URI with an intrinsic bucket', () => {
    expect(s3KeyOfUri('s3://bucket/dir/k.zip')).toBe('dir/k.zip');
    expect(s3KeyOfUri(URI)).toBe('abc123.zip');
    expect(
      s3KeyOfUri({ 'Fn::Join': ['', ['s3://', { Ref: 'Bucket' }, '/', 'abc123.zip']] })
    ).toBe('abc123.zip');
    expect(
      s3KeyOfUri({ 'Fn::Sub': ['s3://${B}/abc.zip', { B: { Ref: 'Bucket' } }] })
    ).toBe('abc.zip');
  });

  it('refuses a key that is not literal, and a URI that is not s3://', () => {
    expect(s3KeyOfUri({ 'Fn::Join': ['', ['s3://b/', { Ref: 'Key' }]] })).toBeUndefined();
    expect(s3KeyOfUri({ 'Fn::Sub': 's3://b/${Key}' })).toBeUndefined();
    expect(s3KeyOfUri({ 'Fn::ImportValue': 'X' })).toBeUndefined();
    expect(s3KeyOfUri('https://b.s3.amazonaws.com/k.zip')).toBeUndefined();
    expect(s3KeyOfUri(undefined)).toBeUndefined();
  });
});

describe('readMicrovmImageConfig', () => {
  it('reads name, key, architecture, env list and every ENABLED hook with its timeout', () => {
    const config = readMicrovmImageConfig(
      'Img',
      image({
        CpuConfigurations: [{ Architecture: 'ARM_64' }],
        EnvironmentVariables: [
          { Key: 'A', Value: '1' },
          { Key: 'B', Value: { Ref: 'P' } },
        ],
        Hooks: {
          Port: 9001,
          MicrovmImageHooks: { Ready: 'ENABLED', ReadyTimeoutInSeconds: 5, Validate: 'DISABLED' },
          MicrovmHooks: { Run: 'ENABLED', Terminate: 'ENABLED', TerminateTimeoutInSeconds: 2 },
        },
      })
    );
    expect(config).toMatchObject({
      logicalId: 'Img',
      name: 'my-image',
      codeKey: 'abc123.zip',
      architecture: 'arm64',
      environment: { A: '1', B: { Ref: 'P' } },
      hooksPort: 9001,
      hooks: {
        ready: { timeoutSeconds: 5 },
        run: { timeoutSeconds: undefined },
        terminate: { timeoutSeconds: 2 },
      },
      unemulated: [],
    });
    expect(config.hooks.validate).toBeUndefined();
  });

  it('maps X86_64 to x86_64 and leaves an absent architecture undefined', () => {
    expect(
      readMicrovmImageConfig('I', image({ CpuConfigurations: [{ Architecture: 'X86_64' }] }))
        .architecture
    ).toBe('x86_64');
    expect(readMicrovmImageConfig('I', image()).architecture).toBeUndefined();
  });

  it('fails on an enabled hook without a literal Hooks.Port', () => {
    expect(() =>
      readMicrovmImageConfig('I', image({ Hooks: { MicrovmHooks: { Run: 'ENABLED' } } }))
    ).toThrow(/enables lifecycle hooks \(run\) but has no literal Hooks\.Port/);
  });

  it('fails on a hook value other than ENABLED / DISABLED', () => {
    expect(() =>
      readMicrovmImageConfig(
        'I',
        image({ Hooks: { Port: 1, MicrovmHooks: { Run: '/custom/run' } } })
      )
    ).toThrow(/Hooks\.MicrovmHooks\.Run \/custom\/run; only the literal ENABLED or DISABLED/);
  });

  it('fails on a CodeArtifact.Uri whose key is not literal', () => {
    expect(() =>
      readMicrovmImageConfig('I', image({ CodeArtifact: { Uri: { 'Fn::ImportValue': 'U' } } }))
    ).toThrow(/CodeArtifact\.Uri whose object key is not a literal/);
  });

  it('lists the properties it does not emulate, ignoring empty lists', () => {
    const config = readMicrovmImageConfig(
      'I',
      image({
        EgressNetworkConnectors: ['arn:c'],
        AdditionalOsCapabilities: ['ALL'],
        Resources: [{ MinimumMemoryInMiB: 4096 }],
        Logging: { Disabled: true },
        EnvironmentVariables: { 'Fn::If': ['C', [], []] },
      })
    );
    expect(config.unemulated.join('\n')).toMatch(/EgressNetworkConnectors/);
    expect(config.unemulated.join('\n')).toMatch(/AdditionalOsCapabilities/);
    expect(config.unemulated.join('\n')).toMatch(/Resources sizing/);
    expect(config.unemulated.join('\n')).toMatch(/Logging/);
    expect(config.unemulated.join('\n')).toMatch(/EnvironmentVariables is an intrinsic/);
    expect(
      readMicrovmImageConfig('I', image({ EgressNetworkConnectors: [], Resources: [] })).unemulated
    ).toEqual([]);
  });
});

describe('resolveMicrovmImageTarget', () => {
  const single = [
    stackOf('App', {
      Img: { ...image(), Metadata: { 'aws:cdk:path': 'App/Img/Resource' } },
      Role: { Type: 'AWS::IAM::Role', Properties: {} },
    }),
  ];

  it('resolves a bare logical id, a qualified id and a construct path', () => {
    expect(resolveMicrovmImageTarget('Img', single).logicalId).toBe('Img');
    expect(resolveMicrovmImageTarget('App:Img', single).logicalId).toBe('Img');
    expect(resolveMicrovmImageTarget('App/Img', single).logicalId).toBe('Img');
  });

  it('refuses a resource of another type, naming the type', () => {
    expect(() => resolveMicrovmImageTarget('Role', single)).toThrow(
      /is AWS::IAM::Role, not a MicroVM image/
    );
  });

  it('lists the images when the target is not found', () => {
    expect(() => resolveMicrovmImageTarget('Nope', single)).toThrow(/MicroVM images in App: Img/);
  });

  it('requires a stack prefix in a multi-stack app', () => {
    const multi = [...single, stackOf('Other', { Img2: image() })];
    expect(() => resolveMicrovmImageTarget('Img', multi)).toThrow(/missing a stack prefix/);
    expect(resolveMicrovmImageTarget('Other:Img2', multi).stack.stackName).toBe('Other');
  });
});

describe('resolveMicrovmCodeArtifact', () => {
  let outdir: string;
  let stack: StackInfo;
  const writeManifest = (files: AssetManifest['files']): void => {
    writeFileSync(
      join(outdir, 'App.assets.json'),
      JSON.stringify({ version: '52.0.0', files, dockerImages: {} })
    );
  };
  const config = () => readMicrovmImageConfig('Img', image());

  beforeEach(() => {
    outdir = mkdtempSync(join(tmpdir(), 'microvm-artifact-'));
    stack = stackOf('App', {}, {
      assetManifestPath: join(outdir, 'App.assets.json'),
      assetOutdir: outdir,
    });
  });
  afterEach(() => rmSync(outdir, { recursive: true, force: true }));

  it('resolves a directory asset holding a Dockerfile to its staged directory', async () => {
    mkdirSync(join(outdir, 'asset.abc123'));
    writeFileSync(join(outdir, 'asset.abc123', 'Dockerfile'), 'FROM scratch');
    writeManifest({
      abc123: {
        source: { path: 'asset.abc123', packaging: 'zip' },
        destinations: { d: { bucketName: 'b', objectKey: 'abc123.zip' } },
      },
    } as never);
    expect(await resolveMicrovmCodeArtifact(stack, config())).toEqual({
      contextDir: join(outdir, 'asset.abc123'),
      assetHash: 'abc123',
    });
  });

  it('extracts a .zip asset, and dispose removes the extracted copy', async () => {
    writeFileSync(
      join(outdir, 'asset.abc123.zip'),
      zipSync({ Dockerfile: strToU8('FROM scratch'), 'app.js': strToU8('//') })
    );
    writeManifest({
      abc123: {
        source: { path: 'asset.abc123.zip', packaging: 'file' },
        destinations: { d: { bucketName: 'b', objectKey: 'abc123.zip' } },
      },
    } as never);
    const art = await resolveMicrovmCodeArtifact(stack, config());
    expect(art.tmpDir).toBeDefined();
    expect(readFileSync(join(art.contextDir, 'Dockerfile'), 'utf8')).toBe('FROM scratch');
    disposeMicrovmCodeArtifact(art);
    expect(existsSync(art.tmpDir!)).toBe(false);
  });

  it('fails when the bundle has no root Dockerfile, removing what it extracted', async () => {
    writeFileSync(join(outdir, 'asset.abc123.zip'), zipSync({ 'app.js': strToU8('//') }));
    writeManifest({
      abc123: {
        source: { path: 'asset.abc123.zip', packaging: 'file' },
        destinations: { d: { bucketName: 'b', objectKey: 'abc123.zip' } },
      },
    } as never);
    await expect(resolveMicrovmCodeArtifact(stack, config())).rejects.toThrow(
      /has no Dockerfile at its root/
    );
  });

  it('fails naming the key when no local asset matches (no download)', async () => {
    writeManifest({});
    await expect(resolveMicrovmCodeArtifact(stack, config())).rejects.toThrow(
      /key abc123\.zip\) matches no file asset in this app's cdk\.out.*does not download deployed code/
    );
  });

  it('refuses a source.path that escapes the assembly', async () => {
    writeManifest({
      abc123: {
        source: { path: '../../etc', packaging: 'zip' },
        destinations: { d: { bucketName: 'b', objectKey: 'abc123.zip' } },
      },
    } as never);
    await expect(resolveMicrovmCodeArtifact(stack, config())).rejects.toMatchObject({
      code: 'LOCAL_START_MICROVM_CODE_SOURCE_ESCAPES_ASSEMBLY',
    });
  });
});
