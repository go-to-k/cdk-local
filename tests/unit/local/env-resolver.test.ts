import { describe, it, expect } from 'vite-plus/test';
import {
  resolveEnvVars,
  type EnvOverrideFile,
} from '../../../src/local/env-resolver.js';

const LOGICAL = 'MyHandler1234ABCD';
// The full L1 form CDK encodes into `Metadata['aws:cdk:path']`.
const L1_PATH = 'MyStack/MyHandler/Resource';
// The L2 construct path the user actually reads from CDK app code, and
// the same form `cdkl invoke` accepts as a target.
const L2_PATH = 'MyStack/MyHandler';
const L1_NESTED_PATH = 'MyStack/Nested/MyHandler/Resource';
const L2_NESTED_PATH = 'MyStack/Nested/MyHandler';

describe('resolveEnvVars', () => {
  describe('template-only path (no overrides)', () => {
    it('returns literal string / number / boolean values coerced to string', () => {
      const result = resolveEnvVars(LOGICAL, L1_PATH, {
        STR: 'hello',
        NUM: 42,
        BOOL: true,
      });
      expect(result.resolved).toEqual({ STR: 'hello', NUM: '42', BOOL: 'true' });
      expect(result.unresolved).toEqual([]);
    });

    it('drops intrinsic-valued entries and records them in `unresolved`', () => {
      const result = resolveEnvVars(LOGICAL, L1_PATH, {
        LITERAL: 'ok',
        TABLE: { Ref: 'MyTable' },
        ARN: { 'Fn::GetAtt': ['MyTable', 'Arn'] },
      });
      expect(result.resolved).toEqual({ LITERAL: 'ok' });
      expect(result.unresolved.sort()).toEqual(['ARN', 'TABLE']);
    });

    it('returns empty maps when templateEnv is undefined', () => {
      const result = resolveEnvVars(LOGICAL, L1_PATH, undefined);
      expect(result.resolved).toEqual({});
      expect(result.unresolved).toEqual([]);
    });
  });

  describe('--env-vars: Parameters (global) overlay', () => {
    it('applies Parameters on top of templateEnv', () => {
      const overrides: EnvOverrideFile = {
        Parameters: { GLOBAL: 'on', LITERAL: 'overridden' },
      };
      const result = resolveEnvVars(LOGICAL, L1_PATH, { LITERAL: 'template' }, overrides);
      expect(result.resolved).toEqual({ LITERAL: 'overridden', GLOBAL: 'on' });
    });

    it('null in Parameters clears a templateEnv-supplied key (SAM-compat)', () => {
      const overrides: EnvOverrideFile = { Parameters: { LITERAL: null } };
      const result = resolveEnvVars(
        LOGICAL,
        L1_PATH,
        { LITERAL: 'template', KEEP: 'k' },
        overrides
      );
      expect(result.resolved).toEqual({ KEEP: 'k' });
    });
  });

  describe('--env-vars: function-specific entry — logical-ID key', () => {
    it('applies the logical-ID-keyed map on top of Parameters', () => {
      const overrides: EnvOverrideFile = {
        Parameters: { LITERAL: 'global', GLOBAL: 'g' },
        [LOGICAL]: { LITERAL: 'fn-specific', FN_ONLY: 'f' },
      };
      const result = resolveEnvVars(LOGICAL, L1_PATH, { LITERAL: 'template' }, overrides);
      expect(result.resolved).toEqual({ LITERAL: 'fn-specific', GLOBAL: 'g', FN_ONLY: 'f' });
    });

    it('does not match a different logical ID', () => {
      const overrides: EnvOverrideFile = {
        OtherFn99: { FN_ONLY: 'should-not-apply' },
      };
      const result = resolveEnvVars(LOGICAL, L1_PATH, { LITERAL: 'template' }, overrides);
      expect(result.resolved).toEqual({ LITERAL: 'template' });
    });

    it('substitutes the template intrinsic with an override when provided', () => {
      // Common workflow: template has an intrinsic-valued env, user supplies a
      // literal via --env-vars to make it concrete for local invoke.
      const result = resolveEnvVars(
        LOGICAL,
        L1_PATH,
        { TABLE_NAME: { Ref: 'MyTable' } },
        { [LOGICAL]: { TABLE_NAME: 'literal-table' } }
      );
      expect(result.resolved).toEqual({ TABLE_NAME: 'literal-table' });
      // Still reported as unresolved at the template level so the caller can
      // decide whether to warn; the override's success is observable via
      // `resolved`.
      expect(result.unresolved).toEqual(['TABLE_NAME']);
    });
  });

  describe('--env-vars: function-specific entry — display-path key (issue #27)', () => {
    it('matches the exact L1 metadata path', () => {
      const overrides: EnvOverrideFile = {
        [L1_PATH]: { LITERAL: 'fn-specific', FN_ONLY: 'f' },
      };
      const result = resolveEnvVars(LOGICAL, L1_PATH, { LITERAL: 'template' }, overrides);
      expect(result.resolved).toEqual({ LITERAL: 'fn-specific', FN_ONLY: 'f' });
    });

    it('matches the L2 construct path (prefix of the L1 metadata path)', () => {
      // This is the natural form the user reads from CDK app code and the
      // same shape `cdkl invoke` accepts as a target.
      const overrides: EnvOverrideFile = {
        [L2_PATH]: { LITERAL: 'fn-specific', FN_ONLY: 'f' },
      };
      const result = resolveEnvVars(LOGICAL, L1_PATH, { LITERAL: 'template' }, overrides);
      expect(result.resolved).toEqual({ LITERAL: 'fn-specific', FN_ONLY: 'f' });
    });

    it('matches a nested-stack L2 construct path', () => {
      const overrides: EnvOverrideFile = {
        [L2_NESTED_PATH]: { NESTED_ONLY: 'on' },
      };
      const result = resolveEnvVars(LOGICAL, L1_NESTED_PATH, undefined, overrides);
      expect(result.resolved).toEqual({ NESTED_ONLY: 'on' });
    });

    it('matches a parent stack path (prefix applies to every function under it)', () => {
      // Key `MyStack` is a prefix of `MyStack/MyHandler/Resource` so the
      // override fires; this lets a user set a stack-wide override without
      // listing every function (same UX as `Parameters` scoped to one
      // stack).
      const overrides: EnvOverrideFile = {
        MyStack: { STACK_WIDE: 'yes' },
      };
      const result = resolveEnvVars(LOGICAL, L1_PATH, undefined, overrides);
      expect(result.resolved).toEqual({ STACK_WIDE: 'yes' });
    });

    it('display-path key with null clears a templateEnv-supplied key', () => {
      const overrides: EnvOverrideFile = { [L2_PATH]: { LITERAL: null } };
      const result = resolveEnvVars(
        LOGICAL,
        L1_PATH,
        { LITERAL: 'template', KEEP: 'k' },
        overrides
      );
      expect(result.resolved).toEqual({ KEEP: 'k' });
    });

    it('does not partial-match within a path segment (no false positive on siblings)', () => {
      // displayPath `MyStack/MyHandlerBackup/Resource` shares a string
      // prefix with the key `MyStack/MyHandler`, but the prefix rule
      // requires a `/` boundary — so this MUST NOT match. Without the
      // `${key}/` slash boundary `MyHandler` would erroneously match
      // `MyHandlerBackup`.
      const overrides: EnvOverrideFile = {
        [L2_PATH]: { FN_ONLY: 'should-not-apply' },
      };
      const result = resolveEnvVars(
        LOGICAL,
        'MyStack/MyHandlerBackup/Resource',
        { LITERAL: 'template' },
        overrides
      );
      expect(result.resolved).toEqual({ LITERAL: 'template' });
    });

    it('does not match a different display path', () => {
      const overrides: EnvOverrideFile = {
        'OtherStack/OtherHandler': { FN_ONLY: 'should-not-apply' },
      };
      const result = resolveEnvVars(LOGICAL, L1_PATH, { LITERAL: 'template' }, overrides);
      expect(result.resolved).toEqual({ LITERAL: 'template' });
    });

    it('skips the display-path lookup when displayPath is undefined', () => {
      const overrides: EnvOverrideFile = {
        [L2_PATH]: { FN_ONLY: 'should-not-apply' },
      };
      const result = resolveEnvVars(LOGICAL, undefined, { LITERAL: 'template' }, overrides);
      expect(result.resolved).toEqual({ LITERAL: 'template' });
    });
  });

  describe('--env-vars: conflict resolution between logical-ID and display-path keys', () => {
    it('applies later JSON insertion wins (display path after logical ID)', () => {
      const overrides: EnvOverrideFile = {
        [LOGICAL]: { LITERAL: 'from-logical-id' },
        [L2_PATH]: { LITERAL: 'from-display-path' },
      };
      const result = resolveEnvVars(LOGICAL, L1_PATH, undefined, overrides);
      expect(result.resolved).toEqual({ LITERAL: 'from-display-path' });
    });

    it('applies later JSON insertion wins (logical ID after display path)', () => {
      const overrides: EnvOverrideFile = {
        [L2_PATH]: { LITERAL: 'from-display-path' },
        [LOGICAL]: { LITERAL: 'from-logical-id' },
      };
      const result = resolveEnvVars(LOGICAL, L1_PATH, undefined, overrides);
      expect(result.resolved).toEqual({ LITERAL: 'from-logical-id' });
    });

    it('merges non-conflicting keys from both forms', () => {
      const overrides: EnvOverrideFile = {
        [LOGICAL]: { FROM_LOGICAL: 'L' },
        [L2_PATH]: { FROM_PATH: 'P' },
      };
      const result = resolveEnvVars(LOGICAL, L1_PATH, undefined, overrides);
      expect(result.resolved).toEqual({ FROM_LOGICAL: 'L', FROM_PATH: 'P' });
    });
  });

  describe('--env-vars: misc', () => {
    it('ignores non-object entries (loose-shape tolerance)', () => {
      const overrides = {
        Parameters: { GLOBAL: 'g' },
        [LOGICAL]: 'a-string-not-a-map',
      } as unknown as EnvOverrideFile;
      const result = resolveEnvVars(LOGICAL, L1_PATH, undefined, overrides);
      expect(result.resolved).toEqual({ GLOBAL: 'g' });
    });

    it('Parameters layer applies even when no function-specific key matches', () => {
      const overrides: EnvOverrideFile = {
        Parameters: { GLOBAL: 'g' },
        OtherFn99: { FN_ONLY: 'no-match' },
      };
      const result = resolveEnvVars(LOGICAL, L1_PATH, undefined, overrides);
      expect(result.resolved).toEqual({ GLOBAL: 'g' });
    });
  });
});

