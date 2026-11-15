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
