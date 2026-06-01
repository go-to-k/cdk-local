import { describe, expect, it, vi, beforeEach } from 'vite-plus/test';
import {
  resolveStartApiAssumeRoleArn,
  type StackStateBundle,
} from '../../../src/cli/commands/local-start-api.js';
import type { AssumeRoleOption } from '../../../src/cli/options.js';
import type { TemplateResource } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

const ARN_MY = 'arn:aws:iam::123456789012:role/MyExecRole';
const ARN_OTHER = 'arn:aws:iam::123456789012:role/OtherExecRole';
const ARN_GLOBAL = 'arn:aws:iam::123456789012:role/GlobalRole';
const ARN_FROM_STATE = 'arn:aws:iam::123456789012:role/FromStateRole';

function makeLambdaResource(role: unknown): TemplateResource {
  return {
    Type: 'AWS::Lambda::Function',
    Properties: {
      Code: { ZipFile: 'exports.handler = () => {}' },
      Handler: 'index.handler',
      Runtime: 'nodejs20.x',
      Role: role,
    },
  };
}

function makeStateBundle(resources: StackState['resources']): StackStateBundle {
  const state: StackState = {
    version: 1,
    stackName: 'TestStack',
    resources,
    outputs: {},
    lastModified: 0,
  };
  return { state };
}

describe('resolveStartApiAssumeRoleArn — issue #256 Option 1', () => {
  beforeEach(() => {
    // Silence the warn-and-fall-through branch so the test output is
    // clean; assertions check the returned value, not the log stream.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  describe('flag absent / opt-out', () => {
    it('returns undefined when assumeRole is undefined', () => {
      expect(
        resolveStartApiAssumeRoleArn({
          logicalId: 'MyFn',
          assumeRole: undefined,
          lambdaResource: makeLambdaResource(ARN_MY),
          stateBundle: undefined,
        })
      ).toBeUndefined();
    });
  });

  describe('per-Lambda override wins over every other form', () => {
    it('per-Lambda map entry returned even when bareAutoResolve is true', () => {
      const assumeRole: AssumeRoleOption = {
        perLambda: { MyFn: ARN_MY },
        bareAutoResolve: true,
      };
      expect(
        resolveStartApiAssumeRoleArn({
          logicalId: 'MyFn',
          assumeRole,
          lambdaResource: makeLambdaResource(ARN_FROM_STATE),
          stateBundle: makeStateBundle({
            MyFn: { properties: { Role: ARN_FROM_STATE } } as never,
          }),
        })
      ).toBe(ARN_MY);
    });

    it('per-Lambda map entry returned even when a global default is also set', () => {
      const assumeRole: AssumeRoleOption = {
        globalArn: ARN_GLOBAL,
        perLambda: { MyFn: ARN_MY },
      };
      expect(
        resolveStartApiAssumeRoleArn({
          logicalId: 'MyFn',
          assumeRole,
          lambdaResource: makeLambdaResource(ARN_FROM_STATE),
          stateBundle: undefined,
        })
      ).toBe(ARN_MY);
    });
  });

  describe('global default', () => {
    it('returns globalArn when this Lambda has no per-Lambda override', () => {
      const assumeRole: AssumeRoleOption = {
        globalArn: ARN_GLOBAL,
        perLambda: { Other: ARN_OTHER },
      };
      expect(
        resolveStartApiAssumeRoleArn({
          logicalId: 'MyFn',
          assumeRole,
          lambdaResource: makeLambdaResource(ARN_FROM_STATE),
          stateBundle: undefined,
        })
      ).toBe(ARN_GLOBAL);
    });
  });

  describe('bare-auto-resolve (issue #256 Option 1)', () => {
    it('resolves the literal-ARN form of the template Role property', () => {
      const assumeRole: AssumeRoleOption = {
        perLambda: {},
        bareAutoResolve: true,
      };
      expect(
        resolveStartApiAssumeRoleArn({
          logicalId: 'MyFn',
          assumeRole,
          lambdaResource: makeLambdaResource(ARN_MY),
          stateBundle: undefined,
        })
      ).toBe(ARN_MY);
    });

    it('falls back to state when the template Role is an intrinsic (Fn::GetAtt) and state carries the role attribute', () => {
      const assumeRole: AssumeRoleOption = {
        perLambda: {},
        bareAutoResolve: true,
      };
      expect(
        resolveStartApiAssumeRoleArn({
          logicalId: 'MyFn',
          assumeRole,
          lambdaResource: makeLambdaResource({ 'Fn::GetAtt': ['MyExecRole', 'Arn'] }),
          stateBundle: makeStateBundle({
            MyFn: { properties: { Role: { 'Fn::GetAtt': ['MyExecRole', 'Arn'] } } } as never,
            MyExecRole: { attributes: { Arn: ARN_FROM_STATE } } as never,
          }),
        })
      ).toBe(ARN_FROM_STATE);
    });

    it('returns undefined and warns when no state and no literal ARN (warn-and-fall-through)', () => {
      const assumeRole: AssumeRoleOption = {
        perLambda: {},
        bareAutoResolve: true,
      };
      expect(
        resolveStartApiAssumeRoleArn({
          logicalId: 'MyFn',
          assumeRole,
          lambdaResource: makeLambdaResource({ 'Fn::GetAtt': ['MyExecRole', 'Arn'] }),
          stateBundle: undefined,
        })
      ).toBeUndefined();
    });

    it('per-Lambda map skips bare-auto-resolve for the named Lambda; bare-auto-resolve still fires for OTHERS', () => {
      // Mix scenario from the issue: --assume-role --assume-role MyFn=<arn>.
      // MyFn -> the override. OtherFn -> bare-auto-resolve.
      const assumeRole: AssumeRoleOption = {
        perLambda: { MyFn: ARN_MY },
        bareAutoResolve: true,
      };
      // For MyFn: per-Lambda override wins.
      expect(
        resolveStartApiAssumeRoleArn({
          logicalId: 'MyFn',
          assumeRole,
          lambdaResource: makeLambdaResource(ARN_FROM_STATE),
          stateBundle: undefined,
        })
      ).toBe(ARN_MY);
      // For OtherFn: bare-auto-resolve fires against its own template Role.
      expect(
        resolveStartApiAssumeRoleArn({
          logicalId: 'OtherFn',
          assumeRole,
          lambdaResource: makeLambdaResource(ARN_OTHER),
          stateBundle: undefined,
        })
      ).toBe(ARN_OTHER);
    });
  });

  describe('global ARN only (no bare-auto-resolve) — DOES NOT trigger template/state lookup', () => {
    it('falls back to globalArn even when the template Role is a literal ARN', () => {
      const assumeRole: AssumeRoleOption = {
        globalArn: ARN_GLOBAL,
        perLambda: {},
      };
      // The global default has higher precedence than template literal
      // because bare-auto-resolve was NOT requested.
      expect(
        resolveStartApiAssumeRoleArn({
          logicalId: 'MyFn',
          assumeRole,
          lambdaResource: makeLambdaResource(ARN_FROM_STATE),
          stateBundle: undefined,
        })
      ).toBe(ARN_GLOBAL);
    });
  });
});
