import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { EcsImageResolutionContext } from '../../../src/local/ecs-task-resolver.js';

// Mock every external boundary the boot-time pin classifier touches so the
// tests exercise the wiring (issue #354) without synth / Docker / AWS.
const hoisted = vi.hoisted(() => ({
  resolveEcsServiceTarget: vi.fn(),
  isLocalCdkAssetImage: vi.fn(),
  buildEcsImageResolutionContext: vi.fn(),
  createLocalStateProvider: vi.fn(),
}));

vi.mock('../../../src/local/ecs-service-resolver.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/local/ecs-service-resolver.js')>();
  return { ...actual, resolveEcsServiceTarget: hoisted.resolveEcsServiceTarget };
});
vi.mock('../../../src/local/image-pin-detector.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/local/image-pin-detector.js')>();
  return { ...actual, isLocalCdkAssetImage: hoisted.isLocalCdkAssetImage };
});
// Partial mock: local-studio.ts only calls buildEcsImageResolutionContext, but
// studio-option-catalog (transitively imported) needs the real
// createLocalRunTaskCommand factory, so preserve every other export.
vi.mock('../../../src/cli/commands/local-run-task.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/commands/local-run-task.js')>();
  return { ...actual, buildEcsImageResolutionContext: hoisted.buildEcsImageResolutionContext };
});
// Stub the per-stack state-provider factory so the test asserts the wiring
// (provider built under --from-cfn-stack, disposed) without an AWS / CFn call.
// resolveCfnFallbackRegion + rejectExplicitCfnStackWithMultipleStacks keep
// their real (pure) behavior.
vi.mock('../../../src/cli/commands/local-state-source.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/cli/commands/local-state-source.js')>();
  return { ...actual, createLocalStateProvider: hoisted.createLocalStateProvider };
});

const {
  resolveEcsServiceStack,
  prepareEcsImageContexts,
  makePinClassifier,
} = await import('../../../src/cli/commands/local-studio.js');

function stack(name: string, region?: string): StackInfo {
  return {
    stackName: name,
    displayName: name,
    artifactId: name,
    template: { Resources: {} },
    dependencyNames: [],
    ...(region !== undefined ? { region } : {}),
  } as StackInfo;
}

function fakeLogger() {
  return {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
  } as unknown as ReturnType<
    typeof import('../../../src/utils/logger.js').getLogger
  >;
}

beforeEach(() => {
  hoisted.resolveEcsServiceTarget.mockReset();
  hoisted.isLocalCdkAssetImage.mockReset();
  hoisted.buildEcsImageResolutionContext.mockReset();
  hoisted.createLocalStateProvider.mockReset();
});

describe('resolveEcsServiceStack', () => {
  it('returns the lone stack for an id with no stack segment', () => {
    const s = stack('OnlyStack');
    expect(resolveEcsServiceStack('Svc', [s])).toBe(s);
  });

  it('returns undefined for an unprefixed id when multiple stacks exist', () => {
    expect(resolveEcsServiceStack('Svc', [stack('A'), stack('B')])).toBeUndefined();
  });

  it('matches a path-form id by its stack segment', () => {
    const dev = stack('dev');
    const prod = stack('prod');
    expect(resolveEcsServiceStack('dev/Svc/Service', [dev, prod])).toBe(dev);
  });

  it('matches a stack:logicalId id by its stack segment', () => {
    const dev = stack('dev');
    const prod = stack('prod');
    expect(resolveEcsServiceStack('prod:SvcABC123', [dev, prod])).toBe(prod);
  });
});

