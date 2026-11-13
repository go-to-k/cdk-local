import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

const { pullMock, parseMock, rieWrapMock } = vi.hoisted(() => ({
  pullMock: vi.fn(),
  parseMock: vi.fn(),
  rieWrapMock: vi.fn(),
}));

vi.mock('../../../src/local/ecr-puller.js', () => ({
  pullEcrImage: pullMock,
  parseEcrUri: parseMock,
}));
vi.mock('../../../src/local/rie-mount.js', () => ({ resolveRieWrap: rieWrapMock }));

const { resolveContainerImageForStartApi, buildContainerSpec } = await import(
  '../../../src/cli/commands/local-start-api.js'
);

// A container Lambda with no local asset (assetManifestPath undefined) so
// `resolveLocalBuildPlan` returns undefined and resolution falls through to
// the ECR-pull path — the branch that must forward `--profile`.
function ecrLambda() {
  return {
    logicalId: 'ImgFn',
    imageUri: '111122223333.dkr.ecr.ap-northeast-1.amazonaws.com/repo:latest',
    architecture: 'x86_64',
    stack: { stackName: 'S', assetManifestPath: undefined },
    resource: { Type: 'AWS::Lambda::Function', Metadata: { 'aws:cdk:path': 'S/ImgFn/Resource' } },
  } as unknown as Parameters<typeof resolveContainerImageForStartApi>[0];
}

describe('resolveContainerImageForStartApi — ECR-pull --profile forwarding', () => {
  beforeEach(() => {
    pullMock.mockReset();
    parseMock.mockReset();
    parseMock.mockReturnValue({
      registry: '111122223333.dkr.ecr.ap-northeast-1.amazonaws.com',
      accountId: '111122223333',
      region: 'ap-northeast-1',
      repository: 'repo',
      tag: 'latest',
    });
    pullMock.mockImplementation((uri: string) => Promise.resolve(uri));
  });

  it('forwards --profile to pullEcrImage on the ECR-pull fallback', async () => {
    const lambda = ecrLambda();
    await resolveContainerImageForStartApi(lambda, false, 'mates_dev');
    expect(pullMock).toHaveBeenCalledWith(lambda.imageUri, {
      skipPull: false,
      profile: 'mates_dev',
      workload: { logicalId: 'ImgFn', cdkPath: 'S/ImgFn/Resource' },
    });
  });

  it('omits the profile key when --profile is unset', async () => {
    const lambda = ecrLambda();
    await resolveContainerImageForStartApi(lambda, true);
    expect(pullMock).toHaveBeenCalledWith(lambda.imageUri, {
      skipPull: true,
      workload: { logicalId: 'ImgFn', cdkPath: 'S/ImgFn/Resource' },
    });
  });
});

describe('buildContainerSpec IMAGE branch runs the image under a mounted RIE (#867)', () => {
  const ecrUri = '111111111111.dkr.ecr.us-east-1.amazonaws.com/repo:abcdef';
  const RIE = '/var/rapid/aws-lambda-rie';
  const stack = {
    stackName: 'ApiStack',
    region: 'us-east-1',
    template: {
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            PackageType: 'Image',
            Code: { ImageUri: ecrUri },
            ImageConfig: { Command: ['h'], EntryPoint: ['/custom', '-x'], WorkingDirectory: '/w' },
          },
        },
      },
    },
  } as unknown as StackInfo;
  const build = () =>
    buildContainerSpec({
      logicalId: 'Fn',
      stacks: [stack],
      overrides: undefined,
      assumeRole: undefined,
      containerHost: '127.0.0.1',
      stsRegion: undefined,
      inlineTmpDirs: new Set(),
      layerTmpDirs: new Set(),
      stateByStack: new Map(),
      skipPull: true,
    });

  beforeEach(() => {
    parseMock.mockReset().mockReturnValue({ accountId: '111111111111', region: 'us-east-1' });
    pullMock.mockReset().mockResolvedValue('local/pulled:tag');
    rieWrapMock.mockReset();
  });

  it('carries the wrap onto the spec and passes the ImageConfig + --no-pull through', async () => {
    const mount = { hostPath: '/cache/aws-lambda-rie', containerPath: RIE, readOnly: true as const };
    rieWrapMock.mockResolvedValue({ mount, entryPoint: [RIE], cmd: ['/custom', '-x', 'h'] });
    const spec = await build();
    expect(rieWrapMock).toHaveBeenCalledWith({
      image: 'local/pulled:tag',
      platform: 'linux/amd64',
      entryPoint: ['/custom', '-x'],
      command: ['h'],
      skipPull: true,
    });
    expect(spec).toMatchObject({
      kind: 'image',
      rieMount: mount,
      entryPoint: [RIE],
      command: ['/custom', '-x', 'h'],
      workingDir: '/w',
    });
  });

  it('keeps the ImageConfig shape when no wrap resolves', async () => {
    rieWrapMock.mockResolvedValue(undefined);
    const spec = await build();
    expect(spec).toMatchObject({ kind: 'image', command: ['h'], entryPoint: ['/custom', '-x'] });
    expect(spec).not.toHaveProperty('rieMount');
  });
});
