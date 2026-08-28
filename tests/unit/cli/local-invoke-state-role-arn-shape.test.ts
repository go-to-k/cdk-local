import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { getLogger } from '../../../src/utils/logger.js';
import { resolveExecutionRoleArnFromState } from '../../../src/cli/commands/local-invoke.js';
import type { StackState } from '../../../src/types/state.js';

/**
 * Issue #607 — the SHAPE check at the two `resolveExecutionRoleArnFromState`
 * resolution points.
 *
 * The function has TWO independent reads and each used to be gated by
 * `startsWith('arn:')`:
 *
 *   1. the STATE READ — `properties[roleProperty]` / `observedProperties[...]`
 *      of the function or runtime resource, when it is a literal string;
 *   2. its CACHE — when that property is an intrinsic (`Ref` / `Fn::GetAtt`),
 *      the referenced role resource's cached `Arn` attribute.
 *
 * Both come out of a state record built from CloudFormation responses, and the
 * value is handed to `AssumeRoleCommand.RoleArn`, so both are checked. They are
 * fenced SEPARATELY here: they are two `if`s, and a single fixture exercising
 * only the first would let the second regress silently.
 */

/** Passes `startsWith('arn:')`, which is exactly the point. */
const OVERLONG = `arn:aws:iam::111:role/${'A'.repeat(100_000)}`;
const FORGED = 'arn:aws:iam::111:role/R\nWARN: forged line';
const GOOD = 'arn:aws:iam::111:role/RealRole';

/** State whose Lambda names its role as a LITERAL string (the state read). */
function literalRoleState(role: unknown, roleProperty = 'Role'): StackState {
  return {
    version: 1,
    stackName: 'Stack',
    resources: {
      Handler: {
        physicalId: 'handler-physical',
        resourceType: 'AWS::Lambda::Function',
        properties: { [roleProperty]: role },
        attributes: {},
        dependencies: [],
      },
    },
    outputs: {},
    lastModified: 0,
  } as unknown as StackState;
}

/** State whose Lambda REFERENCES a role resource whose cached Arn is `arn`. */
function referencedRoleState(arn: unknown): StackState {
  return {
    version: 1,
    stackName: 'Stack',
    resources: {
      Handler: {
        physicalId: 'handler-physical',
        resourceType: 'AWS::Lambda::Function',
        properties: { Role: { 'Fn::GetAtt': ['ExecRole', 'Arn'] } },
        attributes: {},
        dependencies: [],
      },
      ExecRole: {
        physicalId: 'role-physical',
        resourceType: 'AWS::IAM::Role',
        properties: {},
        attributes: arn === undefined ? {} : { Arn: arn },
        dependencies: [],
      },
    },
    outputs: {},
    lastModified: 0,
  } as unknown as StackState;
}

