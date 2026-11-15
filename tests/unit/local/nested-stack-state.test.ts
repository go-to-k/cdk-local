import { describe, it, expect, vi, afterEach, beforeEach } from 'vite-plus/test';
import {
  nestedStackChain,
  resolveNestedStackParameters,
  withNestedStackParameters,
} from '../../../src/local/nested-stack-state.js';
import {
  expandNestedStacks,
  registerNestedStacks,
  resetNestedStackRegistry,
} from '../../../src/synthesis/nested-stacks.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('resolveNestedStackParameters secret marking', () => {
  const sensitive = async (
    parentResources: Record<string, unknown>,
    stateResources: Record<string, unknown>,
    value: unknown,
    provider?: LocalStateProvider
  ) => {
    const parent = mk('App', { resources: parentResources });
    const child = mk('App~I', { parent, logicalId: 'I', parameters: { P: value } });
    return resolveNestedStackParameters(child, parent, provider ?? fakeProvider(stateResources));
  };

  it('marks a GetAtt of a parent AWS::CloudFormation::Stack Outputs.X', async () => {
    const out = await sensitive(
      { Sub: { Type: 'AWS::CloudFormation::Stack' } },
      {
        Sub: {
          physicalId: 'arn:sub',
          resourceType: 'AWS::CloudFormation::Stack',
          attributes: { 'Outputs.X': 'plain' },
        },
      },
      { 'Fn::GetAtt': ['Sub', 'Outputs.X'] }
    );
    expect(out.values['P']).toBe('plain');
    expect(out.secureStringLogicalIds).toEqual(['P']);
  });

  it('marks a GetAtt of a parent AWS::CloudFormation::Stack attribute that is not Outputs.* too', async () => {
    const out = await sensitive(
      { Sub: { Type: 'AWS::CloudFormation::Stack' } },
      {
        Sub: {
          physicalId: 'arn:sub',
          resourceType: 'AWS::CloudFormation::Stack',
          attributes: { Other: 'plain' },
        },
      },
      { 'Fn::GetAtt': ['Sub', 'Other'] }
    );
    expect(out.secureStringLogicalIds).toEqual(['P']);
  });

  it('marks a Ref to a parent NoEcho parameter (only the deployedFillMayBeSecret arm sees it)', async () => {
    const parent = mk('App');
    (parent.template as { Parameters?: unknown }).Parameters = {
      Pw: { Type: 'String', NoEcho: true },
    };
    const child = mk('App~I', { parent, logicalId: 'I', parameters: { P: { Ref: 'Pw' } } });
    const provider = fakeProvider({}, async () => ({ values: { Pw: 'pw' }, secureStringLogicalIds: [] }));
    const out = await resolveNestedStackParameters(child, parent, provider);
    expect(out.values['P']).toBe('pw');
    expect(out.secureStringLogicalIds).toEqual(['P']);
  });

  it('marks a value containing a {{resolve:secretsmanager:...}} dynamic reference', async () => {
    const out = await sensitive({}, {}, 'pre-{{resolve:secretsmanager:my/secret:SecretString:pw}}');
    expect(out.secureStringLogicalIds).toEqual(['P']);
  });

  it('marks a Ref to an AWS::AppSync::ApiKey', async () => {
    const out = await sensitive(
      { Key: { Type: 'AWS::AppSync::ApiKey' } },
      { Key: { physicalId: 'da2-key', resourceType: 'AWS::AppSync::ApiKey', attributes: {} } },
      { Ref: 'Key' }
    );
    expect(out.values['P']).toBe('da2-key');
    expect(out.secureStringLogicalIds).toEqual(['P']);
  });

  it("marks a Ref to a parent SecureString parameter from the parent provider's resolveTemplateSsmParameters", async () => {
    const provider = fakeProvider({}, async () => ({
      values: { Sec: 'hunter2', Plain: 'x' },
      secureStringLogicalIds: ['Sec'],
    }));
    const parent = mk('App');
    const child = mk('App~I', {
      parent,
      logicalId: 'I',
      parameters: { A: { Ref: 'Sec' }, B: { Ref: 'Plain' } },
    });
    const out = await resolveNestedStackParameters(child, parent, provider);
    expect(out.values).toEqual({ A: 'hunter2', B: 'x' });
    expect(out.secureStringLogicalIds).toEqual(['A']);
  });

  it('marks GetAtt AccessKey.SecretAccessKey (the deployedFillMayBeSecret arm)', async () => {
    const out = await sensitive(
      { Key: { Type: 'AWS::IAM::AccessKey' } },
      {
        Key: {
          physicalId: 'AKIA',
          resourceType: 'AWS::IAM::AccessKey',
          attributes: { SecretAccessKey: 'abc' },
        },
      },
      { 'Fn::GetAtt': ['Key', 'SecretAccessKey'] }
    );
    expect(out.values['P']).toBe('abc');
    expect(out.secureStringLogicalIds).toEqual(['P']);
  });

  it('leaves a value that resolves to the *** mask out of values (warned as unresolved)', async () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const out = await sensitive(
      { Cr: { Type: 'Custom::Thing' } },
      { Cr: { physicalId: 'cr', resourceType: 'Custom::Thing', attributes: { Out: '***' } } },
      { 'Fn::GetAtt': ['Cr', 'Out'] }
    );
    expect(out.values).not.toHaveProperty('P');
    expect(out.secureStringLogicalIds).toEqual([]);
    expect(String(warn.mock.calls[0]![0])).toContain('P');
    warn.mockRestore();
  });
});


