import { describe, it, expect, vi } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';
import type { LocalStateProvider } from '../../../src/local/local-state-provider.js';

const { resolveAssumeRoleArnForLambda } = await import(
  '../../../src/cli/commands/local-invoke.js'
);

function stateWithLambda(opts: {
  logicalId: string;
  physicalId?: string;
  roleProperty?: unknown;
  roleResource?: { logicalId: string; arn?: string };
}): StackState {
  const resources: StackState['resources'] = {};
  resources[opts.logicalId] = {
    physicalId: opts.physicalId ?? `${opts.logicalId}-physical`,
    resourceType: 'AWS::Lambda::Function',
    properties: opts.roleProperty !== undefined ? { Role: opts.roleProperty } : {},
    attributes: {},
    dependencies: [],
  };
  if (opts.roleResource) {
    const attrs: Record<string, unknown> = {};
    if (opts.roleResource.arn) attrs['Arn'] = opts.roleResource.arn;
    resources[opts.roleResource.logicalId] = {
      physicalId: 'role-physical',
      resourceType: 'AWS::IAM::Role',
      properties: {},
      attributes: attrs,
      dependencies: [],
    };
  }
  return {
    version: 1,
    stackName: 'TestStack',
    resources,
    outputs: {},
    lastModified: 0,
  };
}

