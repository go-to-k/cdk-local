import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import {
  nestedStackChain,
  resolveNestedStackParameters,
  withNestedStackParameters,
} from '../../../src/local/nested-stack-state.js';
import { resetNestedStackRegistry } from '../../../src/synthesis/nested-stacks.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { LocalStateProvider } from '../../../src/local/local-state-provider.js';
import { getLogger } from '../../../src/utils/logger.js';

function mk(
  name: string,
  opts: { parent?: StackInfo; logicalId?: string; parameters?: Record<string, unknown>; resources?: Record<string, unknown> } = {}
): StackInfo {
  return {
    stackName: name,
    displayName: name,
    template: { Resources: opts.resources ?? {} },
    ...(opts.parent && {
      nestedStack: {
        parentStackName: opts.parent.stackName,
        rootStackName: opts.parent.nestedStack?.rootStackName ?? opts.parent.stackName,
        logicalId: opts.logicalId!,
        parameters: opts.parameters ?? {},
      },
    }),
  } as unknown as StackInfo;
}

function fakeProvider(
  resources: Record<string, unknown>,
  ssm?: (t: unknown) => Promise<{ values: Record<string, string | string[]>; secureStringLogicalIds: string[] }>
): LocalStateProvider & { dispose: ReturnType<typeof vi.fn> } {
  return {
    label: '--from-state',
    load: vi.fn(async () => ({ resources, outputs: {}, region: 'us-east-1' })),
    buildCrossStackResolver: vi.fn(async () => undefined),
    dispose: vi.fn(),
    ...(ssm && { resolveTemplateSsmParameters: vi.fn(ssm) }),
  } as unknown as LocalStateProvider & { dispose: ReturnType<typeof vi.fn> };
}

const Q = { physicalId: 'q-url', resourceType: 'AWS::SQS::Queue', attributes: { Arn: 'arn:q' } };

describe('nestedStackChain', () => {
  afterEach(() => resetNestedStackRegistry());

  it('returns root and logical-id path for depth 2', () => {
    const app = mk('App');
    const a = mk('App~A', { parent: app, logicalId: 'A' });
    const b = mk('App~A~B', { parent: a, logicalId: 'B' });
    const all = new Map([app, a, b].map((s) => [s.stackName, s]));
    expect(nestedStackChain(b, (n) => all.get(n))).toEqual({ root: 'App', path: ['A', 'B'] });
  });

  it('is empty for a top-level stack', () => {
    const app = mk('App');
    expect(nestedStackChain(app, () => undefined)).toEqual({ root: 'App', path: [] });
  });
});

describe('resolveNestedStackParameters', () => {
  it('resolves Ref and GetAtt, leaves unresolved out with a warning', async () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const parent = mk('App', { resources: { Q: { Type: 'AWS::SQS::Queue' } } });
    const child = mk('App~I', {
      parent,
      logicalId: 'I',
      parameters: { P1: { Ref: 'Q' }, P2: { 'Fn::GetAtt': ['Q', 'Arn'] }, P3: { Ref: 'Missing' } },
    });
    const out = await resolveNestedStackParameters(child, parent, fakeProvider({ Q }));
    expect(out.values).toEqual({ P1: 'q-url', P2: 'arn:q' });
    expect(out.values).not.toHaveProperty('P3');
    expect(out.secureStringLogicalIds).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('P3');
    warn.mockRestore();
  });

  it('flags a custom-resource GetAtt and a secret-looking attribute as secure', async () => {
    const parent = mk('App', {
      resources: { Cr: { Type: 'Custom::Thing' }, Sec: { Type: 'AWS::SecretsManager::Secret' }, Q: { Type: 'AWS::SQS::Queue' } },
    });
    const child = mk('App~I', {
      parent,
      logicalId: 'I',
      parameters: {
        C: { 'Fn::GetAtt': ['Cr', 'Out'] },
        S: { 'Fn::GetAtt': ['Sec', 'SecretString'] },
        N: { Ref: 'Q' },
      },
    });
    const provider = fakeProvider({
      Cr: { physicalId: 'cr', resourceType: 'Custom::Thing', attributes: { Out: 'v' } },
      Sec: { physicalId: 'sec', resourceType: 'AWS::SecretsManager::Secret', attributes: { SecretString: 's' } },
      Q,
    });
    const out = await resolveNestedStackParameters(child, parent, provider);
    expect(out.values['C']).toBe('v');
    expect(out.secureStringLogicalIds.sort()).toEqual(['C', 'S']);
  });

  it("feeds the parent's SSM parameters into a Ref to a parent parameter", async () => {
    const parent = mk('App');
    const child = mk('App~I', { parent, logicalId: 'I', parameters: { P: { Ref: 'ParentParam' } } });
    const provider = fakeProvider({}, async () => ({
      values: { ParentParam: 'ssm-value' },
      secureStringLogicalIds: [],
    }));
    const out = await resolveNestedStackParameters(child, parent, provider);
    expect(out.values).toEqual({ P: 'ssm-value' });
  });

  it('returns empty when the nested stack has no parameters', async () => {
    const parent = mk('App');
    const child = mk('App~I', { parent, logicalId: 'I' });
    const provider = fakeProvider({});
    const out = await resolveNestedStackParameters(child, parent, provider);
    expect(out).toEqual({ values: {}, secureStringLogicalIds: [] });
    expect(provider.load).not.toHaveBeenCalled();
  });
});

describe('withNestedStackParameters', () => {
  afterEach(() => resetNestedStackRegistry());

  it('merges parent-derived values for the child template only; caches and disposes the parent', async () => {
    const parent = mk('App', { resources: { Q: { Type: 'AWS::SQS::Queue' } } });
    const child = mk('App~I', { parent, logicalId: 'I', parameters: { P1: { Ref: 'Q' } } });
    const inner = fakeProvider({}, async () => ({ values: { Own: 'o' }, secureStringLogicalIds: ['Own'] }));
    const parentProvider = fakeProvider({ Q });
    const factory = vi.fn(() => parentProvider);

    const innerDispose = inner.dispose;
    const wrapped = withNestedStackParameters(inner, child, parent, factory);
    const first = await wrapped.resolveTemplateSsmParameters!(child.template);
    expect(first.values).toEqual({ P1: 'q-url', Own: 'o' });
    expect(first.secureStringLogicalIds).toEqual(['Own']);

    const other = await wrapped.resolveTemplateSsmParameters!({ Resources: {} });
    expect(other.values).toEqual({ Own: 'o' });

    await wrapped.resolveTemplateSsmParameters!(child.template);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(parentProvider.load).toHaveBeenCalledTimes(1);

    wrapped.dispose();
    expect(parentProvider.dispose).toHaveBeenCalledTimes(1);
    expect(innerDispose).toHaveBeenCalledTimes(1);
  });

  it('works when the inner provider has no resolveTemplateSsmParameters', async () => {
    const parent = mk('App', { resources: { Q: { Type: 'AWS::SQS::Queue' } } });
    const child = mk('App~I', { parent, logicalId: 'I', parameters: { P1: { Ref: 'Q' } } });
    const wrapped = withNestedStackParameters(fakeProvider({}), child, parent, () => fakeProvider({ Q }));
    expect((await wrapped.resolveTemplateSsmParameters!(child.template)).values).toEqual({ P1: 'q-url' });
  });
});
