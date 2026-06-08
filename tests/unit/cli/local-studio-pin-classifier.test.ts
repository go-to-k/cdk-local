import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { EcsImageResolutionContext } from '../../../src/local/ecs-task-resolver.js';
import type { StudioTargetGroup } from '../../../src/local/studio-server.js';

// Mock every external boundary the boot-time pin classifier touches so the
// tests exercise the wiring (issue #354 / #385) without synth / Docker / AWS.
const hoisted = vi.hoisted(() => ({
  resolveEcsServiceTarget: vi.fn(),
  isLocalCdkAssetImage: vi.fn(),
  buildEcsImageResolutionContext: vi.fn(),
  createLocalStateProvider: vi.fn(),
  discoverDockerfiles: vi.fn(),
  resolveEcsTaskTarget: vi.fn(),
}));

vi.mock('../../../src/local/ecs-service-resolver.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/local/ecs-service-resolver.js')>();
  return { ...actual, resolveEcsServiceTarget: hoisted.resolveEcsServiceTarget };
});
// Partial mock: local-studio.ts calls resolveEcsTaskTarget for the ecs-task pin
// classifier (issue #388); preserve every other export (parseEcsTarget, etc.).
vi.mock('../../../src/local/ecs-task-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/local/ecs-task-resolver.js')>();
  return { ...actual, resolveEcsTaskTarget: hoisted.resolveEcsTaskTarget };
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
// Stub the Dockerfile scan so `classifyStudioTargets` does not walk the real
// cwd (which has fixture Dockerfiles); the tests assert it is called only when
// a target is pinned, and returns a deterministic list.
vi.mock('../../../src/local/image-override-engine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/local/image-override-engine.js')>();
  return { ...actual, discoverDockerfiles: hoisted.discoverDockerfiles };
});

const {
  resolveEcsServiceStack,
  prepareEcsImageContexts,
  makePinClassifier,
  makeTaskPinClassifier,
  classifyStudioTargets,
  reclassifyTargetsOnBindingChange,
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
  hoisted.discoverDockerfiles.mockReset();
  hoisted.resolveEcsTaskTarget.mockReset();
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

  it('appends the Session-bar --from-cfn-stack remedy when state is NOT bound', () => {
    const logger = fakeLogger();
    hoisted.resolveEcsServiceTarget.mockImplementation(() => {
      throw new Error('cannot resolve image');
    });

    const classify = makePinClassifier({
      stacks: [stack('dev')],
      contextByStack: new Map(),
      logger,
      stateBound: false,
    });

    classify('dev/Svc');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('set --from-cfn-stack in the Session bar')
    );
  });

  it('omits the remedy when state IS bound (the resolver error already explains it)', () => {
    const logger = fakeLogger();
    hoisted.resolveEcsServiceTarget.mockImplementation(() => {
      throw new Error('cannot resolve image');
    });

    const classify = makePinClassifier({
      stacks: [stack('dev')],
      contextByStack: new Map(),
      logger,
      stateBound: true,
    });

    classify('dev/Svc');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('cannot resolve image'));
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('set --from-cfn-stack in the Session bar')
    );
  });
});