describe('#607 — resolveExecutionRoleArnFromState shape check', () => {
  let warnings: string[];

  beforeEach(() => {
    warnings = [];
    vi.spyOn(getLogger(), 'warn').mockImplementation((m: string) => {
      warnings.push(String(m));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('premise: the rejected fixtures pass the check #607 replaced', () => {
    // Non-vacuity for every rejection below.
    expect(OVERLONG.startsWith('arn:')).toBe(true);
    expect(FORGED.startsWith('arn:')).toBe(true);
  });

  describe('the state read (properties[roleProperty])', () => {
    it('still resolves a well-formed ARN', () => {
      expect(resolveExecutionRoleArnFromState(literalRoleState(GOOD), 'Handler')).toBe(GOOD);
      expect(warnings).toHaveLength(0);
    });

    it('still honours a custom role property (the agentcore RoleArn spelling)', () => {
      expect(
        resolveExecutionRoleArnFromState(literalRoleState(GOOD, 'RoleArn'), 'Handler', 'RoleArn')
      ).toBe(GOOD);
    });

    it('rejects an over-long value that merely starts with arn:', () => {
      expect(resolveExecutionRoleArnFromState(literalRoleState(OVERLONG), 'Handler')).toBeUndefined();
    });

    it('rejects a value carrying a forged second line', () => {
      expect(resolveExecutionRoleArnFromState(literalRoleState(FORGED), 'Handler')).toBeUndefined();
    });

    it('WARNS on a present-but-rejected value, naming the property', () => {
      resolveExecutionRoleArnFromState(literalRoleState('MyRoleName'), 'Handler');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('not a well-formed IAM role ARN');
      expect(warnings[0]).toContain("'Handler'");
      expect(warnings[0]).toContain('Role');
      expect(warnings[0]).toContain('"MyRoleName"');
      // NOT prefixed `--assume-role:`. `suggestAssumeRoleFromState` calls this
      // function on a plain `cdkl invoke --from-cfn-stack` with no role flag
      // at all, so the prefix named a flag the user had not passed — on the
      // one path whose whole purpose is to SUGGEST it.
      expect(warnings[0]).not.toContain('--assume-role');
    });

    it('the warn is BOUNDED and single-line', () => {
      resolveExecutionRoleArnFromState(literalRoleState(FORGED), 'Handler');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).not.toContain('\n');
      resolveExecutionRoleArnFromState(literalRoleState(OVERLONG), 'Handler');
      expect(warnings[1]!.length).toBeLessThan(400);
      expect(warnings[1]).toContain(`(${OVERLONG.length} characters)`);
    });

    it('stays SILENT when the property is absent', () => {
      expect(resolveExecutionRoleArnFromState(literalRoleState(undefined), 'Handler')).toBeUndefined();
      expect(warnings).toHaveLength(0);
    });

    it('stays SILENT when the property is an intrinsic (that is the cache path)', () => {
      // An object roleRef is not a rejected string — it routes to read 2 — so
      // the string branch must not warn about it.
      resolveExecutionRoleArnFromState(referencedRoleState(GOOD), 'Handler');
      expect(warnings).toHaveLength(0);
    });
  });

  describe('the cache (the referenced role resource attributes.Arn)', () => {
    it('still resolves a well-formed cached ARN', () => {
      expect(resolveExecutionRoleArnFromState(referencedRoleState(GOOD), 'Handler')).toBe(GOOD);
      expect(warnings).toHaveLength(0);
    });

    it('rejects an over-long cached value that merely starts with arn:', () => {
      expect(
        resolveExecutionRoleArnFromState(referencedRoleState(OVERLONG), 'Handler')
      ).toBeUndefined();
    });

    it('rejects a cached value carrying a forged second line', () => {
      expect(
        resolveExecutionRoleArnFromState(referencedRoleState(FORGED), 'Handler')
      ).toBeUndefined();
    });

    it('WARNS on a present-but-rejected cached Arn, naming the referenced resource', () => {
      resolveExecutionRoleArnFromState(referencedRoleState('role-name-only'), 'Handler');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('not a well-formed IAM role ARN');
      expect(warnings[0]).toContain("'ExecRole'");
      expect(warnings[0]).toContain('"role-name-only"');
    });

    it('the warn is BOUNDED and single-line', () => {
      resolveExecutionRoleArnFromState(referencedRoleState(FORGED), 'Handler');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).not.toContain('\n');
      resolveExecutionRoleArnFromState(referencedRoleState(OVERLONG), 'Handler');
      expect(warnings[1]!.length).toBeLessThan(400);
      expect(warnings[1]).toContain(`(${OVERLONG.length} characters)`);
    });

    it('stays SILENT when the cached Arn is absent', () => {
      expect(
        resolveExecutionRoleArnFromState(referencedRoleState(undefined), 'Handler')
      ).toBeUndefined();
      expect(warnings).toHaveLength(0);
    });

    it('stays SILENT on an EMPTY cached Arn — the documented sibling-stack shape', () => {
      // Issues #181 / #187, quoted in `resolveAssumeRoleArnForLambda`'s JSDoc:
      // `ListStackResources` returns a sibling-stack role's NAME, so the state
      // map carries an EMPTY `Arn` and the live `GetFunctionConfiguration`
      // fallback is what resolves it. That is the normal SUCCESS path, so a
      // warn here would fire on a working configuration. A `!== undefined`
      // guard did exactly that, because `''` passes it.
      expect(
        resolveExecutionRoleArnFromState(referencedRoleState(''), 'Handler')
      ).toBeUndefined();
      expect(warnings).toHaveLength(0);
    });

    it('still WARNS on a non-empty rejected cached Arn (the empty case is not a blanket mute)', () => {
      resolveExecutionRoleArnFromState(referencedRoleState(' '), 'Handler');
      expect(warnings).toHaveLength(1);
    });
  });
});
