import { describe, it, expect } from 'vite-plus/test';
import { matchStacks, selectTargetStack } from '../../../src/cli/stack-matcher.js';
import { parseTarget } from '../../../src/local/lambda-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

function top(name: string): StackInfo {
  return { stackName: name, displayName: name, template: { Resources: {} } } as unknown as StackInfo;
}
function child(parent: StackInfo, logicalId: string, display: string): StackInfo {
  return {
    stackName: `${parent.stackName}~${logicalId}`,
    displayName: display,
    template: { Resources: {} },
    nestedStack: {
      parentStackName: parent.stackName,
      rootStackName: parent.nestedStack?.rootStackName ?? parent.stackName,
      logicalId,
      parameters: {},
    },
  } as unknown as StackInfo;
}

describe('selectTargetStack with nested stacks', () => {
  const App = top('App');
  const Inner = child(App, 'InnerNS', 'App/Inner');
  const stacks = [App, Inner];

  it('prefix-less target: one top-level stack plus its nested child is found top-level', () => {
    const sel = selectTargetStack(parseTarget('Fn'), 'Fn', stacks);
    expect(sel).toEqual({ kind: 'found', stack: App });
  });

  it('prefix-less target with two top-level stacks is no-prefix', () => {
    const sel = selectTargetStack(parseTarget('Fn'), 'Fn', [App, Inner, top('B')]);
    expect(sel.kind).toBe('no-prefix');
  });

  it("colon form 'App:X' finds App, not ambiguous", () => {
    const sel = selectTargetStack(parseTarget('App:X'), 'App:X', stacks);
    expect(sel).toEqual({ kind: 'found', stack: App });
  });

  it("path form 'App/Inner/Fn' picks the nested child (longest prefix)", () => {
    const sel = selectTargetStack(parseTarget('App/Inner/Fn'), 'App/Inner/Fn', stacks);
    expect(sel).toEqual({ kind: 'found', stack: Inner });
  });
});

describe('matchStacks with nested stacks', () => {
  const App = top('App');
  const Inner = child(App, 'InnerNS', 'App/Inner');
  const Deeper = child(Inner, 'DeeperNS', 'App/Inner/Deeper');
  const Other = top('Other');
  const all = [App, Inner, Deeper, Other];

  it('a top-level pattern selects the stack plus all descendants', () => {
    expect(matchStacks(all, ['App'])).toEqual([App, Inner, Deeper]);
  });

  it('a pattern matching only a nested display path selects it plus its descendants', () => {
    expect(matchStacks(all, ['App/Inner'])).toEqual([Inner, Deeper]);
  });

  it('empty patterns select nothing', () => {
    expect(matchStacks(all, [])).toEqual([]);
  });
});

describe('selectTargetStack: a logical ID that lives only in a nested stack (#986)', () => {
  const withTemplate = (s: StackInfo, ids: string[]): StackInfo =>
    ({
      ...s,
      template: { Resources: Object.fromEntries(ids.map((i) => [i, { Type: 'AWS::SQS::Queue' }])) },
    }) as unknown as StackInfo;

  it("colon form 'App:<id only in nested>' selects the nested stack", () => {
    const App = withTemplate(top('App'), ['Own']);
    const Inner = withTemplate(child(App, 'InnerNS', 'App/Inner'), ['OnlyInner']);
    const sel = selectTargetStack(parseTarget('App:OnlyInner'), 'App:OnlyInner', [App, Inner]);
    expect(sel).toEqual({ kind: 'found', stack: Inner });
  });

  it('an id the stack itself has stays on the stack', () => {
    const App = withTemplate(top('App'), ['Both']);
    const Inner = withTemplate(child(App, 'InnerNS', 'App/Inner'), ['Both']);
    const sel = selectTargetStack(parseTarget('App:Both'), 'App:Both', [App, Inner]);
    expect(sel).toEqual({ kind: 'found', stack: App });
  });

  it('an id in TWO nested stacks stays on the parent (ambiguous: no pick)', () => {
    const App = withTemplate(top('App'), ['Own']);
    const I1 = withTemplate(child(App, 'I1', 'App/I1'), ['Dup']);
    const I2 = withTemplate(child(App, 'I2', 'App/I2'), ['Dup']);
    const sel = selectTargetStack(parseTarget('App:Dup'), 'App:Dup', [App, I1, I2]);
    expect(sel).toEqual({ kind: 'found', stack: App });
  });

  it('a StackLike without a template behaves as before', () => {
    const App = top('App');
    const Inner = child(App, 'InnerNS', 'App/Inner');
    delete (App as { template?: unknown }).template;
    delete (Inner as { template?: unknown }).template;
    const sel = selectTargetStack(parseTarget('App:OnlyInner'), 'App:OnlyInner', [App, Inner]);
    expect(sel).toEqual({ kind: 'found', stack: App });
  });
});
