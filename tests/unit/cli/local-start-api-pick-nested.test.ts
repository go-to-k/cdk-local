import { describe, it, expect } from 'vite-plus/test';
import { pickTargetStacks } from '../../../src/cli/commands/local-start-api.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

function stack(name: string, nestedOf?: string): StackInfo {
  return {
    stackName: name,
    displayName: name,
    template: { Resources: {} },
    ...(nestedOf && {
      nestedStack: { parentStackName: nestedOf, rootStackName: nestedOf, logicalId: 'Inner', parameters: {} },
    }),
  } as unknown as StackInfo;
}

describe('pickTargetStacks with nested stacks', () => {
  const App = stack('App');
  const Inner = stack('App~Inner', 'App');
  const B = stack('B');

  it('single top-level stack auto-picks it together with its nested child', () => {
    expect(pickTargetStacks([App, Inner], undefined)).toEqual([App, Inner]);
  });

  it('pattern selects the stack and its nested child', () => {
    expect(pickTargetStacks([App, Inner], 'App')).toEqual([App, Inner]);
  });

  it('a StackInfo targetFallback selects the child plus its descendants', () => {
    const Deeper = stack('App~Inner~Deep', 'App~Inner');
    expect(pickTargetStacks([App, Inner, Deeper], undefined, undefined, Inner)).toEqual([Inner, Deeper]);
  });

  it('two top-level stacks with no selector throws, listing top-level only', () => {
    let message = '';
    try {
      pickTargetStacks([App, Inner, B], undefined);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/Multi-stack app/);
    const available = message.split('Available stacks:')[1]!;
    expect(available).toContain('App');
    expect(available).toContain('B');
    expect(available).not.toContain('App~Inner');
  });
});
