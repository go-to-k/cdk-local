import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ResolvedDistribution } from '../../../src/local/cloudfront-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

// go-to-k/cdk-local#699: the deployed-KVS reader is wired whenever ANY state
// source is active, including a host's extra provider (e.g. a host's
// `--from-state`), not only `--from-cfn-stack`. The KVS binding layer and the
// provider dispatcher are stubbed; the state-source predicates run for real.
const { resolveKvsMock, createProviderMock } = vi.hoisted(() => ({
  resolveKvsMock: vi.fn(async () => ({ warnings: [] as string[] })),
  createProviderMock: vi.fn(),
}));

vi.mock('../../../src/local/cloudfront-kvs-binding.js', async (importActual) => ({
  ...(await importActual<typeof import('../../../src/local/cloudfront-kvs-binding.js')>()),
  resolveKvsModulesForDistribution: resolveKvsMock,
}));
vi.mock('../../../src/cli/commands/local-state-source.js', async (importActual) => ({
  ...(await importActual<typeof import('../../../src/cli/commands/local-state-source.js')>()),
  createLocalStateProvider: createProviderMock,
}));

const { attachKvsModules } = await import('../../../src/cli/commands/local-start-cloudfront.js');

const dist = {
  logicalId: 'Dist',
  stackName: 'Stack',
  behaviors: [],
  origins: new Map(),
  customErrorResponses: [],
} as unknown as ResolvedDistribution;
const stacks = [{ stackName: 'Stack', region: 'us-west-2', template: {} } as unknown as StackInfo];
const logger = { info: vi.fn(), warn: vi.fn() } as never;

/** The `resolveDeployedKvs` callback handed to the binding layer, if any. */
function deployedKvsResolver(): ((id: string) => Promise<unknown>) | undefined {
  const resolution = resolveKvsMock.mock.calls.at(-1)![1] as {
    resolveDeployedKvs?: (id: string) => Promise<unknown>;
  };
  return resolution.resolveDeployedKvs;
}

beforeEach(() => {
  resolveKvsMock.mockClear();
  createProviderMock.mockReset();
});

describe('attachKvsModules — state-source gate', () => {
  it("wires the deployed-KVS reader under a host's extra provider, which it consults", async () => {
    const load = vi.fn().mockResolvedValue({
      resources: { Store: { physicalId: 'arn:aws:cloudfront::123456789012:key-value-store/abc' } },
    });
    const dispose = vi.fn();
    createProviderMock.mockReturnValue({ load, dispose });
    const providers = { fromState: vi.fn() };

    await attachKvsModules(dist, stacks, { fromState: true } as never, undefined, logger, providers);

    const resolve = deployedKvsResolver();
    expect(resolve).toBeDefined();
    const ref = await resolve!('Store');
    expect(createProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ fromState: true }),
      'Stack',
      'us-west-2',
      providers
    );
    expect(load).toHaveBeenCalledWith('Stack', 'us-west-2');
    expect(dispose).toHaveBeenCalledOnce();
    expect(ref).toMatchObject({ arn: 'arn:aws:cloudfront::123456789012:key-value-store/abc' });
  });

  it('wires no deployed-KVS reader when no state source is active', async () => {
    await attachKvsModules(dist, stacks, { fromState: false } as never, undefined, logger, {
      fromState: vi.fn(),
    });
    expect(deployedKvsResolver()).toBeUndefined();
  });
});
