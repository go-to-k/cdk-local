import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { hoisted } = vi.hoisted(() => ({
  hoisted: {
    /** Toggle the `resolveEcsServiceTarget` mock between success / throw / different containers. */
    resolveMode: 'happy' as 'happy' | 'throw' | 'no-containers' | 'non-cdk-asset' | 'no-asset-hash',
    /** Loaded asset manifest. `null` simulates the "manifest missing" branch. */
    manifest: null as Record<string, unknown> | null,
    /** Tracks the manifest loader's hash arg so we can assert it. */
    loadManifestCalls: [] as Array<{ cdkOutDir: string; stackName: string }>,
  },
}));

vi.mock('../../../src/local/ecs-service-resolver.js', async (importActual) => {
  const actual = await importActual<object>();
  return {
    ...actual,
    resolveEcsServiceTarget: () => {
      switch (hoisted.resolveMode) {
        case 'throw':
          throw new Error('synthetic resolveEcsServiceTarget throw');
        case 'no-containers':
          return {
            stack: { stackName: 'AppStack' },
            serviceLogicalId: 'Svc',
            task: {
              taskDefinitionLogicalId: 'TD',
              containers: [],
              warnings: [],
            },
            warnings: [],
          };
        case 'non-cdk-asset':
          return {
            stack: { stackName: 'AppStack' },
            serviceLogicalId: 'Svc',
            task: {
              taskDefinitionLogicalId: 'TD',
              containers: [
                {
                  name: 'web',
                  essential: true,
                  image: { kind: 'ecr', uri: 'public.ecr.aws/foo:bar' },
                },
              ],
              warnings: [],
            },
            warnings: [],
          };
        case 'no-asset-hash':
          return {
            stack: { stackName: 'AppStack' },
            serviceLogicalId: 'Svc',
            task: {
              taskDefinitionLogicalId: 'TD',
              containers: [
                {
                  name: 'web',
                  essential: true,
                  image: { kind: 'cdk-asset' },
                },
              ],
              warnings: [],
            },
            warnings: [],
          };
        default:
          return {
            stack: { stackName: 'AppStack' },
            serviceLogicalId: 'Svc',
            task: {
              taskDefinitionLogicalId: 'TD',
              containers: [
                {
                  name: 'web',
                  essential: true,
                  image: { kind: 'cdk-asset', assetHash: 'newhash' },
                },
              ],
              warnings: [],
            },
            warnings: [],
          };
      }
    },
  };
});

vi.mock('../../../src/assets/asset-manifest-loader.js', async (importActual) => {
  const actual = await importActual<object>();
  return {
    ...actual,
    AssetManifestLoader: class {
      async loadManifest(cdkOutDir: string, stackName: string): Promise<unknown> {
        hoisted.loadManifestCalls.push({ cdkOutDir, stackName });
        return hoisted.manifest;
      }
    },
  };
});

