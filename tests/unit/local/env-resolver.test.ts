import { describe, it, expect } from 'vite-plus/test';
import {
  resolveEnvVars,
  type EnvOverrideFile,
} from '../../../src/local/env-resolver.js';

const LOGICAL = 'MyHandler1234ABCD';
const PATH = 'MyStack/MyHandler';
const NESTED_PATH = 'MyStack/Nested/MyHandler';

describe('resolveEnvVars', () => {
  describe('template-only path (no overrides)', () => {
    it('returns literal string / number / boolean values coerced to string', () => {
      const result = resolveEnvVars(LOGICAL, PATH, {
        STR: 'hello',
        NUM: 42,
        BOOL: true,
      });
      expect(result.resolved).toEqual({ STR: 'hello', NUM: '42', BOOL: 'true' });
      expect(result.unresolved).toEqual([]);
    });

    it('drops intrinsic-valued entries and records them in `unresolved`', () => {
      const result = resolveEnvVars(LOGICAL, PATH, {
        LITERAL: 'ok',
        TABLE: { Ref: 'MyTable' },
        ARN: { 'Fn::GetAtt': ['MyTable', 'Arn'] },
      });
      expect(result.resolved).toEqual({ LITERAL: 'ok' });
      expect(result.unresolved.sort()).toEqual(['ARN', 'TABLE']);
    });

    it('returns empty maps when templateEnv is undefined', () => {
      const result = resolveEnvVars(LOGICAL, PATH, undefined);
      expect(result.resolved).toEqual({});
      expect(result.unresolved).toEqual([]);
    });
  });

  describe('--env-vars: Parameters (global) overlay', () => {
    it('applies Parameters on top of templateEnv', () => {
      const overrides: EnvOverrideFile = {
        Parameters: { GLOBAL: 'on', LITERAL: 'overridden' },
      };
      const result = resolveEnvVars(LOGICAL, PATH, { LITERAL: 'template' }, overrides);
      expect(result.resolved).toEqual({ LITERAL: 'overridden', GLOBAL: 'on' });
    });

    it('null in Parameters clears a templateEnv-supplied key (SAM-compat)', () => {
      const overrides: EnvOverrideFile = { Parameters: { LITERAL: null } };
      const result = resolveEnvVars(LOGICAL, PATH, { LITERAL: 'template', KEEP: 'k' }, overrides);
      expect(result.resolved).toEqual({ KEEP: 'k' });
    });
  });

  describe('--env-vars: function-specific entry — logical-ID key', () => {
    it('applies the logical-ID-keyed map on top of Parameters', () => {
      const overrides: EnvOverrideFile = {
        Parameters: { LITERAL: 'global', GLOBAL: 'g' },
        [LOGICAL]: { LITERAL: 'fn-specific', FN_ONLY: 'f' },
      };
      const result = resolveEnvVars(LOGICAL, PATH, { LITERAL: 'template' }, overrides);
      expect(result.resolved).toEqual({ LITERAL: 'fn-specific', GLOBAL: 'g', FN_ONLY: 'f' });
    });

    it('does not match a different logical ID', () => {
      const overrides: EnvOverrideFile = {
        OtherFn99: { FN_ONLY: 'should-not-apply' },
      };
      const result = resolveEnvVars(LOGICAL, PATH, { LITERAL: 'template' }, overrides);
      expect(result.resolved).toEqual({ LITERAL: 'template' });
    });
  });

  describe('--env-vars: function-specific entry — display-path key (issue #27)', () => {
    it('applies a top-level display-path-keyed map', () => {
      const overrides: EnvOverrideFile = {
        [PATH]: { LITERAL: 'fn-specific', FN_ONLY: 'f' },
      };
      const result = resolveEnvVars(LOGICAL, PATH, { LITERAL: 'template' }, overrides);
      expect(result.resolved).toEqual({ LITERAL: 'fn-specific', FN_ONLY: 'f' });
    });

    it('applies a nested-stack display path', () => {
      const overrides: EnvOverrideFile = {
        [NESTED_PATH]: { NESTED_ONLY: 'on' },
      };
      const result = resolveEnvVars(LOGICAL, NESTED_PATH, undefined, overrides);
      expect(result.resolved).toEqual({ NESTED_ONLY: 'on' });
    });

    it('display-path key with null clears a templateEnv-supplied key', () => {
      const overrides: EnvOverrideFile = { [PATH]: { LITERAL: null } };
      const result = resolveEnvVars(
        LOGICAL,
        PATH,
        { LITERAL: 'template', KEEP: 'k' },
        overrides
      );
      expect(result.resolved).toEqual({ KEEP: 'k' });
    });

    it('does not match a different display path', () => {
      const overrides: EnvOverrideFile = {
        'OtherStack/OtherHandler': { FN_ONLY: 'should-not-apply' },
      };
      const result = resolveEnvVars(LOGICAL, PATH, { LITERAL: 'template' }, overrides);
      expect(result.resolved).toEqual({ LITERAL: 'template' });
    });

    it('skips the display-path lookup when displayPath is undefined', () => {
      const overrides: EnvOverrideFile = {
        [PATH]: { FN_ONLY: 'should-not-apply' },
      };
      // No display path known for this function — only the logical-ID key
      // would be matched, and there isn't one in this override file.
      const result = resolveEnvVars(LOGICAL, undefined, { LITERAL: 'template' }, overrides);
      expect(result.resolved).toEqual({ LITERAL: 'template' });
    });
  });

  describe('--env-vars: conflict resolution between logical-ID and display-path keys', () => {
    it('applies later JSON insertion wins (display path after logical ID)', () => {
      // JSON insertion order is preserved by Object.entries on a plain
      // object literal; the display-path entry comes after the logical-ID
      // entry, so its value wins.
      const overrides: EnvOverrideFile = {
        [LOGICAL]: { LITERAL: 'from-logical-id' },
        [PATH]: { LITERAL: 'from-display-path' },
      };
      const result = resolveEnvVars(LOGICAL, PATH, undefined, overrides);
      expect(result.resolved).toEqual({ LITERAL: 'from-display-path' });
    });

    it('applies later JSON insertion wins (logical ID after display path)', () => {
      const overrides: EnvOverrideFile = {
        [PATH]: { LITERAL: 'from-display-path' },
        [LOGICAL]: { LITERAL: 'from-logical-id' },
      };
      const result = resolveEnvVars(LOGICAL, PATH, undefined, overrides);
      expect(result.resolved).toEqual({ LITERAL: 'from-logical-id' });
    });

    it('merges non-conflicting keys from both forms', () => {
      const overrides: EnvOverrideFile = {
        [LOGICAL]: { FROM_LOGICAL: 'L' },
        [PATH]: { FROM_PATH: 'P' },
      };
      const result = resolveEnvVars(LOGICAL, PATH, undefined, overrides);
      expect(result.resolved).toEqual({ FROM_LOGICAL: 'L', FROM_PATH: 'P' });
    });

    it('does not double-apply when caller passes the same value for logicalId and displayPath', () => {
      // A defensive caller may fall back to the logical ID when the
      // display path is missing; the resolver dedupes so the map is not
      // applied twice (which would matter if the map's values were
      // computed at resolution time — here it is idempotent, but the
      // contract holds).
      const overrides: EnvOverrideFile = {
        [LOGICAL]: { ONLY: 'applied-once' },
      };
      const result = resolveEnvVars(LOGICAL, LOGICAL, undefined, overrides);
      expect(result.resolved).toEqual({ ONLY: 'applied-once' });
    });
  });

  describe('--env-vars: misc', () => {
    it('ignores non-object entries (loose-shape tolerance)', () => {
      const overrides = {
        Parameters: { GLOBAL: 'g' },
        [LOGICAL]: 'a-string-not-a-map',
      } as unknown as EnvOverrideFile;
      const result = resolveEnvVars(LOGICAL, PATH, undefined, overrides);
      expect(result.resolved).toEqual({ GLOBAL: 'g' });
    });

    it('Parameters layer applies even when no function-specific key matches', () => {
      const overrides: EnvOverrideFile = {
        Parameters: { GLOBAL: 'g' },
        OtherFn99: { FN_ONLY: 'no-match' },
      };
      const result = resolveEnvVars(LOGICAL, PATH, undefined, overrides);
      expect(result.resolved).toEqual({ GLOBAL: 'g' });
    });
  });
});