describe('makeTaskPinClassifier (issue #388)', () => {
  const taskWith = (kind: string, essential = true) => ({
    containers: [{ name: 'web', essential, image: { kind } }],
  });

  it('marks a registry-pinned task definition as pinned (public / ecr)', () => {
    const logger = fakeLogger();
    hoisted.resolveEcsTaskTarget.mockReturnValue(taskWith('public'));
    const classify = makeTaskPinClassifier({ stacks: [stack('dev')], contextByStack: new Map(), logger });
    expect(classify('dev/Task')).toBe(true);
  });

  it('does NOT mark a local-asset task definition', () => {
    const logger = fakeLogger();
    hoisted.resolveEcsTaskTarget.mockReturnValue(taskWith('cdk-asset'));
    const classify = makeTaskPinClassifier({ stacks: [stack('dev')], contextByStack: new Map(), logger });
    expect(classify('dev/Task')).toBe(false);
  });

  it('classifies the representative (first essential) container', () => {
    const logger = fakeLogger();
    // First container non-essential (cdk-asset), second essential (ecr pin).
    hoisted.resolveEcsTaskTarget.mockReturnValue({
      containers: [
        { name: 'sidecar', essential: false, image: { kind: 'cdk-asset' } },
        { name: 'app', essential: true, image: { kind: 'ecr' } },
      ],
    });
    const classify = makeTaskPinClassifier({ stacks: [stack('dev')], contextByStack: new Map(), logger });
    expect(classify('dev/Task')).toBe(true);
  });

  it('threads the owning-stack image context into resolveEcsTaskTarget', () => {
    const logger = fakeLogger();
    const ctx: EcsImageResolutionContext = { stateResources: { Repo: { id: 'r' } } };
    hoisted.resolveEcsTaskTarget.mockReturnValue(taskWith('ecr'));
    const classify = makeTaskPinClassifier({
      stacks: [stack('dev')],
      contextByStack: new Map([['dev', ctx]]),
      logger,
    });
    classify('dev/Task');
    expect(hoisted.resolveEcsTaskTarget).toHaveBeenCalledWith('dev/Task', expect.any(Array), ctx);
  });

  it('WARNs (not silent) and returns false when task resolution throws', () => {
    const logger = fakeLogger();
    hoisted.resolveEcsTaskTarget.mockImplementation(() => {
      throw new Error('cannot resolve task image');
    });
    const classify = makeTaskPinClassifier({ stacks: [stack('dev')], contextByStack: new Map(), logger });
    expect(classify('dev/Task')).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('cannot resolve task image'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('task definition'));
  });

  it('appends the Session-bar --from-cfn-stack remedy when state is NOT bound', () => {
    const logger = fakeLogger();
    hoisted.resolveEcsTaskTarget.mockImplementation(() => {
      throw new Error('cannot resolve task image');
    });
    const classify = makeTaskPinClassifier({
      stacks: [stack('dev')],
      contextByStack: new Map(),
      logger,
      stateBound: false,
    });
    classify('dev/Task');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('set --from-cfn-stack in the Session bar')
    );
  });
});