// Issue #769: an env var literally named `__proto__` must come out as an OWN
// key of the resolved map. Ordinary assignment on a plain `{}` hits
// Object.prototype's `__proto__` setter and silently drops the variable.
// Inputs are built with JSON.parse, the same way the synthesized template and
// the `--env-vars` file reach this function, so `__proto__` is an own key of
// the input.
describe('resolveEnvVars own-key writes (issue #769)', () => {
  it('keeps a template env var named __proto__ as an own key', () => {
    const templateEnv = JSON.parse('{"__proto__":"from-template","OTHER":"x"}') as Record<
      string,
      unknown
    >;
    const result = resolveEnvVars(LOGICAL, L1_PATH, templateEnv);
    expect(Object.hasOwn(result.resolved, '__proto__')).toBe(true);
    expect(result.resolved['__proto__']).toBe('from-template');
    expect(Object.keys(result.resolved)).toEqual(['__proto__', 'OTHER']);
    // The resolved map's prototype is untouched.
    expect(Object.getPrototypeOf(result.resolved)).toBe(Object.prototype);
  });

  it('keeps a global --env-vars Parameters entry named __proto__ as an own key', () => {
    const overrides = JSON.parse(
      '{"Parameters":{"__proto__":"from-parameters"}}'
    ) as EnvOverrideFile;
    const result = resolveEnvVars(LOGICAL, L1_PATH, { A: '1' }, overrides);
    expect(Object.hasOwn(result.resolved, '__proto__')).toBe(true);
    expect(result.resolved['__proto__']).toBe('from-parameters');
    expect(result.resolved['A']).toBe('1');
    expect(Object.getPrototypeOf(result.resolved)).toBe(Object.prototype);
  });

  it('keeps a function-specific --env-vars entry named __proto__ as an own key', () => {
    const overrides = JSON.parse(
      `{"${LOGICAL}":{"__proto__":"by-logical-id"},"${L2_PATH}":{"__proto__":"by-display-path"}}`
    ) as EnvOverrideFile;
    const result = resolveEnvVars(LOGICAL, L1_PATH, undefined, overrides);
    expect(Object.hasOwn(result.resolved, '__proto__')).toBe(true);
    // Later key wins (JSON insertion order), same as any other key.
    expect(result.resolved['__proto__']).toBe('by-display-path');
  });

  it('lets an --env-vars override replace a template __proto__ and a null clear it', () => {
    const templateEnv = JSON.parse('{"__proto__":"from-template"}') as Record<string, unknown>;
    const replaced = resolveEnvVars(
      LOGICAL,
      L1_PATH,
      templateEnv,
      JSON.parse('{"Parameters":{"__proto__":"override"}}') as EnvOverrideFile
    );
    expect(replaced.resolved['__proto__']).toBe('override');
    expect(Object.hasOwn(replaced.resolved, '__proto__')).toBe(true);

    const cleared = resolveEnvVars(
      LOGICAL,
      L1_PATH,
      templateEnv,
      JSON.parse('{"Parameters":{"__proto__":null}}') as EnvOverrideFile
    );
    expect(Object.hasOwn(cleared.resolved, '__proto__')).toBe(false);
    expect(Object.getPrototypeOf(cleared.resolved)).toBe(Object.prototype);
  });

  it('negative control: ordinary keys resolve exactly as before', () => {
    const result = resolveEnvVars(
      LOGICAL,
      L1_PATH,
      { A: 'a', N: 1 },
      { Parameters: { B: 'b' }, [LOGICAL]: { A: 'a2', C: null } }
    );
    expect(result.resolved).toEqual({ A: 'a2', N: '1', B: 'b' });
    expect(Object.getOwnPropertyDescriptor(result.resolved, 'A')).toEqual({
      value: 'a2',
      writable: true,
      enumerable: true,
      configurable: true,
    });
  });
});
