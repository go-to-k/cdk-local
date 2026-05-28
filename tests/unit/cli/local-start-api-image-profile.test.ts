import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { pullMock, parseMock } = vi.hoisted(() => ({
  pullMock: vi.fn(),
  parseMock: vi.fn(),
}));

vi.mock('../../../src/local/ecr-puller.js', () => ({
  pullEcrImage: pullMock,
  parseEcrUri: parseMock,
}));

const { resolveContainerImageForStartApi } = await import(
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
    });
  });

  it('omits the profile key when --profile is unset', async () => {
    const lambda = ecrLambda();
    await resolveContainerImageForStartApi(lambda, true);
    expect(pullMock).toHaveBeenCalledWith(lambda.imageUri, { skipPull: true });
  });
});
