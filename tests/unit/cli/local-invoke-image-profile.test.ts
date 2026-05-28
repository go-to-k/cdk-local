import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { pullMock, parseMock } = vi.hoisted(() => ({
  pullMock: vi.fn(),
  parseMock: vi.fn(),
}));

vi.mock('../../../src/local/ecr-puller.js', () => ({
  pullEcrImage: pullMock,
  parseEcrUri: parseMock,
}));

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
    });
  });

  it('omits the profile key when --profile is unset', async () => {
    const lambda = ecrLambda();
    await resolveContainerImagePlan(lambda, {
      pull: true,
    } as unknown as Parameters<typeof resolveContainerImagePlan>[1]);

    expect(pullMock).toHaveBeenCalledWith(lambda.imageUri, { skipPull: false });
  });
});