describe('prepareEcsImageContexts', () => {
  it('returns an empty map and builds NO state provider when --from-cfn-stack is not set', async () => {
    const logger = fakeLogger();
    const map = await prepareEcsImageContexts({
      serviceIds: ['dev/Svc'],
      stacks: [stack('dev')],
      options: {},
      logger,
    });
    expect(map.size).toBe(0);
    expect(hoisted.createLocalStateProvider).not.toHaveBeenCalled();
    expect(hoisted.buildEcsImageResolutionContext).not.toHaveBeenCalled();
  });

  it('builds ONE state provider + context per owning stack under --from-cfn-stack, then disposes it', async () => {
    const logger = fakeLogger();
    const ctx: EcsImageResolutionContext = { stateResources: {} };
    const dispose = vi.fn();
    hoisted.createLocalStateProvider.mockReturnValue({ dispose });
    hoisted.buildEcsImageResolutionContext.mockResolvedValue(ctx);

    const map = await prepareEcsImageContexts({
      // Two services in the SAME stack => one provider + one context build.
      serviceIds: ['dev/SvcA', 'dev/SvcB'],
      stacks: [stack('dev', 'us-east-1')],
      options: { fromCfnStack: true },
      logger,
    });

    expect(hoisted.createLocalStateProvider).toHaveBeenCalledTimes(1);
    expect(hoisted.buildEcsImageResolutionContext).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(map.get('dev')).toBe(ctx);
  });

  it('builds a SEPARATE provider + context per DISTINCT owning stack (bare --from-cfn-stack)', async () => {
    const logger = fakeLogger();
    const ctx: EcsImageResolutionContext = { stateResources: {} };
    hoisted.createLocalStateProvider.mockReturnValue({ dispose: vi.fn() });
    hoisted.buildEcsImageResolutionContext.mockResolvedValue(ctx);

    const map = await prepareEcsImageContexts({
      serviceIds: ['dev/Svc', 'prod/Svc'],
      stacks: [stack('dev', 'us-east-1'), stack('prod', 'us-west-2')],
      options: { fromCfnStack: true },
      logger,
    });

    // One provider + one context build PER distinct owning stack.
    expect(hoisted.createLocalStateProvider).toHaveBeenCalledTimes(2);
    expect(hoisted.buildEcsImageResolutionContext).toHaveBeenCalledTimes(2);
    expect(map.get('dev')).toBe(ctx);
    expect(map.get('prod')).toBe(ctx);
  });

  it('rejects an EXPLICIT --from-cfn-stack <name> when services span multiple stacks', async () => {
    const logger = fakeLogger();
    hoisted.createLocalStateProvider.mockReturnValue({ dispose: vi.fn() });
    hoisted.buildEcsImageResolutionContext.mockResolvedValue(undefined);

    // An explicit stack name binds ONE CFn stack; >1 owning stack is ambiguous
    // and must fail fast (the real `rejectExplicitCfnStackWithMultipleStacks`).
    await expect(
      prepareEcsImageContexts({
        serviceIds: ['dev/Svc', 'prod/Svc'],
        stacks: [stack('dev', 'us-east-1'), stack('prod', 'us-west-2')],
        options: { fromCfnStack: 'MyDeployedStack' },
        logger,
      })
    ).rejects.toThrow();
    // No provider is built once the guard rejects.
    expect(hoisted.createLocalStateProvider).not.toHaveBeenCalled();
  });

  it('skips a malformed service id instead of aborting boot', async () => {
    const logger = fakeLogger();
    const ctx: EcsImageResolutionContext = { stateResources: {} };
    hoisted.createLocalStateProvider.mockReturnValue({ dispose: vi.fn() });
    hoisted.buildEcsImageResolutionContext.mockResolvedValue(ctx);

    // '' is malformed (resolveEcsServiceStack -> parseEcsTarget throws); the
    // well-formed id is still classified. The call must NOT reject.
    const map = await prepareEcsImageContexts({
      serviceIds: ['', 'dev/Svc'],
      stacks: [stack('dev', 'us-east-1')],
      options: { fromCfnStack: true },
      logger,
    });
    expect(map.get('dev')).toBe(ctx);
  });

  it('passes the deployed-state context to buildEcsImageResolutionContext (the issue #354 thread)', async () => {
    const logger = fakeLogger();
    const provider = { dispose: vi.fn() };
    hoisted.createLocalStateProvider.mockReturnValue(provider);
    hoisted.buildEcsImageResolutionContext.mockResolvedValue(undefined);

    await prepareEcsImageContexts({
      serviceIds: ['dev/Svc'],
      stacks: [stack('dev', 'us-east-1')],
      options: { fromCfnStack: true },
      logger,
    });

    expect(hoisted.buildEcsImageResolutionContext).toHaveBeenCalledWith(
      expect.objectContaining({ stackName: 'dev' }),
      provider,
      expect.objectContaining({ fromCfnStack: true })
    );
  });

  it('maps a stack to undefined and WARNs when its context build throws', async () => {
    const logger = fakeLogger();
    const dispose = vi.fn();
    hoisted.createLocalStateProvider.mockReturnValue({ dispose });
    hoisted.buildEcsImageResolutionContext.mockRejectedValue(new Error('state load failed'));

    const map = await prepareEcsImageContexts({
      serviceIds: ['dev/Svc'],
      stacks: [stack('dev', 'us-east-1')],
      options: { fromCfnStack: true },
      logger,
    });

    expect(map.get('dev')).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('state load failed'));
    // Provider is still disposed on the failure path.
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe('makePinClassifier', () => {
  it('marks a registry-pinned service as pinned (true)', () => {
    const logger = fakeLogger();
    hoisted.resolveEcsServiceTarget.mockReturnValue({ id: 'resolved' });
    hoisted.isLocalCdkAssetImage.mockReturnValue(false); // not a local asset => pinned

    const classify = makePinClassifier({
      stacks: [stack('dev')],
      contextByStack: new Map(),
      logger,
    });

    expect(classify('dev/Svc')).toBe(true);
  });

  it('does NOT mark a local-asset service (false)', () => {
    const logger = fakeLogger();
    hoisted.resolveEcsServiceTarget.mockReturnValue({ id: 'resolved' });
    hoisted.isLocalCdkAssetImage.mockReturnValue(true); // local asset => not pinned

    const classify = makePinClassifier({
      stacks: [stack('dev')],
      contextByStack: new Map(),
      logger,
    });

    expect(classify('dev/Svc')).toBe(false);
  });

  it('threads the owning-stack image context into resolveEcsServiceTarget', () => {
    const logger = fakeLogger();
    const ctx: EcsImageResolutionContext = { stateResources: { Repo: { id: 'r' } } };
    hoisted.resolveEcsServiceTarget.mockReturnValue({ id: 'resolved' });
    hoisted.isLocalCdkAssetImage.mockReturnValue(false);

    const classify = makePinClassifier({
      stacks: [stack('dev')],
      contextByStack: new Map([['dev', ctx]]),
      logger,
    });

    classify('dev/Svc');
    expect(hoisted.resolveEcsServiceTarget).toHaveBeenCalledWith(
      'dev/Svc',
      expect.any(Array),
      ctx
    );
  });

  it('resolves with NO context when no --from-cfn-stack context was built', () => {
    const logger = fakeLogger();
    hoisted.resolveEcsServiceTarget.mockReturnValue({ id: 'resolved' });
    hoisted.isLocalCdkAssetImage.mockReturnValue(true);

    const classify = makePinClassifier({
      stacks: [stack('dev')],
      contextByStack: new Map(), // empty => no context
      logger,
    });

    classify('dev/Svc');
    expect(hoisted.resolveEcsServiceTarget).toHaveBeenCalledWith(
      'dev/Svc',
      expect.any(Array),
      undefined
    );
  });

  it('WARNs (not silent) and returns false when classification throws', () => {
    const logger = fakeLogger();
    hoisted.resolveEcsServiceTarget.mockImplementation(() => {
      throw new Error('cannot resolve image');
    });

    const classify = makePinClassifier({
      stacks: [stack('dev')],
      contextByStack: new Map(),
      logger,
    });

    expect(classify('dev/Svc')).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('cannot resolve image'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("'dev/Svc'"));
  });
});
