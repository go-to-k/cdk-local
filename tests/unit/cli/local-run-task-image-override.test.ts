import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ResolvedEcsTask, ResolvedEcsContainer } from '../../../src/local/ecs-task-resolver.js';

// Mock the image-override engine so the run-task wiring (issue #388) is tested
// without `docker build` / a real synth — the engine itself has its own suite.
const hoisted = vi.hoisted(() => ({
  parseImageOverrideFlags: vi.fn(),
  resolveImageOverrides: vi.fn(),
  enforceImageOverrideOrphans: vi.fn(),
  runImageOverrideBuilds: vi.fn(),
}));

vi.mock('../../../src/local/image-override-engine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/local/image-override-engine.js')>();
  return { ...actual, ...hoisted };
});

const { resolveRunTaskImageOverride } = await import('../../../src/cli/commands/local-run-task.js');

/** A minimal RawImageOverrideFlags-shaped object (only the read fields). */
function rawFlags(over: Partial<{ explicit: Map<string, string>; pickerPaths: string[]; perService: Map<string, unknown> }> = {}) {
  return {
    explicit: over.explicit ?? new Map<string, string>(),
    pickerPaths: over.pickerPaths ?? [],
    globals: { buildArgs: new Map(), buildSecrets: new Map() },
    perService: over.perService ?? new Map(),
  };
}

function container(name: string, kind: ResolvedEcsContainer['image']['kind'], essential = true): ResolvedEcsContainer {
  const image =
    kind === 'cdk-asset'
      ? { kind: 'cdk-asset' as const }
      : kind === 'ecr'
        ? { kind: 'ecr' as const, uri: '111.dkr.ecr.us-east-1.amazonaws.com/repo:tag', account: '111', region: 'us-east-1' }
        : { kind: 'public' as const, uri: 'public.ecr.aws/x/y:latest' };
  return { name, image, essential } as unknown as ResolvedEcsContainer;
}

function task(containers: ResolvedEcsContainer[]): ResolvedEcsTask {
  return {
    stack: { stackName: 'MyStack' },
    taskDefinitionLogicalId: 'MyTaskDef',
    family: 'fam',
    containers,
  } as unknown as ResolvedEcsTask;
}

beforeEach(() => {
  hoisted.parseImageOverrideFlags.mockReset().mockReturnValue(rawFlags());
  hoisted.resolveImageOverrides.mockReset().mockResolvedValue(new Map());
  hoisted.enforceImageOverrideOrphans.mockReset();
  hoisted.runImageOverrideBuilds.mockReset().mockResolvedValue(new Map());
});

describe('resolveRunTaskImageOverride (issue #388)', () => {
  it('short-circuits for a local CDK-asset task with no override flags', async () => {
    const result = await resolveRunTaskImageOverride({
      task: task([container('web', 'cdk-asset')]),
      target: 'MyStack/MyTaskDef',
      options: {},
    });
    expect(result).toEqual({});
    expect(hoisted.resolveImageOverrides).not.toHaveBeenCalled();
    expect(hoisted.runImageOverrideBuilds).not.toHaveBeenCalled();
  });

  it('reports pinnedUncovered when a pinned image gets no override', async () => {
    hoisted.resolveImageOverrides.mockResolvedValue(new Map()); // nothing covered
    const result = await resolveRunTaskImageOverride({
      task: task([container('web', 'ecr')]),
      target: 'MyStack/MyTaskDef',
      options: { interactiveOverrides: false },
    });
    expect(result.pinnedUncovered).toBe(true);
    expect(result.imageOverrideByContainer).toBeUndefined();
    // The pinned target + a (no-op) resolve still ran (no short-circuit).
    expect(hoisted.resolveImageOverrides).toHaveBeenCalledWith(
      expect.objectContaining({ pinnedTargets: ['MyStack/MyTaskDef'] })
    );
    expect(hoisted.runImageOverrideBuilds).not.toHaveBeenCalled();
  });

  it('builds + threads the override tag keyed on the essential container', async () => {
    hoisted.parseImageOverrideFlags.mockReturnValue(
      rawFlags({ explicit: new Map([['MyStack/MyTaskDef', './Dockerfile']]) })
    );
    hoisted.resolveImageOverrides.mockResolvedValue(new Map([['MyStack/MyTaskDef', {}]]));
    hoisted.runImageOverrideBuilds.mockResolvedValue(
      new Map([['MyStack/MyTaskDef', 'cdk-local-override-mytaskdef-abc:local']])
    );
    const result = await resolveRunTaskImageOverride({
      task: task([container('sidecar', 'ecr', false), container('app', 'ecr', true)]),
      target: 'MyStack/MyTaskDef',
      options: { imageOverride: ['./Dockerfile'] },
    });
    expect(result.imageOverrideByContainer).toEqual(
      new Map([['app', 'cdk-local-override-mytaskdef-abc:local']])
    );
  });

  it('classifies a public-registry image as pinned (parity with the ecr pin)', async () => {
    hoisted.resolveImageOverrides.mockResolvedValue(new Map());
    const result = await resolveRunTaskImageOverride({
      task: task([container('web', 'public')]),
      target: 'MyStack/MyTaskDef',
      options: { interactiveOverrides: false },
    });
    expect(result.pinnedUncovered).toBe(true);
    expect(hoisted.resolveImageOverrides).toHaveBeenCalledWith(
      expect.objectContaining({ pinnedTargets: ['MyStack/MyTaskDef'] })
    );
  });

  it('keys the override on the first container when none is marked essential', async () => {
    hoisted.parseImageOverrideFlags.mockReturnValue(
      rawFlags({ explicit: new Map([['MyStack/MyTaskDef', './Dockerfile']]) })
    );
    hoisted.resolveImageOverrides.mockResolvedValue(new Map([['MyStack/MyTaskDef', {}]]));
    hoisted.runImageOverrideBuilds.mockResolvedValue(new Map([['MyStack/MyTaskDef', 'tag:local']]));
    // Both containers non-essential => representative is the first (`first`).
    const result = await resolveRunTaskImageOverride({
      task: task([container('first', 'ecr', false), container('second', 'ecr', false)]),
      target: 'MyStack/MyTaskDef',
      options: { imageOverride: ['./Dockerfile'] },
    });
    expect(result.imageOverrideByContainer).toEqual(new Map([['first', 'tag:local']]));
  });

  it('throws under --strict-overrides when the pinned image stays uncovered', async () => {
    hoisted.resolveImageOverrides.mockResolvedValue(new Map()); // uncovered
    await expect(
      resolveRunTaskImageOverride({
        task: task([container('web', 'ecr')]),
        target: 'MyStack/MyTaskDef',
        options: { strictOverrides: true, interactiveOverrides: false },
      })
    ).rejects.toThrow(/strict-overrides/);
  });

  it('propagates an orphaned per-service build-input flag error', async () => {
    hoisted.parseImageOverrideFlags.mockReturnValue(
      rawFlags({ perService: new Map([['MyStack/MyTaskDef', {}]]) })
    );
    hoisted.enforceImageOverrideOrphans.mockImplementation(() => {
      throw new Error('orphaned --image-build-arg');
    });
    await expect(
      resolveRunTaskImageOverride({
        task: task([container('web', 'cdk-asset')]),
        target: 'MyStack/MyTaskDef',
        options: { imageBuildArg: ['MyStack/MyTaskDef:K=V'] },
      })
    ).rejects.toThrow(/orphaned/);
  });
});
