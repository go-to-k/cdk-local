import { describe, it, expect } from 'vite-plus/test';
import { pickTargetStacks } from '../../../src/cli/commands/local-start-api.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

function stack(name: string): StackInfo {
  return {
    stackName: name,
    template: { Resources: {} },
  } as unknown as StackInfo;
}

describe('pickTargetStacks', () => {
  const A = stack('A');
  const B = stack('B');

  describe('single-stack app', () => {
    it('auto-picks the only stack when --stack is omitted', () => {
      expect(pickTargetStacks([A], undefined)).toEqual([A]);
    });
  });

  describe('--stack pattern (explicit)', () => {
    it('matches by stack name', () => {
      expect(pickTargetStacks([A, B], 'A')).toEqual([A]);
    });

    it('wins over a --from-cfn-stack fallback (CFn fallback only fires when --stack is omitted)', () => {
      expect(pickTargetStacks([A, B], 'A', 'B')).toEqual([A]);
    });

    it('returns empty when no stack matches the pattern', () => {
      expect(pickTargetStacks([A, B], 'Other')).toEqual([]);
    });
  });

  describe('--from-cfn-stack fallback', () => {
    it('disambiguates a multi-stack app when its value matches a stack name', () => {
      expect(pickTargetStacks([A, B], undefined, 'B')).toEqual([B]);
    });

    it('returns empty when the CFn stack name does not match any synth stack (caller surfaces a clearer error)', () => {
      expect(pickTargetStacks([A, B], undefined, 'Other')).toEqual([]);
    });

    it('is ignored when undefined (bare --from-cfn-stack flag => the regular multi-stack rejection still fires)', () => {
      expect(() => pickTargetStacks([A, B], undefined, undefined)).toThrowError(
        /Multi-stack app/
      );
    });
  });

  describe('error message', () => {
    it('lists every available stack name and mentions --from-cfn-stack as an alternative', () => {
      expect(() => pickTargetStacks([A, B], undefined)).toThrowError(
        /Multi-stack app: pass --stack <name> \(or --from-cfn-stack <name>\) to pick a target\. Available stacks: A, B\./
      );
    });
  });
});
