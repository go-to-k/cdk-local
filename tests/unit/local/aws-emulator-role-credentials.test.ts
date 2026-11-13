/**
 * go-to-k/cdk-local#951: role flags under `--aws-emulator`.
 *
 * - Full emulator mode: a role session the emulator's STS issued runs in the
 *   container (Lambda env, ECS env, `run-task`'s metadata sidecar), so the
 *   emulator enforces the role's policies. Any other credential is still
 *   replaced by the emulator's keys.
 * - A refused assume does not fall back to `sts:GetFederationToken` against
 *   the emulator (its own user has no policies, so that session is allowed
 *   nothing): one warning, then the command's prior refused-assume outcome.
 * - Mixed mode: a bare role flag reads the role from the state record only
 *   when IAM is a `"real-aws"` exception, else warns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const aws = vi.hoisted(() => ({
  sent: [] as Array<{ name: string; input: Record<string, unknown> }>,
  denyRole: undefined as string | undefined,
  seq: 0,
}));

function command(name: string) {
  return vi.fn(function (this: Record<string, unknown>, input: Record<string, unknown>) {
    this['__name'] = name;
    this['input'] = input;
  });
}

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn(function STSClient() {
    return {
      config: { region: async () => 'us-east-1' },
      send: vi.fn(async (cmd: { __name: string; input: Record<string, unknown> }) => {
        aws.sent.push({ name: cmd.__name, input: cmd.input });
        if (cmd.__name === 'GetCallerIdentity') {
          return { Arn: 'arn:aws:iam::000000000000:user/emulator', Account: '000000000000' };
        }
        if (cmd.__name === 'AssumeRole' && cmd.input['RoleArn'] === aws.denyRole) {
          throw Object.assign(new Error('not authorized to perform: sts:AssumeRole'), {
            name: 'AccessDenied',
            $fault: 'client',
            $metadata: { httpStatusCode: 403 },
          });
        }
        if (cmd.__name === 'AssumeRole' || cmd.__name === 'GetFederationToken') {
          aws.seq += 1;
          return {
            Credentials: {
              AccessKeyId: `ASIAROLE${aws.seq}`,
              SecretAccessKey: `role-secret-${aws.seq}`,
              SessionToken: `role-token-${aws.seq}`,
            },
          };
        }
        throw new Error(`unexpected STS command ${cmd.__name}`);
      }),
      destroy: vi.fn(),
    };
  }),
  GetCallerIdentityCommand: command('GetCallerIdentity'),
  AssumeRoleCommand: command('AssumeRole'),
  GetFederationTokenCommand: command('GetFederationToken'),
}));

vi.mock('@aws-sdk/client-iam', () => ({
  IAMClient: vi.fn(function IAMClient() {
    return {
      send: vi.fn(async (cmd: { __name: string }) => {
        aws.sent.push({ name: cmd.__name, input: {} });
        if (cmd.__name === 'GetRole') return { Role: {} };
        if (cmd.__name === 'ListRolePolicies') return { PolicyNames: [], IsTruncated: false };
        if (cmd.__name === 'ListAttachedRolePolicies') {
          return { AttachedPolicies: [], IsTruncated: false };
        }
        throw new Error(`unexpected IAM command ${cmd.__name}`);
      }),
      destroy: vi.fn(),
    };
  }),
  ListRolePoliciesCommand: command('ListRolePolicies'),
  GetRolePolicyCommand: command('GetRolePolicy'),
  ListAttachedRolePoliciesCommand: command('ListAttachedRolePolicies'),
  GetRoleCommand: command('GetRole'),
}));

const { emulateRoleAfterDeniedAssume, __resetRoleEmulationWarnings } = await import(
  '../../../src/utils/role-permission-emulation.js'
);
const { assumeRoleCredentials, AssumeRoleFailure } = await import(
  '../../../src/utils/role-arn.js'
);
const {
  applyWorkloadAwsWiringToEnv,
  emulatorIssuedCredentials,
  keepEmulatorIssuedCredentials,
  resetWorkloadAwsWiringForTest,
  setActiveWorkloadAwsWiring,
  stateRoleRecordIsEmulatorSide,
} = await import('../../../src/local/workload-aws-wiring.js');
const { setAwsEmulatorServiceRouting, setAwsEndpointOverride } = await import(
  '../../../src/utils/aws-proxy.js'
);
const { buildDockerRunArgs } = await import('../../../src/local/ecs-task-runner.js');
const { resolveSidecarCredentials } = await import('../../../src/cli/commands/local-run-task.js');
const { resolveAssumeRoleArnForLambda } = await import(
  '../../../src/cli/commands/local-invoke.js'
);
const { resolveStartApiAssumeRoleArn } = await import(
  '../../../src/cli/commands/local-start-api.js'
);
const { resolveAssumeRoleArn: resolveAgentCoreAssumeRoleArn } = await import(
  '../../../src/cli/commands/local-invoke-agentcore.js'
);
const { getLogger } = await import('../../../src/utils/logger.js');

import type {
  MixedModeWiring,
  WorkloadAwsWiring,
} from '../../../src/local/workload-aws-wiring.js';
import type { ResolvedEcsContainer, ResolvedEcsTask } from '../../../src/local/ecs-task-resolver.js';
import type { ResolvedAgentCoreRuntime } from '../../../src/local/agentcore-resolver.js';
import type { StackState } from '../../../src/types/state.js';

const ROLE = 'arn:aws:iam::000000000000:role/App-TaskRole';
const VIA = 'arn:aws:iam::000000000000:role/Dev';
const EMULATOR_KEYS = { accessKeyId: 'EMULATORKEY', secretAccessKey: 'EMULATORSECRET' };
const EMULATOR_URL = 'https://127.0.0.1:9505';

const forwardWiring: WorkloadAwsWiring = {
  mode: 'forward',
  env: {},
  scrubEnvKeys: [],
  mounts: [],
  loopbackPorts: [],
  probeHealth: false,
  dispose: () => undefined,
};
const emulatorWiring: WorkloadAwsWiring = {
  ...forwardWiring,
  mode: 'emulator',
  env: { AWS_ENDPOINT_URL: EMULATOR_URL },
  emulatorCredentials: EMULATOR_KEYS,
};

/** `--aws-emulator` alone: the wiring plus the process-wide endpoint override. */
function fullEmulatorMode(): void {
  setActiveWorkloadAwsWiring(emulatorWiring);
  setAwsEndpointOverride({ endpoint: EMULATOR_URL, credentials: EMULATOR_KEYS });
}