describe('withNestedStackParameters', () => {
  let dir: string;
  beforeEach(() => {
    resetNestedStackRegistry();
    dir = mkdtempSync(join(tmpdir(), 'cdkl-nsp-'));
  });
  afterEach(() => {
    resetNestedStackRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  function parentOnDisk(displayName: string, param: unknown): StackInfo {
    writeFileSync(join(dir, 'Inner.nested.template.json'), JSON.stringify({ Resources: {} }));
    return {
      stackName: 'App',
      displayName,
      artifactId: 'App',
      template: {
        Resources: {
          InnerNS: {
            Type: 'AWS::CloudFormation::Stack',
            Properties: { Parameters: { P1: param } },
            Metadata: {
              'aws:cdk:path': `${displayName}/Inner.NestedStack/Inner.NestedStackResource`,
              'aws:asset:path': 'Inner.nested.template.json',
            },
          },
        },
      },
      assetManifestPath: join(dir, 'App.assets.json'),
      assetOutdir: dir,
      region: 'us-east-1',
      dependencyNames: [],
    } as unknown as StackInfo;
  }

  it('merges parent-derived values for the child template only; caches and disposes the parent', async () => {
    const parent = mk('App', { resources: { Q: { Type: 'AWS::SQS::Queue' } } });
    const child = mk('App~I', { parent, logicalId: 'I', parameters: { P1: { Ref: 'Q' } } });
    registerNestedStacks([parent, child]);
    const inner = fakeProvider({}, async () => ({ values: { Own: 'o' }, secureStringLogicalIds: ['Own'] }));
    const parentProvider = fakeProvider({ Q });
    const factory = vi.fn(() => parentProvider);

    const innerDispose = inner.dispose;
    const wrapped = withNestedStackParameters(inner, 'App~I', factory);
    const first = await wrapped.resolveTemplateSsmParameters!(child.template);
    expect(first.values).toEqual({ P1: 'q-url', Own: 'o' });
    expect(first.secureStringLogicalIds).toEqual(['Own']);
    expect(factory).toHaveBeenCalledWith(parent);

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
    registerNestedStacks([parent, child]);
    const wrapped = withNestedStackParameters(fakeProvider({}), 'App~I', () => fakeProvider({ Q }));
    expect((await wrapped.resolveTemplateSsmParameters!(child.template)).values).toEqual({ P1: 'q-url' });
  });

  it("keeps the nested stack's secureStringLogicalIds through the merge", async () => {
    const parent = mk('App', { resources: { Cr: { Type: 'Custom::Thing' } } });
    const child = mk('App~I', {
      parent,
      logicalId: 'I',
      parameters: { P1: { 'Fn::GetAtt': ['Cr', 'Out'] } },
    });
    registerNestedStacks([parent, child]);
    const wrapped = withNestedStackParameters(
      fakeProvider({}, async () => ({ values: {}, secureStringLogicalIds: ['Own'] })),
      'App~I',
      () =>
        fakeProvider({ Cr: { physicalId: 'cr', resourceType: 'Custom::Thing', attributes: { Out: 'v' } } })
    );
    const out = await wrapped.resolveTemplateSsmParameters!(child.template);
    expect(out.values['P1']).toBe('v');
    expect([...out.secureStringLogicalIds].sort()).toEqual(['Own', 'P1']);
  });

  it('picks the stack by template identity among two clones sharing a stackName', async () => {
    const beta = parentOnDisk('Beta/App', { Ref: 'QBeta' });
    const prod = parentOnDisk('Prod/App', { Ref: 'QProd' });
    const out = expandNestedStacks([beta, prod]);
    const [betaChild, prodChild] = [out[1]!, out[3]!];
    expect(betaChild.stackName).toBe(prodChild.stackName);
    expect(betaChild.displayName).toBe('Beta/App/Inner');
    expect(prodChild.displayName).toBe('Prod/App/Inner');
    expect(betaChild.template).not.toBe(prodChild.template);

    const state = {
      QBeta: { physicalId: 'beta-q', resourceType: 'AWS::SQS::Queue', attributes: {} },
      QProd: { physicalId: 'prod-q', resourceType: 'AWS::SQS::Queue', attributes: {} },
    };
    const factory = vi.fn(() => fakeProvider(state));
    const wrapped = withNestedStackParameters(fakeProvider({}), betaChild.stackName, factory);
    expect((await wrapped.resolveTemplateSsmParameters!(betaChild.template)).values).toEqual({ P1: 'beta-q' });
    expect((await wrapped.resolveTemplateSsmParameters!(prodChild.template)).values).toEqual({ P1: 'prod-q' });
    // The parent provider is per parent NAME: both clones share the one.
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('recomputes for a reloaded (different) template object', async () => {
    const first = expandNestedStacks([parentOnDisk('App', { Ref: 'Q1' })]);
    const firstChild = first[1]!;
    const state = {
      Q1: { physicalId: 'q-one', resourceType: 'AWS::SQS::Queue', attributes: {} },
      Q2: { physicalId: 'q-two', resourceType: 'AWS::SQS::Queue', attributes: {} },
    };
    const parentProvider = fakeProvider(state);
    const wrapped = withNestedStackParameters(fakeProvider({}), firstChild.stackName, () => parentProvider);
    expect((await wrapped.resolveTemplateSsmParameters!(firstChild.template)).values).toEqual({ P1: 'q-one' });
    expect(parentProvider.load).toHaveBeenCalledTimes(1);

    // A `--watch` reload: the same names, new objects, a changed parameter.
    const second = expandNestedStacks([parentOnDisk('App', { Ref: 'Q2' })]);
    const secondChild = second[1]!;
    expect(secondChild.template).not.toBe(firstChild.template);
    expect((await wrapped.resolveTemplateSsmParameters!(secondChild.template)).values).toEqual({ P1: 'q-two' });
    expect(parentProvider.load).toHaveBeenCalledTimes(2);
    // The stale template no longer matches a registered stack: own result only.
    expect((await wrapped.resolveTemplateSsmParameters!(firstChild.template)).values).toEqual({});
  });
});