const { loadAssetContextForTarget } = await import(
  '../../../src/cli/commands/ecs-service-emulator.js'
);
const { AssetManifestLoader } = await import('../../../src/assets/asset-manifest-loader.js');
const { getLogger } = await import('../../../src/utils/logger.js');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeStack(): any {
  return {
    stackName: 'AppStack',
    region: 'us-east-1',
    template: { Resources: {} },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeControllerWithOldAssetHash(
  oldHash: string | undefined,
  // Phase 4 follow-up (#218) — `liveStamp` is the
  // `lastDeployedAssetHash` on the first non-shutting-down replica
  // (the new source of truth post-#218). Pass `undefined` to skip
  // the per-replica stamp and force the loader's fall-back to
  // `controller.service.task.containers[essential].image.assetHash`.
  liveStamp: string | 'omit' | undefined = 'omit'
): any {
  const containers = oldHash
    ? [
        {
          name: 'web',
          essential: true,
          image: { kind: 'cdk-asset', assetHash: oldHash },
        },
      ]
    : [
        {
          name: 'web',
          essential: true,
          image: { kind: 'ecr', uri: 'public.ecr.aws/foo:bar' },
        },
      ];
  const replica: Record<string, unknown> = {
    index: 0,
    generation: 0,
    shuttingDown: false,
  };
  if (liveStamp !== 'omit') {
    replica['lastDeployedAssetHash'] = liveStamp;
  }
  return {
    service: {
      stack: { stackName: 'AppStack' },
      serviceLogicalId: 'Svc',
      task: {
        taskDefinitionLogicalId: 'TD',
        containers,
        warnings: [],
      },
      warnings: [],
    },
    runState: { replicas: [replica], shuttingDown: false },
  };
}

/**
 * Phase 4 follow-up (#218 test reviewer M1, M2) — `loadAssetContextForTarget`
 * has six distinct `return undefined` branches + a catch arm on
 * `resolveEcsServiceTarget` throw + a happy path. Each fall-through
 * maps the classifier to `'rebuild'`; the integ fixture covers only
 * the happy path. These rows lock the branch contract at the unit
 * level so a refactor that reorders or drops a guard surfaces here
 * instead of silently shipping a wrong verdict.
 */
describe('loadAssetContextForTarget (Phase 4 follow-up of #214, #218)', () => {
  beforeEach(() => {
    hoisted.resolveMode = 'happy';
    hoisted.manifest = {
      version: '1.0.0',
      files: {},
      dockerImages: {
        newhash: {
          displayName: 'WebTask:web',
          source: { directory: 'asset.newhash' },
          destinations: {},
        },
      },
    };
    hoisted.loadManifestCalls = [];
  });

  function call(
    options: {
      stacks?: unknown[];
      target?: string;
      oldHash?: string | undefined;
      liveStamp?: string | 'omit' | undefined;
    } = {}
  ): Promise<unknown> {
    const stacks = options.stacks ?? [fakeStack()];
    const target = options.target ?? 'AppStack:WebService';
    const oldHash = 'oldHash' in options ? options.oldHash : 'oldhash';
    const liveStamp = 'liveStamp' in options ? options.liveStamp : 'omit';
    return loadAssetContextForTarget({
      target,
      controller: fakeControllerWithOldAssetHash(oldHash, liveStamp),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stacks: stacks as any,
      cdkOutDir: '/tmp/cdk.out',
      assetLoader: new AssetManifestLoader(),
      logger: getLogger().child('test'),
    });
  }

  it('returns undefined when pickCandidateStack finds no match (empty stacks)', async () => {
    const ctx = await call({ stacks: [] });
    expect(ctx).toBeUndefined();
    // Bail-out happened BEFORE the manifest load — loader was not touched.
    expect(hoisted.loadManifestCalls).toEqual([]);
  });

  it('returns undefined when resolveEcsServiceTarget throws (mid-edit construct code)', async () => {
    hoisted.resolveMode = 'throw';
    const ctx = await call();
    expect(ctx).toBeUndefined();
    expect(hoisted.loadManifestCalls).toEqual([]);
  });

  it('returns undefined when the service has no containers', async () => {
    hoisted.resolveMode = 'no-containers';
    const ctx = await call();
    expect(ctx).toBeUndefined();
    expect(hoisted.loadManifestCalls).toEqual([]);
  });

  it('returns undefined when the essential image is not a CDK asset (ECR pin)', async () => {
    hoisted.resolveMode = 'non-cdk-asset';
    const ctx = await call();
    expect(ctx).toBeUndefined();
    expect(hoisted.loadManifestCalls).toEqual([]);
  });

  it('returns undefined when a CDK-asset image has no assetHash', async () => {
    hoisted.resolveMode = 'no-asset-hash';
    const ctx = await call();
    expect(ctx).toBeUndefined();
    expect(hoisted.loadManifestCalls).toEqual([]);
  });

  it('returns undefined when the asset manifest file is missing (loadManifest → null)', async () => {
    hoisted.manifest = null;
    const ctx = await call();
    expect(ctx).toBeUndefined();
    // Loader WAS consulted — confirms we reached the manifest step.
    expect(hoisted.loadManifestCalls.length).toBe(1);
    expect(hoisted.loadManifestCalls[0]?.stackName).toBe('AppStack');
  });

  it('returns undefined when the asset hash is not in manifest.dockerImages', async () => {
    hoisted.manifest = { version: '1.0.0', files: {}, dockerImages: {} };
    const ctx = await call();
    expect(ctx).toBeUndefined();
    expect(hoisted.loadManifestCalls.length).toBe(1);
  });

  it('returns undefined for an executable-mode docker asset (no source.directory)', async () => {
    hoisted.manifest = {
      version: '1.0.0',
      files: {},
      dockerImages: {
        newhash: {
          displayName: 'WebTask:web',
          source: { executable: ['my-builder.sh'] },
          destinations: {},
        },
      },
    };
    const ctx = await call();
    expect(ctx).toBeUndefined();
    expect(hoisted.loadManifestCalls.length).toBe(1);
  });

  it('returns a complete ReloadAssetContext on the happy path (CDK asset + manifest hit)', async () => {
    const ctx = await call();
    expect(ctx).toEqual({
      oldAssetHash: 'oldhash',
      newAssetHash: 'newhash',
      // Absolute path under the cdkOutDir + the manifest's source.directory.
      newAssetSourceDir: '/tmp/cdk.out/asset.newhash',
      // Defaults to 'Dockerfile' when manifest omits source.dockerFile.
      dockerFile: 'Dockerfile',
    });
  });

  it('omits oldAssetHash when the previously-booted image was not a CDK asset', async () => {
    const ctx = await call({ oldHash: undefined });
    expect(ctx).toBeDefined();
    expect(ctx as Record<string, unknown>).not.toHaveProperty('oldAssetHash');
    expect((ctx as { newAssetHash: string }).newAssetHash).toBe('newhash');
  });

  // Phase 4 follow-up (#218 code reviewer Nit #2) — oldAssetHash
  // baseline now reads from the LIVE replica's
  // `lastDeployedAssetHash` stamp (per-replica state) instead of
  // `controller.service` (boot-time descriptor that never updates).
  // After reload #1 swaps the replica's image, reload #2 reading the
  // boot-time descriptor would see oldHash=A + newHash=B even when
  // synth produced identical content for B — wasteful soft-reload.
  // The per-replica stamp closes that loop.

  it('reads oldAssetHash from the live replica stamp (post-rebuild reload sees current hash, not boot-time)', async () => {
    // Simulate the state after a prior rebuild reload: the boot-time
    // descriptor still carries the OLD hash, but the live replica
    // has been rolled to a NEWER image and stamped accordingly.
    const ctx = await call({ oldHash: 'oldhash-boottime', liveStamp: 'newhash' });
    // The classifier guard `oldAssetHash === newAssetHash` now sees
    // the LIVE hash matching the synth's hash → routes to rebuild
    // (which is the correct "no-op" outcome instead of a wasteful
    // soft-reload of identical bytes).
    expect((ctx as { oldAssetHash: string }).oldAssetHash).toBe('newhash');
  });

  it('falls back to controller.service.task when the live stamp is missing (defensive)', async () => {
    // Older host CLIs that hand-build run state without the
    // `lastDeployedAssetHash` stamp should still get the boot-time
    // descriptor's hash, not undefined.
    const ctx = await call({ oldHash: 'oldhash', liveStamp: 'omit' });
    expect((ctx as { oldAssetHash: string }).oldAssetHash).toBe('oldhash');
  });

  it('falls back to controller.service.task when the live stamp is explicitly undefined', async () => {
    // A replica whose image isn't a CDK asset will stamp
    // `lastDeployedAssetHash = undefined` (the helper returns
    // undefined for ECR / public images). The loader should fall
    // back to the boot-time descriptor in that case.
    const ctx = await call({ oldHash: 'oldhash', liveStamp: undefined });
    expect((ctx as { oldAssetHash: string }).oldAssetHash).toBe('oldhash');
  });

  it('normalizes a custom Dockerfile basename that includes a relative path', async () => {
    hoisted.manifest = {
      version: '1.0.0',
      files: {},
      dockerImages: {
        newhash: {
          displayName: 'WebTask:web',
          source: { directory: 'asset.newhash', dockerFile: 'dockerfiles/Prod.Dockerfile' },
          destinations: {},
        },
      },
    };
    const ctx = await call();
    // The classifier compares against `path.basename(changedPath)`, so
    // the loader MUST normalize before populating ctx — otherwise an
    // edit to `dockerfiles/Prod.Dockerfile` would silently route to
    // soft-reload.
    expect((ctx as { dockerFile: string }).dockerFile).toBe('Prod.Dockerfile');
  });
});