/** Mixed mode: `realServices` are the `Parameters` exceptions. */
function mixedMode(realServices: string[]): void {
  setActiveWorkloadAwsWiring({
    ...forwardWiring,
    mixed: { realServices, emulatorCredentials: EMULATOR_KEYS } as unknown as MixedModeWiring,
  });
  setAwsEmulatorServiceRouting({
    realServices,
    override: { endpoint: EMULATOR_URL, credentials: EMULATOR_KEYS },
  });
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  aws.sent = [];
  aws.denyRole = undefined;
  warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
  vi.spyOn(getLogger(), 'info').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  resetWorkloadAwsWiringForTest();
  __resetRoleEmulationWarnings();
});

const warnings = (): string[] => (warn.mock.calls as unknown[][]).map((c) => String(c[0]));
const sentNames = (): string[] => aws.sent.map((s) => s.name);

const emulateArgs = {
  roleArn: ROLE,
  region: 'us-east-1',
  profile: undefined,
  flag: '--assume-role',
  sessionNameSuffix: 'start-service',
};
const denied = Object.assign(new Error('denied'), { name: 'AccessDenied' });

describe('a refused assume under --aws-emulator', () => {
  it('makes no STS call and warns once, naming the emulator identity remedy', async () => {
    fullEmulatorMode();
    expect(await emulateRoleAfterDeniedAssume(denied, emulateArgs)).toBeUndefined();
    expect(await emulateRoleAfterDeniedAssume(denied, emulateArgs)).toBeUndefined();
    expect(aws.sent).toEqual([]);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('sts:GetFederationToken session is allowed nothing');
    expect(warnings()[0]).toContain('arn:aws:iam::000000000000:root');
    expect(warnings()[0]).toContain('--emulate-role-via');
  });

  it('assumeRoleCredentials keeps the original refusal (no GetFederationToken)', async () => {
    fullEmulatorMode();
    aws.denyRole = ROLE;
    await expect(
      assumeRoleCredentials({ roleArn: ROLE, region: 'us-east-1', profile: undefined, sessionNameSuffix: 'invoke' })
    ).rejects.toBeInstanceOf(AssumeRoleFailure);
    expect(sentNames()).toEqual(['AssumeRole']);
  });

  it('still emulates through --emulate-role-via (that role has its own policies there)', async () => {
    fullEmulatorMode();
    const creds = await emulateRoleAfterDeniedAssume(denied, { ...emulateArgs, emulateRoleVia: VIA });
    expect(creds?.accessKeyId).toMatch(/^ASIAROLE/);
    expect(sentNames()).not.toContain('GetFederationToken');
    expect(aws.sent.find((s) => s.name === 'AssumeRole')?.input['RoleArn']).toBe(VIA);
  });

  it('mixed mode still federates (the hop is on real AWS)', async () => {
    mixedMode([]);
    await emulateRoleAfterDeniedAssume(denied, emulateArgs);
    expect(sentNames()).toContain('GetFederationToken');
  });
});

