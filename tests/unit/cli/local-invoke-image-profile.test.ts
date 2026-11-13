import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { pullMock, parseMock, rieWrapMock } = vi.hoisted(() => ({
  pullMock: vi.fn(),
  parseMock: vi.fn(),
  rieWrapMock: vi.fn(),
}));

vi.mock('../../../src/local/ecr-puller.js', () => ({
  pullEcrImage: pullMock,
  parseEcrUri: parseMock,
}));
// The plan would otherwise run the real docker CLI to mount an RIE (#867).
vi.mock('../../../src/local/rie-mount.js', () => ({ resolveRieWrap: rieWrapMock }));

const { resolveContainerImagePlan } = await import('../../../src/cli/commands/local-invoke.js');

// Container Lambda with no local asset (assetManifestPath undefined) so
// resolution falls through to the ECR-pull path (the branch forwarding
// `--profile`). `imageConfig: {}` + no `ephemeralStorageMb` keep the
// post-pull plan construction clean.
function ecrLambda() {
  return {
    logicalId: 'ImgFn',
    kind: 'image',
    architecture: 'x86_64',
    imageUri: '111122223333.dkr.ecr.ap-northeast-1.amazonaws.com/repo:latest',
    imageConfig: {},
    stack: { stackName: 'S', assetManifestPath: undefined },
    resource: { Type: 'AWS::Lambda::Function', Metadata: { 'aws:cdk:path': 'S/ImgFn/Resource' } },
  } as unknown as Parameters<typeof resolveContainerImagePlan>[0];
}

describe('resolveContainerImagePlan — ECR-pull --profile forwarding', () => {
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
    rieWrapMock.mockReset();
    rieWrapMock.mockResolvedValue(undefined);
  });

  it('forwards --profile to pullEcrImage on the ECR-pull fallback', async () => {
    const lambda = ecrLambda();
    await resolveContainerImagePlan(lambda, {
      profile: 'mates_dev',
      pull: true,
    } as unknown as Parameters<typeof resolveContainerImagePlan>[1]);

    expect(pullMock).toHaveBeenCalledWith(lambda.imageUri, {
      skipPull: false,
      profile: 'mates_dev',
      workload: { logicalId: 'ImgFn', cdkPath: 'S/ImgFn/Resource' },
    });
  });

  it('omits the profile key when --profile is unset', async () => {
    const lambda = ecrLambda();
    await resolveContainerImagePlan(lambda, {
      pull: true,
    } as unknown as Parameters<typeof resolveContainerImagePlan>[1]);

    expect(pullMock).toHaveBeenCalledWith(lambda.imageUri, {
      skipPull: false,
      workload: { logicalId: 'ImgFn', cdkPath: 'S/ImgFn/Resource' },
    });
  });
});

describe('resolveContainerImagePlan — the mounted Lambda RIE (#867)', () => {
  const RIE = '/var/rapid/aws-lambda-rie';
  const mount = { hostPath: '/cache/lambda-rie/linux-arm64/aws-lambda-rie', containerPath: RIE, readOnly: true as const };
  function lambdaWith(imageConfig: Record<string, unknown>) {
    return { ...ecrLambda(), architecture: 'arm64', imageConfig } as unknown as Parameters<
      typeof resolveContainerImagePlan
    >[0];
  }

  // The pulled ref differs from Code.ImageUri, so the wrap must be handed
  // the image `docker run` starts, not the template's URI.
  const PULLED = 'local/pulled:tag';
  beforeEach(() => {
    parseMock.mockReturnValue({ accountId: '111122223333', region: 'ap-northeast-1' });
    pullMock.mockResolvedValue(PULLED);
    rieWrapMock.mockReset();
  });

  it('runs the image under the wrap: RIE entrypoint, the effective program as CMD, the mount', async () => {
    rieWrapMock.mockResolvedValue({ mount, entryPoint: [RIE], cmd: ['/custom', '-x', 'handler'] });
    const lambda = lambdaWith({
      command: ['handler'],
      entryPoint: ['/custom', '-x'],
      workingDirectory: '/w',
    });
    const plan = await resolveContainerImagePlan(lambda, {
      pull: false,
    } as unknown as Parameters<typeof resolveContainerImagePlan>[1]);

    expect(rieWrapMock).toHaveBeenCalledWith({
      image: PULLED,
      platform: 'linux/arm64',
      entryPoint: ['/custom', '-x'],
      command: ['handler'],
      skipPull: true,
    });
    expect(plan.entryPoint).toEqual([RIE]);
    expect(plan.cmd).toEqual(['/custom', '-x', 'handler']);
    expect(plan.extraMounts).toEqual([mount]);
    expect(plan.workingDir).toBe('/w');
  });

  it('keeps the ImageConfig shape when no wrap resolves', async () => {
    rieWrapMock.mockResolvedValue(undefined);
    const plan = await resolveContainerImagePlan(
      lambdaWith({ command: ['handler'], entryPoint: ['/custom', '-x'] }),
      { pull: true } as unknown as Parameters<typeof resolveContainerImagePlan>[1]
    );
    expect(rieWrapMock.mock.calls[0]![0]).toMatchObject({ skipPull: false });
    expect(plan.entryPoint).toEqual(['/custom', '-x']);
    expect(plan.cmd).toEqual(['handler']);
    expect(plan.extraMounts).toEqual([]);
  });
});