describe('resolveAssumeRoleArnForLambda', () => {
  it('returns the explicit ARN for --assume-role <arn>', async () => {
    const arn = await resolveAssumeRoleArnForLambda(
      'arn:aws:iam::1:role/Explicit',
      undefined,
      undefined,
      'AnyFn'
    );
    expect(arn).toBe('arn:aws:iam::1:role/Explicit');
  });

  it('returns undefined when --assume-role is absent', async () => {
    const arn = await resolveAssumeRoleArnForLambda(undefined, undefined, undefined, 'AnyFn');
    expect(arn).toBeUndefined();
  });

  it('returns undefined when --assume-role is explicitly false (--no-assume-role)', async () => {
    const arn = await resolveAssumeRoleArnForLambda(false, undefined, undefined, 'AnyFn');
    expect(arn).toBeUndefined();
  });

  describe('bare --assume-role (assumeRole === true)', () => {
    it('returns undefined and warns when no state is loaded', async () => {
      const arn = await resolveAssumeRoleArnForLambda(true, undefined, undefined, 'AnyFn');
      expect(arn).toBeUndefined();
    });

    it("resolves from state when the role's Arn attribute is cached (S3-state shape)", async () => {
      const state = stateWithLambda({
        logicalId: 'Echo',
        roleProperty: { 'Fn::GetAtt': ['EchoRole', 'Arn'] },
        roleResource: { logicalId: 'EchoRole', arn: 'arn:aws:iam::1:role/Echo-state-cached' },
      });

      const arn = await resolveAssumeRoleArnForLambda(true, state, undefined, 'Echo');

      expect(arn).toBe('arn:aws:iam::1:role/Echo-state-cached');
    });

    it('falls back to stateProvider.resolveLambdaExecutionRoleArn when state misses (issue #181)', async () => {
      const state = stateWithLambda({
        logicalId: 'Echo',
        physicalId: 'echo-fn-physical',
        roleProperty: { 'Fn::GetAtt': ['EchoRole', 'Arn'] },
        // EchoRole is in resources but its attributes.Arn is empty,
        // matching what `ListStackResources` produces in the CFn
        // state provider — exactly the issue #181 trigger.
        roleResource: { logicalId: 'EchoRole' },
      });
      const resolveLambdaExecutionRoleArn = vi
        .fn()
        .mockResolvedValue('arn:aws:iam::1:role/Echo-live');
      const stateProvider = {
        resolveLambdaExecutionRoleArn,
      } as unknown as LocalStateProvider;

      const arn = await resolveAssumeRoleArnForLambda(true, state, stateProvider, 'Echo');

      expect(arn).toBe('arn:aws:iam::1:role/Echo-live');
      expect(resolveLambdaExecutionRoleArn).toHaveBeenCalledTimes(1);
      expect(resolveLambdaExecutionRoleArn).toHaveBeenCalledWith('echo-fn-physical');
    });

    it('warns and returns undefined when both state and live fallback miss', async () => {
      const state = stateWithLambda({
        logicalId: 'Echo',
        physicalId: 'echo-fn-physical',
        roleProperty: { 'Fn::GetAtt': ['EchoRole', 'Arn'] },
        roleResource: { logicalId: 'EchoRole' },
      });
      const stateProvider = {
        resolveLambdaExecutionRoleArn: vi.fn().mockResolvedValue(undefined),
      } as unknown as LocalStateProvider;

      const arn = await resolveAssumeRoleArnForLambda(true, state, stateProvider, 'Echo');

      expect(arn).toBeUndefined();
    });

    it('does not call the live fallback when the state lookup succeeds (avoids an unnecessary SDK call)', async () => {
      const state = stateWithLambda({
        logicalId: 'Echo',
        roleProperty: { 'Fn::GetAtt': ['EchoRole', 'Arn'] },
        roleResource: { logicalId: 'EchoRole', arn: 'arn:aws:iam::1:role/Echo-state-cached' },
      });
      const resolveLambdaExecutionRoleArn = vi.fn();
      const stateProvider = {
        resolveLambdaExecutionRoleArn,
      } as unknown as LocalStateProvider;

      const arn = await resolveAssumeRoleArnForLambda(true, state, stateProvider, 'Echo');

      expect(arn).toBe('arn:aws:iam::1:role/Echo-state-cached');
      expect(resolveLambdaExecutionRoleArn).not.toHaveBeenCalled();
    });

    it('warns without calling the live fallback when the Lambda has no physicalId in state', async () => {
      // State has no entry for the lambda's logicalId — the fallback's
      // physicalId precondition fails, so it must not fire.
      const state: StackState = {
        version: 1,
        stackName: 'TestStack',
        resources: {},
        outputs: {},
        lastModified: 0,
      };
      const resolveLambdaExecutionRoleArn = vi.fn();
      const stateProvider = {
        resolveLambdaExecutionRoleArn,
      } as unknown as LocalStateProvider;

      const arn = await resolveAssumeRoleArnForLambda(true, state, stateProvider, 'MissingFn');

      expect(arn).toBeUndefined();
      expect(resolveLambdaExecutionRoleArn).not.toHaveBeenCalled();
    });

    it('propagates rejections from the live fallback so the caller can release the state provider in a finally', async () => {
      // The CFn provider's contract is best-effort + never-throws, but a host
      // extension implementing the optional method could violate it. The
      // helper deliberately does NOT swallow the rejection — the caller wraps
      // the helper call in a try/finally that always disposes the provider,
      // so propagating is safe AND surfaces the host bug instead of silently
      // hiding it behind the warn-and-fall-through path.
      const state = stateWithLambda({
        logicalId: 'Echo',
        physicalId: 'echo-fn-physical',
        roleProperty: { 'Fn::GetAtt': ['EchoRole', 'Arn'] },
        roleResource: { logicalId: 'EchoRole' },
      });
      const stateProvider = {
        resolveLambdaExecutionRoleArn: vi.fn().mockRejectedValue(new Error('host bug')),
      } as unknown as LocalStateProvider;

      await expect(
        resolveAssumeRoleArnForLambda(true, state, stateProvider, 'Echo')
      ).rejects.toThrow(/host bug/);
    });

    it('warns without calling the live fallback when the state provider does not implement the method', async () => {
      const state = stateWithLambda({
        logicalId: 'Echo',
        physicalId: 'echo-fn-physical',
        roleProperty: { 'Fn::GetAtt': ['EchoRole', 'Arn'] },
        roleResource: { logicalId: 'EchoRole' },
      });
      // A state provider that does not implement
      // resolveLambdaExecutionRoleArn (e.g. an S3-state provider) is
      // allowed — the optional method should not be called.
      const stateProvider = {} as unknown as LocalStateProvider;

      const arn = await resolveAssumeRoleArnForLambda(true, state, stateProvider, 'Echo');

      expect(arn).toBeUndefined();
    });
  });
});