describe('classifyStudioTargets (issue #385 — re-classify on --from-cfn-stack toggle)', () => {
  const baseGroups = (): StudioTargetGroup[] => [
    {
      kind: 'ecs',
      title: 'ECS Services',
      entries: [{ id: 'dev/Svc', qualifiedId: 'dev:Svc', servable: true }],
    },
  ];

  it('pins an intrinsic-ECR service ONLY under --from-cfn-stack, re-classifying cleanly on toggle', async () => {
    const logger = fakeLogger();
    hoisted.discoverDockerfiles.mockReturnValue(['./Dockerfile']);
    // An INTRINSIC-ECR image resolves ONLY with a deployed-state context; the
    // resolver throws when no context is threaded (no --from-cfn-stack).
    hoisted.resolveEcsServiceTarget.mockImplementation(
      (_id: string, _stacks: unknown, ctx: unknown) => {
        if (!ctx) throw new Error('intrinsic ECR URI needs --from-cfn-stack');
        return { id: 'resolved' };
      }
    );
    hoisted.isLocalCdkAssetImage.mockReturnValue(false); // registry pin
    hoisted.createLocalStateProvider.mockReturnValue({ dispose: vi.fn() });
    hoisted.buildEcsImageResolutionContext.mockResolvedValue({ stateResources: {} });

    const base = baseGroups();
    const stacks = [stack('dev', 'us-east-1')];
    const servableEcs = new Set(['dev/Svc']);

    // OFF: no context built -> resolve throws -> service stays unpinned, no scan.
    const off = await classifyStudioTargets({
      baseGroups: base,
      stacks,
      servableEcs,
      options: {},
      fromCfnStack: undefined,
      logger,
    });
    expect(off.groups[0]?.entries[0]?.pinned).toBeUndefined();
    expect(off.dockerfiles).toEqual([]);
    expect(hoisted.discoverDockerfiles).not.toHaveBeenCalled();
    // Without --from-cfn-stack, the classify WARN tells the user how to surface
    // the picker (set --from-cfn-stack in the Session bar) — the studio-from
    // discoverability fix. End-to-end: classifyStudioTargets derives stateBound
    // from the (absent) binding and threads it into the classifier.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('set --from-cfn-stack in the Session bar')
    );

    // ON: context built -> resolve returns -> service is pinned + Dockerfiles scanned.
    const on = await classifyStudioTargets({
      baseGroups: base,
      stacks,
      servableEcs,
      options: {},
      fromCfnStack: true,
      logger,
    });
    expect(on.groups[0]?.entries[0]?.pinned).toBe(true);
    expect(on.dockerfiles).toEqual(['./Dockerfile']);
    expect(hoisted.discoverDockerfiles).toHaveBeenCalledTimes(1);

    // The base groups are never mutated — each classify clones, so a re-classify
    // under a new binding never inherits stale pins.
    expect(base[0]?.entries[0]?.pinned).toBeUndefined();
  });

  it('pins a deployed-registry ECS task definition + scans Dockerfiles (issue #388)', async () => {
    const logger = fakeLogger();
    hoisted.discoverDockerfiles.mockReturnValue(['./Dockerfile']);
    hoisted.resolveEcsTaskTarget.mockReturnValue({
      containers: [{ name: 'web', essential: true, image: { kind: 'public' } }],
    });
    const base: StudioTargetGroup[] = [
      { kind: 'ecs', title: 'ECS Services', entries: [] },
      {
        kind: 'ecs-task',
        title: 'ECS Task Definitions',
        entries: [{ id: 'dev/Task', qualifiedId: 'dev:Task' }],
      },
    ];
    const result = await classifyStudioTargets({
      baseGroups: base,
      stacks: [stack('dev')],
      servableEcs: new Set(),
      options: {},
      fromCfnStack: undefined,
      logger,
    });
    const taskGroup = result.groups.find((g) => g.kind === 'ecs-task');
    expect(taskGroup?.entries[0]?.pinned).toBe(true);
    expect(result.dockerfiles).toEqual(['./Dockerfile']);
    // The task-def id was resolved (it was collected into prepareEcsImageContexts
    // + classified), and the base groups stay un-annotated (fresh clone).
    expect(hoisted.resolveEcsTaskTarget).toHaveBeenCalledWith('dev/Task', expect.any(Array), undefined);
    expect((base[1]?.entries[0] as { pinned?: boolean }).pinned).toBeUndefined();
  });

  it('builds the deployed-state context for a task-def-only stack under --from-cfn-stack (issue #388)', async () => {
    const logger = fakeLogger();
    hoisted.discoverDockerfiles.mockReturnValue(['./Dockerfile']);
    // An INTRINSIC-ECR task-def image resolves ONLY with a deployed-state
    // context; the resolver throws when no context is threaded.
    hoisted.resolveEcsTaskTarget.mockImplementation((_id: string, _stacks: unknown, ctx: unknown) => {
      if (!ctx) throw new Error('intrinsic ECR URI needs --from-cfn-stack');
      return { containers: [{ name: 'web', essential: true, image: { kind: 'ecr' } }] };
    });
    hoisted.createLocalStateProvider.mockReturnValue({ dispose: vi.fn() });
    hoisted.buildEcsImageResolutionContext.mockResolvedValue({ stateResources: {} });

    // NO servable services — the task-def id is the ONLY reason its stack
    // enters the per-stack context build.
    const base: StudioTargetGroup[] = [
      { kind: 'ecs', title: 'ECS Services', entries: [] },
      {
        kind: 'ecs-task',
        title: 'ECS Task Definitions',
        entries: [{ id: 'dev/Task', qualifiedId: 'dev:Task' }],
      },
    ];
    const stacks = [stack('dev', 'us-east-1')];

    // OFF: no context built -> resolve throws -> task def stays unpinned.
    const off = await classifyStudioTargets({
      baseGroups: base,
      stacks,
      servableEcs: new Set(),
      options: {},
      fromCfnStack: undefined,
      logger,
    });
    expect(off.groups.find((g) => g.kind === 'ecs-task')?.entries[0]?.pinned).toBeUndefined();

    // ON: the TASK-DEF id alone drives the per-stack context build, so the
    // intrinsic-ECR image resolves and the task def is pinned.
    const on = await classifyStudioTargets({
      baseGroups: base,
      stacks,
      servableEcs: new Set(),
      options: {},
      fromCfnStack: true,
      logger,
    });
    expect(on.groups.find((g) => g.kind === 'ecs-task')?.entries[0]?.pinned).toBe(true);
    expect(hoisted.buildEcsImageResolutionContext).toHaveBeenCalledWith(
      expect.objectContaining({ stackName: 'dev' }),
      expect.anything(),
      expect.objectContaining({ fromCfnStack: true })
    );
  });

  it('does not scan Dockerfiles for an all-local-asset app', async () => {
    const logger = fakeLogger();
    hoisted.discoverDockerfiles.mockReturnValue(['./Dockerfile']);
    hoisted.resolveEcsServiceTarget.mockReturnValue({ id: 'resolved' });
    hoisted.isLocalCdkAssetImage.mockReturnValue(true); // local asset => not pinned

    const result = await classifyStudioTargets({
      baseGroups: baseGroups(),
      stacks: [stack('dev')],
      servableEcs: new Set(['dev/Svc']),
      options: {},
      fromCfnStack: undefined,
      logger,
    });
    expect(result.groups[0]?.entries[0]?.pinned).toBeUndefined();
    expect(result.dockerfiles).toEqual([]);
    expect(hoisted.discoverDockerfiles).not.toHaveBeenCalled();
  });
});

