import { describe, expect, it, vi } from 'vite-plus/test';

/**
 * `@aws-cdk/toolkit-lib` is the most expensive import in cdk-local's graph and
 * `assembly-reader.ts` is reachable from every entry point, so it must be
 * loaded on first synth only. These factories run when the module is first
 * EVALUATED, which is what the flags record.
 */
const loaded = vi.hoisted(() => ({ toolkitLib: false, cloudAssemblyApi: false }));

vi.mock('@aws-cdk/toolkit-lib', () => {
  loaded.toolkitLib = true;
  class Toolkit {
    async fromAssemblyDirectory(): Promise<object> {
      return {};
    }
    async synth(): Promise<object> {
      return {
        cloudAssembly: { directory: '/tmp/cdk.out', stacks: [] },
        dispose: async () => {},
      };
    }
  }
  return {
    Toolkit,
    CdkAppMultiContext: class {},
    BaseCredentials: { awsCliCompatible: () => ({}) },
    NonInteractiveIoHost: class {
      async notify(): Promise<void> {}
    },
  };
});

vi.mock('@aws-cdk/cloud-assembly-api', () => {
  loaded.cloudAssemblyApi = true;
  return { AssetManifestArtifact: class {} };
});

describe('AssemblyReader — toolkit-lib is loaded lazily', () => {
  // First, so nothing has loaded the mocks yet: a static import anywhere in
  // either public entry's graph (a command file importing cdkl-io-host.ts, a
  // re-export) would bring the cost back without touching assembly-reader.ts.
  it('neither public entry point evaluates toolkit-lib or cloud-assembly-api at import', async () => {
    await import('../../../src/index.js');
    await import('../../../src/internal.js');
    expect(loaded).toEqual({ toolkitLib: false, cloudAssemblyApi: false });
    // Transforming both entries' whole source graph takes several seconds.
  }, 60_000);

  it('does not evaluate toolkit-lib or cloud-assembly-api at module load, only on first read', async () => {
    const { AssemblyReader } = await import('../../../src/synthesis/assembly-reader.js');
    expect(loaded).toEqual({ toolkitLib: false, cloudAssemblyApi: false });

    await expect(new AssemblyReader().readFromDirectory('/tmp/cdk.out')).resolves.toEqual([]);
    expect(loaded).toEqual({ toolkitLib: true, cloudAssemblyApi: true });
  });
});