describe('an emulator-issued role session reaches the container', () => {
  it('Lambda env: the recorded triple survives; nothing else does', async () => {
    fullEmulatorMode();
    const role = await assumeRoleCredentials({
      roleArn: ROLE,
      region: 'us-east-1',
      profile: undefined,
      sessionNameSuffix: 'invoke',
    });
    const triple = {
      AWS_ACCESS_KEY_ID: role.accessKeyId,
      AWS_SECRET_ACCESS_KEY: role.secretAccessKey,
      AWS_SESSION_TOKEN: role.sessionToken,
    };
    const kept = applyWorkloadAwsWiringToEnv(triple, emulatorWiring);
    expect(kept['AWS_ACCESS_KEY_ID']).toBe(role.accessKeyId);
    expect(kept['AWS_SESSION_TOKEN']).toBe(role.sessionToken);

    // An altered token, or a triple cdk-local did not record, is replaced.
    const altered = applyWorkloadAwsWiringToEnv(
      { ...triple, AWS_SESSION_TOKEN: 'other' },
      emulatorWiring
    );
    expect(altered['AWS_ACCESS_KEY_ID']).toBe(EMULATOR_KEYS.accessKeyId);
    expect(altered['AWS_SESSION_TOKEN']).toBeUndefined();
    const foreign = applyWorkloadAwsWiringToEnv(
      { AWS_ACCESS_KEY_ID: 'AKIAREAL', AWS_SECRET_ACCESS_KEY: 'real' },
      emulatorWiring
    );
    expect(foreign['AWS_ACCESS_KEY_ID']).toBe(EMULATOR_KEYS.accessKeyId);
  });

  it('records the --emulate-role-via session too', async () => {
    fullEmulatorMode();
    aws.denyRole = ROLE;
    const creds = await assumeRoleCredentials({
      roleArn: ROLE,
      region: 'us-east-1',
      profile: undefined,
      sessionNameSuffix: 'invoke',
      emulateRoleVia: VIA,
    });
    expect(emulatorIssuedCredentials(creds)).toEqual(creds);
  });

  it('records nothing in mixed mode or without --aws-emulator', () => {
    const creds = { accessKeyId: 'ASIAX', secretAccessKey: 's', sessionToken: 't' };
    mixedMode([]);
    keepEmulatorIssuedCredentials(creds);
    expect(emulatorIssuedCredentials(creds)).toBeUndefined();
    resetWorkloadAwsWiringForTest();
    keepEmulatorIssuedCredentials(creds);
    expect(emulatorIssuedCredentials(creds)).toBeUndefined();
  });

  it('ECS env: the task role replaces the emulator keys', () => {
    fullEmulatorMode();
    const task = keepEmulatorIssuedCredentials({
      accessKeyId: 'ASIATASK',
      secretAccessKey: 'task-secret',
      sessionToken: 'task-token',
    });
    const build = (taskCredentials?: typeof task) =>
      buildDockerRunArgs({
        task: { family: 'fam' } as unknown as ResolvedEcsTask,
        container: {
          name: 'app',
          image: { kind: 'public', uri: 'busybox' },
          environment: {},
          sensitiveEnvKeys: [],
          secrets: [],
          portMappings: [],
          mountPoints: [],
          dependsOn: [],
          links: [],
          essential: true,
          ulimits: [],
          warnings: [],
        } as unknown as ResolvedEcsContainer,
        image: 'busybox',
        network: 'net',
        volumeByName: new Map(),
        secrets: [],
        envOverrides: undefined,
        containerHost: '127.0.0.1',
        roleArn: ROLE,
        platformOverride: undefined,
        region: 'us-east-1',
        ...(taskCredentials && { taskCredentials }),
      }).sensitiveEnv;
    expect(build(task)['AWS_ACCESS_KEY_ID']).toBe('ASIATASK');
    expect(build(task)['AWS_SESSION_TOKEN']).toBe('task-token');
    expect(build()['AWS_ACCESS_KEY_ID']).toBe(EMULATOR_KEYS.accessKeyId);
    expect(
      build({ ...task, sessionToken: 'forged' })['AWS_ACCESS_KEY_ID']
    ).toBe(EMULATOR_KEYS.accessKeyId);
  });

  it('run-task sidecar: serves the recorded task role, else the emulator keys', async () => {
    fullEmulatorMode();
    const task = keepEmulatorIssuedCredentials({
      accessKeyId: 'ASIATASK',
      secretAccessKey: 'task-secret',
      sessionToken: 'task-token',
    });
    expect(await resolveSidecarCredentials({}, task)).toEqual(task);
    expect(
      await resolveSidecarCredentials({}, { ...task, accessKeyId: 'AKIAREAL' })
    ).toEqual(EMULATOR_KEYS);
  });
});

