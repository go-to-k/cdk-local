import { describe, expect, it, vi } from 'vite-plus/test';
import { resolveLambdaContainerEnv } from '../../../src/cli/commands/local-invoke.js';
import type { ResolvedLambda } from '../../../src/local/lambda-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

// Mock STS so the explicit `--assume-role <arn>` path resolves to deterministic
// temp credentials without a real AWS call (the helper's `assumeLambdaExecutionRole`
// dynamically imports @aws-sdk/client-sts).
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    async send(): Promise<unknown> {
      return {
        Credentials: { AccessKeyId: 'AKIATEST', SecretAccessKey: 'secretTEST', SessionToken: 'tokTEST' },
      };
    }
    destroy(): void {}
  },
  AssumeRoleCommand: class {
    constructor(public input: unknown) {}
  },
}));

// Contract test for the shared container-env resolver (issue #380) on its
// no-state path: a Lambda with literal env vars and no `--from-cfn-stack` /
// `--assume-role` flag resolves to the AWS_LAMBDA_* base + the literal env,
// with no AWS call. (The state-substitution + assume-role paths are exercised
// end to end through `cdkl invoke`'s suite, which now calls this helper, and
// by the real-AWS from-cfn-stack integ.)

function zipLambda(envVars: Record<string, unknown>): ResolvedLambda {
  const stack: StackInfo = {
    stackName: 'Stack',
    displayName: 'Stack',
    artifactId: 'Stack',
    template: { Resources: {} },
    dependencyNames: [],
    region: 'us-east-1',
  };
  return {
    kind: 'zip',
    stack,
    logicalId: 'Handler',
    resource: {
      Type: 'AWS::Lambda::Function',
      Properties: { Environment: { Variables: envVars } },
      Metadata: { 'aws:cdk:path': 'Stack/Handler/Resource' },
    },
    memoryMb: 256,
    timeoutSec: 7,
    layers: [],
    runtime: 'nodejs20.x',
    handler: 'index.handler',
    codePath: '/tmp/code',
  } as unknown as ResolvedLambda;
}

describe('resolveLambdaContainerEnv — no-state path', () => {
  it('resolves literal env vars onto the AWS_LAMBDA_* base, no assume-role', async () => {
    const result = await resolveLambdaContainerEnv(
      zipLambda({ GREETING: 'hello', COUNT: 3 }),
      {},
      undefined
    );
    expect(result.assumeRoleApplied).toBe(false);
    expect(result.sensitiveEnvKeys).toEqual([]);
    expect(result.stateForRoleHint).toBeUndefined();
    expect(result.env['AWS_LAMBDA_FUNCTION_NAME']).toBe('Handler');
    expect(result.env['AWS_LAMBDA_FUNCTION_MEMORY_SIZE']).toBe('256');
    expect(result.env['AWS_LAMBDA_FUNCTION_TIMEOUT']).toBe('7');
    // The function's literal declared env vars are present (coerced to strings).
    expect(result.env['GREETING']).toBe('hello');
    expect(result.env['COUNT']).toBe('3');
    // No state source -> no fallback AWS_REGION jump beyond the synth region.
    expect(result.env['AWS_REGION']).toBe('us-east-1');
  });

  it('drops an intrinsic-valued env var without a state source (warn-and-drop)', async () => {
    const result = await resolveLambdaContainerEnv(
      zipLambda({ TABLE_NAME: { Ref: 'Table' }, OK: 'literal' }),
      {},
      undefined
    );
    // The intrinsic is dropped (no --from-cfn-stack to resolve it); the literal survives.
    expect(result.env['TABLE_NAME']).toBeUndefined();
    expect(result.env['OK']).toBe('literal');
  });
});

describe('resolveLambdaContainerEnv — explicit --assume-role', () => {
  it('injects the assumed-role STS credentials into the container env', async () => {
    const result = await resolveLambdaContainerEnv(
      zipLambda({ GREETING: 'hi' }),
      { assumeRole: 'arn:aws:iam::123456789012:role/ExecRole', region: 'us-west-2' },
      undefined
    );
    expect(result.assumeRoleApplied).toBe(true);
    expect(result.env['AWS_ACCESS_KEY_ID']).toBe('AKIATEST');
    expect(result.env['AWS_SECRET_ACCESS_KEY']).toBe('secretTEST');
    expect(result.env['AWS_SESSION_TOKEN']).toBe('tokTEST');
    expect(result.env['AWS_REGION']).toBe('us-west-2');
    // The declared env var still rides alongside the creds.
    expect(result.env['GREETING']).toBe('hi');
  });
});