describe('reclassifyTargetsOnBindingChange (issue #385 — PATCH /api/config orchestration)', () => {
  const result = (dockerfiles: string[] = []) => ({
    groups: [{ kind: 'ecs' as const, title: 'ECS Services', entries: [] }],
    dockerfiles,
  });

  it('skips re-classification when the binding is unchanged (a watch / role toggle)', async () => {
    const logger = fakeLogger();
    const classify = vi.fn();
    const applyTargets = vi.fn();
    await reclassifyTargetsOnBindingChange({
      before: 'dev',
      after: 'dev',
      classify,
      applyTargets,
      tokenRef: { current: 0 },
      logger,
    });
    expect(classify).not.toHaveBeenCalled();
    expect(applyTargets).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('re-classifies + swaps the target list with the POST-PATCH binding', async () => {
    const logger = fakeLogger();
    const classify = vi.fn().mockResolvedValue(result(['./Dockerfile']));
    const applyTargets = vi.fn();
    await reclassifyTargetsOnBindingChange({
      before: undefined,
      after: 'NewStack',
      classify,
      applyTargets,
      tokenRef: { current: 0 },
      logger,
    });
    // The NEW binding (not the old one) is threaded into classify.
    expect(classify).toHaveBeenCalledWith('NewStack');
    expect(applyTargets).toHaveBeenCalledWith(
      [{ kind: 'ecs', title: 'ECS Services', entries: [] }],
      ['./Dockerfile']
    );
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('re-classifying targets'));
  });

  it('treats clearing the binding (string -> undefined) as a change', async () => {
    const logger = fakeLogger();
    const classify = vi.fn().mockResolvedValue(result());
    const applyTargets = vi.fn();
    await reclassifyTargetsOnBindingChange({
      before: 'dev',
      after: undefined,
      classify,
      applyTargets,
      tokenRef: { current: 0 },
      logger,
    });
    expect(classify).toHaveBeenCalledWith(undefined);
    expect(applyTargets).toHaveBeenCalledTimes(1);
  });

  it('latest-wins: a superseded earlier re-classify does NOT swap the list', async () => {
    const logger = fakeLogger();
    const tokenRef = { current: 0 };
    const applyTargets = vi.fn();
    // First classify is slow (resolves last); second is fast.
    let releaseSlow!: () => void;
    const slow = new Promise<{ groups: never[]; dockerfiles: string[] }>((res) => {
      releaseSlow = () => res({ groups: [], dockerfiles: ['./slow'] });
    });
    const classify = vi
      .fn()
      .mockReturnValueOnce(slow)
      .mockResolvedValueOnce({ groups: [], dockerfiles: ['./fast'] });

    const p1 = reclassifyTargetsOnBindingChange({
      before: undefined,
      after: 'A',
      classify,
      applyTargets,
      tokenRef,
      logger,
    });
    const p2 = reclassifyTargetsOnBindingChange({
      before: 'A',
      after: 'B',
      classify,
      applyTargets,
      tokenRef,
      logger,
    });
    await p2; // the newer patch applies its result first
    releaseSlow();
    await p1; // the older patch resolves but is superseded

    // Only the LATEST binding's result was applied.
    expect(applyTargets).toHaveBeenCalledTimes(1);
    expect(applyTargets).toHaveBeenCalledWith([], ['./fast']);
  });

  it('fails soft: a classify rejection WARNs and keeps the previous list (no throw)', async () => {
    const logger = fakeLogger();
    const classify = vi.fn().mockRejectedValue(new Error('state load failed'));
    const applyTargets = vi.fn();
    await expect(
      reclassifyTargetsOnBindingChange({
        before: undefined,
        after: 'BadStack',
        classify,
        applyTargets,
        tokenRef: { current: 0 },
        logger,
      })
    ).resolves.toBeUndefined();
    expect(applyTargets).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('state load failed'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('could not re-classify'));
  });
});