describe('mixed mode: a bare role flag and the state record', () => {
  const FROM_STATE = 'arn:aws:iam::000000000000:role/App-FnRole';
  const REAL = 'arn:aws:iam::123456789012:role/App-FnRole';
  const state: StackState = {
    version: 1,
    stackName: 'App',
    resources: {
      Fn: {
        physicalId: 'App-Fn',
        resourceType: 'AWS::Lambda::Function',
        properties: { Role: FROM_STATE },
        attributes: {},
        dependencies: [],
      },
      Agent: {
        physicalId: 'agent-id',
        resourceType: 'AWS::BedrockAgentCore::Runtime',
        properties: { RoleArn: FROM_STATE },
        attributes: {},
        dependencies: [],
      },
    },
    outputs: {},
    lastModified: 0,
  } as unknown as StackState;

  it('IAM on the emulator: guard is on', () => {
    mixedMode([]);
    expect(stateRoleRecordIsEmulatorSide()).toBe(true);
    mixedMode(['IAM']);
    expect(stateRoleRecordIsEmulatorSide()).toBe(false);
    fullEmulatorMode();
    expect(stateRoleRecordIsEmulatorSide()).toBe(false);
  });

  it('invoke: skips the record, keeps the real-AWS lookup, warns on a miss', async () => {
    mixedMode([]);
    expect(await resolveAssumeRoleArnForLambda(true, state, undefined, 'Fn')).toBeUndefined();
    expect(warnings().join('\n')).toContain('AWS_ENDPOINT_URL_IAM');
    const real = { resolveLambdaExecutionRoleArn: vi.fn(async () => REAL) };
    expect(await resolveAssumeRoleArnForLambda(true, state, real, 'Fn')).toBe(REAL);
    mixedMode(['IAM']);
    expect(await resolveAssumeRoleArnForLambda(true, state, undefined, 'Fn')).toBe(FROM_STATE);
  });

  it('start-api: reads the record only when IAM is excepted', () => {
    const resolve = () =>
      resolveStartApiAssumeRoleArn({
        logicalId: 'Fn',
        assumeRole: { bareAutoResolve: true } as never,
        lambdaResource: { Type: 'AWS::Lambda::Function', Properties: { Role: { Ref: 'R' } } },
        stateBundle: { state },
      });
    mixedMode([]);
    expect(resolve()).toBeUndefined();
    expect(warnings().join('\n')).toContain('--assume-role Fn=<arn>');
    mixedMode(['IAM']);
    expect(resolve()).toBe(FROM_STATE);
  });

  it('invoke-agentcore: skips the record, keeps the real-AWS lookup', async () => {
    const runtime = {
      stack: { stackName: 'App' },
      logicalId: 'Agent',
      resource: { Type: 'AWS::BedrockAgentCore::Runtime', Properties: {} },
      containerUri: 'repo:tag',
      environmentVariables: {},
      protocol: 'HTTP',
    } as unknown as ResolvedAgentCoreRuntime;
    const options = { assumeRole: true } as never;
    mixedMode([]);
    expect(await resolveAgentCoreAssumeRoleArn(options, runtime, state)).toBeUndefined();
    expect(warnings().join('\n')).toContain('AWS_ENDPOINT_URL_IAM');
    const real = { resolveAgentCoreRuntimeRoleArn: vi.fn(async () => REAL) };
    expect(await resolveAgentCoreAssumeRoleArn(options, runtime, state, real)).toBe(REAL);
    mixedMode(['IAM']);
    expect(await resolveAgentCoreAssumeRoleArn(options, runtime, state)).toBe(FROM_STATE);
  });
});
