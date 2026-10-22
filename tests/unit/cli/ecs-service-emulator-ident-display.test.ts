import { describe, expect, it, vi } from 'vite-plus/test';

// go-to-k/cdk-local#761 (S3): the reload classifier's asset-context debug lines
// render the target, stack name and asset hash bare when plain and as ONE JSON
// string literal when they could forge a boundary. Expected strings are
// hand-written, never computed through the display helper.

const h = vi.hoisted(() => ({ mode: 'no-containers' as 'no-containers' | 'hash', hash: 'h1' }));

vi.mock('../../../src/local/ecs-service-resolver.js', async (importActual) => ({
  ...(await importActual<object>()),
  resolveEcsServiceTarget: () => ({
    stack: { stackName: 'x' },
    serviceLogicalId: 'Svc',
    task: {
      taskDefinitionLogicalId: 'TD',
      containers:
        h.mode === 'no-containers'
          ? []
          : [{ name: 'web', essential: true, image: { kind: 'cdk-asset', assetHash: h.hash } }],
      warnings: [],
    },
    warnings: [],
  }),
}));

const { loadAssetContextForTarget } = await import(
  '../../../src/cli/commands/ecs-service-emulator.js'
);

function run(stackName: string, target: string): Promise<string[]> {
  const lines: string[] = [];
  const logger = { debug: (m: string) => lines.push(m) } as never;
  const stack = { stackName, region: 'us-east-1', template: { Resources: {} } } as never;
  const assetLoader = {
    loadStackManifest: async () => ({ dockerImages: {} }),
  } as never;
  return loadAssetContextForTarget({
    target,
    controller: {} as never,
    stacks: [stack],
    cdkOutDir: '/cdk.out',
    assetLoader,
    logger,
  }).then(() => lines);
}

describe('ecs-service-emulator loadAssetContext renders identifiers (#761)', () => {
  it('no containers: plain target bare, forging target as a JSON literal', async () => {
    h.mode = 'no-containers';
    expect(await run('S', 'S:Svc')).toEqual([
      'loadAssetContext: task definition for target S:Svc has no containers. Classifier will see no asset context (rebuild).',
    ]);
    expect(await run("S' x", "S' x:Svc")).toEqual([
      `loadAssetContext: task definition for target "S' x:Svc" has no containers. Classifier will see no asset context (rebuild).`,
    ]);
  });

  it('hash missing from dockerImages: plain bare, forging as JSON literals', async () => {
    h.mode = 'hash';
    h.hash = 'abc123';
    expect(await run('S', 'S:Svc')).toEqual([
      'loadAssetContext: asset hash abc123 not present in stack S dockerImages. Classifier will see no asset context (rebuild).',
    ]);
    h.hash = "ab' c\nd";
    expect(await run('S\u001b[2Kx', 'S\u001b[2Kx:Svc')).toEqual([
      `loadAssetContext: asset hash "ab' c d" not present in stack "S [2Kx" dockerImages. Classifier will see no asset context (rebuild).`,
    ]);
  });
});
