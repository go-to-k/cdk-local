/**
 * go-to-k/cdk-local#745 — every container-build CALLER hands the stack's app
 * outdir to the build as its containment bound.
 *
 * `buildDockerImage` defaults an absent bound to the manifest directory, which
 * NARROWS: correct for a top-level stack, and it refuses a cdk.Stage image
 * whose context CDK stages one level above the Stage's manifest
 * (`../asset.<hash>`). A caller that drops the bound therefore breaks every
 * Stage image while every top-level test stays green, because there the two
 * directories coincide. So each case here uses the Stage layout, where they
 * differ, and asserts the bound that reached the builder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

const { buildContainerImageMock, buildDockerImageMock } = vi.hoisted(() => ({
  buildContainerImageMock: vi.fn(),
  buildDockerImageMock: vi.fn(),
}));

vi.mock('../../../src/local/docker-image-builder.js', async (importActual) => ({
  ...(await importActual<object>()),
  buildContainerImage: buildContainerImageMock,
}));
vi.mock('../../../src/assets/docker-build.js', async (importActual) => ({
  ...(await importActual<object>()),
  buildDockerImage: buildDockerImageMock,
}));
vi.mock('../../../src/local/docker-runner.js', async (importActual) => ({
  ...(await importActual<object>()),
  runDetached: vi.fn().mockResolvedValue('container-abc'),
  pickFreePort: vi.fn().mockResolvedValue(54321),
  removeContainer: vi.fn().mockResolvedValue(undefined),
  pullImage: vi.fn().mockResolvedValue(undefined),
  streamLogs: vi.fn(() => () => undefined),
}));
vi.mock('../../../src/local/rie-client.js', () => ({
  waitForRieReady: vi.fn().mockResolvedValue(undefined),
  invokeRie: vi.fn(),
}));

const { resolveContainerImagePlan } = await import('../../../src/cli/commands/local-invoke.js');
const { resolveContainerImageForStartApi } = await import(
  '../../../src/cli/commands/local-start-api.js'
);
const { createFrontDoorLambdaRunner } = await import(
  '../../../src/local/front-door-lambda-runner.js'
);
const { prepareImages } = await import('../../../src/local/ecs-task-runner.js');

const HASH = 'abcdef0123456789';
const IMAGE_URI = `123456789012.dkr.ecr.us-east-1.amazonaws.com/cdk-assets:${HASH}`;

let root: string;
let outdir: string;
let stack: StackInfo;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cdkl-745-thread-')));
  outdir = join(root, 'cdk.out');
  const stageDir = join(outdir, 'assembly-S');
  mkdirSync(stageDir, { recursive: true });
  mkdirSync(join(outdir, `asset.${HASH}`));
  const assetManifestPath = join(stageDir, 'App.assets.json');
  writeFileSync(
    assetManifestPath,
    JSON.stringify({
      version: '1',
      files: {},
      dockerImages: {
        [HASH]: { source: { directory: `../asset.${HASH}` }, destinations: {} },
      },
    })
  );
  stack = {
    stackName: 'App',
    displayName: 'S/App',
    artifactId: 'SApp',
    template: { Resources: {} },
    assetManifestPath,
    assetOutdir: outdir,
    dependencyNames: [],
  } as StackInfo;
  buildContainerImageMock.mockReset().mockResolvedValue('cdkl-invoke-tag');
  buildDockerImageMock.mockReset().mockImplementation(async (_a, _d, o: { tag: string }) => o.tag);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function imageLambda(): never {
  return {
    kind: 'image',
    stack,
    logicalId: 'Fn',
    resource: { Type: 'AWS::Lambda::Function', Properties: {} },
    imageUri: IMAGE_URI,
    imageConfig: {},
    architecture: 'x86_64',
    memoryMb: 128,
    timeoutSec: 10,
    layers: [],
  } as never;
}

function lastBound(): unknown {
  const call = buildContainerImageMock.mock.calls.at(-1)!;
  return { dir: call[1], assetOutdir: (call[2] as { assetOutdir?: string }).assetOutdir };
}

describe('container-build callers pass the app outdir as the bound (#745)', () => {
  it('cdkl invoke (resolveContainerImagePlan)', async () => {
    await resolveContainerImagePlan(imageLambda(), {} as never);
    expect(lastBound()).toEqual({ dir: join(outdir, 'assembly-S'), assetOutdir: outdir });
  });

  it('cdkl start-api (resolveContainerImageForStartApi)', async () => {
    await resolveContainerImageForStartApi(imageLambda(), true);
    expect(lastBound()).toEqual({ dir: join(outdir, 'assembly-S'), assetOutdir: outdir });
  });

  it('the ALB / CloudFront front-door Lambda runner', async () => {
    const runner = createFrontDoorLambdaRunner(imageLambda(), { containerHost: '127.0.0.1' });
    await runner.start();
    expect(lastBound()).toEqual({ dir: join(outdir, 'assembly-S'), assetOutdir: outdir });
    await runner.stop();
  });

  it('cdkl run-task / start-service / start-alb (ecs-task-runner prepareImages)', async () => {
    const task = {
      stack,
      containers: [
        {
          name: 'web',
          image: { kind: 'cdk-asset', assetHash: HASH },
          essential: true,
        },
      ],
    } as never;
    await prepareImages(task, new Map(), { skipPull: true } as never);
    expect(buildDockerImageMock).toHaveBeenCalledTimes(1);
    const [, dir, opts] = buildDockerImageMock.mock.calls[0]!;
    expect(dir).toBe(join(outdir, 'assembly-S'));
    expect((opts as { assetOutdir?: string }).assetOutdir).toBe(outdir);
  });
});

describe('--watch reader helpers (#745)', () => {
  it('outputAssetBound: the stack assetOutdir when set, else the --output directory ("" counts as unset)', async () => {
    const { outputAssetBound } = await import('../../../src/local/lambda-resolver.js');
    expect(outputAssetBound({ ...stack, assetOutdir: outdir }, '/out')).toBe(outdir);
    expect(outputAssetBound({ ...stack, assetOutdir: undefined }, '/out')).toBe('/out');
    // `''` resolves to the process cwd if used as a bound — a disjoint one
    // that refuses every value; it must take the `--output` fallback.
    expect(outputAssetBound({ ...stack, assetOutdir: '' }, '/out')).toBe('/out');
  });

  it("watchManifestDir: the manifest's own directory, else the --output directory", async () => {
    const { watchManifestDir } = await import('../../../src/local/lambda-resolver.js');
    expect(watchManifestDir(stack, '/out')).toBe(join(outdir, 'assembly-S'));
    expect(watchManifestDir({ ...stack, assetManifestPath: undefined }, '/out')).toBe('/out');
  });
});
