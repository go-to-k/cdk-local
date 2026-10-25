import { describe, expect, it, vi } from 'vite-plus/test';
import {
  resolveLambdaContainerEnv,
  resolveTemplateRoleArnFromState,
} from '../../../src/cli/commands/local-invoke.js';
import type { ResolvedLambda } from '../../../src/local/lambda-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

// Mock STS so the explicit `--assume-role <arn>` path resolves to deterministic
// temp credentials without a real AWS call (the shared `assumeRoleCredentials`
// helper in utils/role-arn.ts imports @aws-sdk/client-sts).
const sts = vi.hoisted(() => ({ assumed: [] as unknown[] }));
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    async send(cmd: { input?: unknown }): Promise<unknown> {
      sts.assumed.push(cmd.input);
      return {
        Account: '123456789012',
        Credentials: { AccessKeyId: 'AKIATEST', SecretAccessKey: 'secretTEST', SessionToken: 'tokTEST' },
      };
    }
    destroy(): void {}
  },
  AssumeRoleCommand: class {
    constructor(public input: unknown) {}
  },
  GetCallerIdentityCommand: class {
    input = undefined;
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

describe('resolveLambdaContainerEnv — deployedFunctionLookups: false (start-web-function)', () => {
  function provider() {
    const spies = {
      resolveDeployedFunctionEnv: vi.fn(async () => ({ TABLE_NAME: 'deployed-table' })),
      resolveLambdaExecutionRoleArn: vi.fn(async () => 'arn:aws:iam::123456789012:role/Live'),
    };
    const factory = () => ({
      label: '--from-test',
      load: async () => ({
        resources: { Handler: { physicalId: 'rev-physical-id', resourceType: 'X', properties: {} } },
        outputs: {},
        region: 'us-east-1',
      }),
      buildCrossStackResolver: async () => undefined,
      dispose: () => undefined,
      ...spies,
    });
    return { spies, extra: { fromTest: factory as never } };
  }

  it('never calls the GetFunctionConfiguration fallbacks a web function revision cannot answer', async () => {
    const { spies, extra } = provider();
    const result = await resolveLambdaContainerEnv(
      zipLambda({ TABLE_NAME: { Ref: 'Table' } }),
      { fromTest: true, assumeRole: true, deployedFunctionLookups: false },
      undefined,
      extra
    );
    expect(spies.resolveDeployedFunctionEnv).not.toHaveBeenCalled();
    expect(spies.resolveLambdaExecutionRoleArn).not.toHaveBeenCalled();
    expect(result.assumeRoleApplied).toBe(false);
  });

  it('still calls them by default (a Lambda function)', async () => {
    const { spies, extra } = provider();
    await resolveLambdaContainerEnv(
      zipLambda({ TABLE_NAME: { Ref: 'Table' } }),
      { fromTest: true, assumeRole: true },
      undefined,
      extra
    );
    expect(spies.resolveDeployedFunctionEnv).toHaveBeenCalledWith('rev-physical-id');
    expect(spies.resolveLambdaExecutionRoleArn).toHaveBeenCalledWith('rev-physical-id');
  });
});

describe('resolveTemplateRoleArnFromState', () => {
  const template = {
    Resources: {
      Role: { Type: 'AWS::IAM::Role', Properties: {} },
      PathRole: { Type: 'AWS::IAM::Role', Properties: { Path: '/svc/' } },
      Bucket: { Type: 'AWS::S3::Bucket' },
    },
  };
  const pseudo = async () => ({ accountId: '123456789012', partition: 'aws' });
  const state = (resources: Record<string, unknown>) => ({ resources }) as never;

  it('returns a literal role ARN as written', async () => {
    const arn = 'arn:aws:iam::123456789012:role/Lit';
    expect(await resolveTemplateRoleArnFromState(arn, state({}), template, pseudo)).toBe(arn);
  });

  it('builds the ARN from the role NAME --from-cfn-stack state carries (CDK GetAtt)', async () => {
    const s = state({ Role: { physicalId: 'App-RoleABC', attributes: {} } });
    expect(
      await resolveTemplateRoleArnFromState({ 'Fn::GetAtt': ['Role', 'Arn'] }, s, template, pseudo)
    ).toBe('arn:aws:iam::123456789012:role/App-RoleABC');
  });

  it("honours the role's literal Path", async () => {
    const s = state({ PathRole: { physicalId: 'Named', attributes: {} } });
    expect(await resolveTemplateRoleArnFromState({ Ref: 'PathRole' }, s, template, pseudo)).toBe(
      'arn:aws:iam::123456789012:role/svc/Named'
    );
  });

  it('prefers a cached Arn attribute without an account lookup', async () => {
    const lookup = vi.fn(pseudo);
    const s = state({
      Role: { physicalId: 'x', attributes: { Arn: 'arn:aws:iam::111111111111:role/Cached' } },
    });
    expect(
      await resolveTemplateRoleArnFromState({ 'Fn::GetAtt': ['Role', 'Arn'] }, s, template, lookup)
    ).toBe('arn:aws:iam::111111111111:role/Cached');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('returns a physical id that already is a role ARN', async () => {
    const s = state({ Role: { physicalId: 'arn:aws:iam::222222222222:role/Phys', attributes: {} } });
    expect(await resolveTemplateRoleArnFromState({ Ref: 'Role' }, s, template, pseudo)).toBe(
      'arn:aws:iam::222222222222:role/Phys'
    );
  });

  it('defaults the partition to aws', async () => {
    const s = state({ Role: { physicalId: 'R', attributes: {} } });
    expect(
      await resolveTemplateRoleArnFromState({ Ref: 'Role' }, s, template, async () => ({
        accountId: '123456789012',
      }))
    ).toBe('arn:aws:iam::123456789012:role/R');
  });

  it('rejects a physical id that is not a role name, and a non-literal Path', async () => {
    const bad = state({ Role: { physicalId: 'has/slash name', attributes: {} } });
    expect(await resolveTemplateRoleArnFromState({ Ref: 'Role' }, bad, template, pseudo)).toBeUndefined();
    const t2 = {
      Resources: { Role: { Type: 'AWS::IAM::Role', Properties: { Path: { Ref: 'P' } } } },
    };
    const ok = state({ Role: { physicalId: 'R', attributes: {} } });
    expect(await resolveTemplateRoleArnFromState({ Ref: 'Role' }, ok, t2, pseudo)).toBeUndefined();
  });

  it('declines a non-role reference, a missing state row and an unknown account', async () => {
    const s = state({ Role: { physicalId: 'App-Role', attributes: {} }, Bucket: { physicalId: 'b' } });
    expect(await resolveTemplateRoleArnFromState({ Ref: 'Bucket' }, s, template, pseudo)).toBeUndefined();
    expect(
      await resolveTemplateRoleArnFromState({ Ref: 'PathRole' }, state({}), template, pseudo)
    ).toBeUndefined();
    expect(
      await resolveTemplateRoleArnFromState({ Ref: 'Role' }, s, template, async () => undefined)
    ).toBeUndefined();
  });
});

describe('resolveLambdaContainerEnv — bare --assume-role from the template Role (web function)', () => {
  it('assumes the role --from-cfn-stack-style state names, with no Lambda API call', async () => {
    sts.assumed = [];
    const lambda = zipLambda({});
    (lambda.resource.Properties as Record<string, unknown>)['Role'] = { 'Fn::GetAtt': ['Role', 'Arn'] };
    lambda.stack.template = { Resources: { Role: { Type: 'AWS::IAM::Role', Properties: {} } } };
    const resolveLambdaExecutionRoleArn = vi.fn(async () => undefined);
    const factory = () => ({
      label: '--from-test',
      load: async () => ({
        resources: { Role: { physicalId: 'App-RoleABC', resourceType: 'AWS::IAM::Role', properties: {}, attributes: {} } },
        outputs: {},
        region: 'us-east-1',
      }),
      buildCrossStackResolver: async () => undefined,
      dispose: () => undefined,
      resolveLambdaExecutionRoleArn,
    });
    const result = await resolveLambdaContainerEnv(
      lambda,
      { fromTest: true, assumeRole: true, deployedFunctionLookups: false, region: 'us-east-1' },
      undefined,
      { fromTest: factory as never }
    );
    expect(result.assumeRoleApplied).toBe(true);
    expect(sts.assumed).toContainEqual(
      expect.objectContaining({ RoleArn: 'arn:aws:iam::123456789012:role/App-RoleABC' })
    );
    expect(resolveLambdaExecutionRoleArn).not.toHaveBeenCalled();
  });
});
