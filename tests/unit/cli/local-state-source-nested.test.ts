import { describe, it, expect, afterEach, beforeEach, vi } from 'vite-plus/test';

const { instances } = vi.hoisted(() => ({
  instances: [] as Array<{ options: Record<string, unknown>; label: string }>,
}));

vi.mock('../../../src/local/cfn-local-state-provider.js', () => ({
  CfnLocalStateProvider: class {
    label: string;
    constructor(public options: Record<string, unknown>) {
      this.label =
        (options['label'] as string | undefined) ?? '--from-cfn-stack';
      instances.push(this as never);
    }
    async load(): Promise<unknown> {
      return {
        resources: { Q: { physicalId: 'q-url', resourceType: 'AWS::SQS::Queue', attributes: {} } },
        outputs: {},
        region: 'us-east-1',
      };
    }
    async buildCrossStackResolver(): Promise<undefined> {
      return undefined;
    }
    dispose(): void {}
  },
}));

import {
  createLocalStateProvider,
  deployedStackName,
  deployedStackNamePseudo,
} from '../../../src/cli/commands/local-state-source.js';
import { registerNestedStacks, resetNestedStackRegistry } from '../../../src/synthesis/nested-stacks.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

function top(name: string): StackInfo {
  return {
    stackName: name,
    displayName: name,
    region: 'us-east-1',
    template: { Resources: { Q: { Type: 'AWS::SQS::Queue' } } },
  } as unknown as StackInfo;
}
function child(parent: StackInfo, logicalId: string, parameters: Record<string, unknown> = {}): StackInfo {
  return {
    stackName: `${parent.stackName}~${logicalId}`,
    displayName: `${parent.displayName}/${logicalId}`,
    region: 'us-east-1',
    template: { Resources: {} },
    nestedStack: {
      parentStackName: parent.stackName,
      rootStackName: parent.nestedStack?.rootStackName ?? parent.stackName,
      logicalId,
      parameters,
    },
  } as unknown as StackInfo;
}

describe('createLocalStateProvider for a nested stack (#986)', () => {
  const App = top('App');
  const A = child(App, 'A', { P1: { Ref: 'Q' } });
  const B = child(A, 'B');

  beforeEach(() => {
    instances.length = 0;
    registerNestedStacks([App, A, B]);
  });
  afterEach(async () => {
    resetNestedStackRegistry();
    const { setActiveWorkloadAwsWiring } = await import('../../../src/local/workload-aws-wiring.js');
    setActiveWorkloadAwsWiring(undefined);
  });

  it('bare --from-cfn-stack: the ROOT stack name plus the logical-ID path', () => {
    const p = createLocalStateProvider({ fromCfnStack: true }, 'App~A~B', 'us-east-1');
    expect(instances).toHaveLength(1);
    expect(instances[0]!.options).toMatchObject({ cfnStackName: 'App', nestedPath: ['A', 'B'] });
    p!.dispose();
  });

  it('explicit --from-cfn-stack Explicit: that name plus the logical-ID path', () => {
    const p = createLocalStateProvider({ fromCfnStack: 'Explicit' }, 'App~A', 'us-east-1');
    expect(instances[0]!.options).toMatchObject({ cfnStackName: 'Explicit', nestedPath: ['A'] });
    p!.dispose();
  });

  it('a top-level stack has no nestedPath and is not wrapped', async () => {
    const p = createLocalStateProvider({ fromCfnStack: true }, 'App', 'us-east-1');
    expect(instances[0]!.options['cfnStackName']).toBe('App');
    expect(instances[0]!.options).not.toHaveProperty('nestedPath');
    expect((p as { resolveTemplateSsmParameters?: unknown }).resolveTemplateSsmParameters).toBeUndefined();
    p!.dispose();
  });

  it("wraps a nested stack's provider so its parameters come from the parent's state", async () => {
    const p = createLocalStateProvider({ fromCfnStack: true }, 'App~A', 'us-east-1');
    expect(typeof p!.resolveTemplateSsmParameters).toBe('function');
    const out = await p!.resolveTemplateSsmParameters!(A.template as never);
    expect(out.values).toEqual({ P1: 'q-url' });
    // A second provider was built for the parent (`App`), not the nested stack.
    expect(instances).toHaveLength(2);
    expect(instances[1]!.options['cfnStackName']).toBe('App');
    expect(instances[1]!.options).not.toHaveProperty('nestedPath');
    p!.dispose();
  });

  it('mixed mode: the emulator side also gets the nestedPath', async () => {
    const { setActiveWorkloadAwsWiring } = await import('../../../src/local/workload-aws-wiring.js');
    setActiveWorkloadAwsWiring({
      mode: 'forward',
      env: {},
      scrubEnvKeys: [],
      mounts: [],
      loopbackPorts: [],
      probeHealth: false,
      dispose: () => undefined,
      mixed: {
        realServices: ['DYNAMODB'],
        emulatorEndpoint: { url: 'https://127.0.0.1:9297', hostname: '127.0.0.1', port: 9297, loopback: true },
        resignPort: 47297,
        resignEndpoint: 'https://127.0.0.1:47297',
        emulatorCredentials: { accessKeyId: 'EMU', secretAccessKey: 'e' },
        resignConfigHostPath: '/tmp/x',
        emulatorClientOverride: { endpoint: 'https://127.0.0.1:9297' },
      },
    } as never);
    // No routing installed: every name reads from the emulator side alone.
    const p = createLocalStateProvider({ fromCfnStack: true }, 'App~A', 'us-east-1');
    const emulator = instances.find((i) => i.options['endpointOverride'] !== undefined);
    expect(emulator!.options).toMatchObject({ cfnStackName: 'App', nestedPath: ['A'] });
    p!.dispose();
  });
});

describe('deployedStackName / deployedStackNamePseudo for a nested stack (#986)', () => {
  const App = top('App');
  const A = child(App, 'A');
  beforeEach(() => registerNestedStacks([App, A]));
  afterEach(() => resetNestedStackRegistry());

  it('a registered nested stack has no known deployed name', () => {
    expect(deployedStackName({ fromCfnStack: true }, 'App~A')).toBeUndefined();
    expect(deployedStackName({ fromCfnStack: 'Explicit' }, 'App~A')).toBeUndefined();
    expect(deployedStackNamePseudo({ fromCfnStack: 'Explicit' }, 'App~A')).toEqual({});
  });

  it('a top-level stack keeps its name', () => {
    expect(deployedStackName({ fromCfnStack: true }, 'App')).toBe('App');
    expect(deployedStackName({ fromCfnStack: 'Explicit' }, 'App')).toBe('Explicit');
    expect(deployedStackNamePseudo({ fromCfnStack: true }, 'App')).toEqual({ stackName: 'App' });
  });
});
