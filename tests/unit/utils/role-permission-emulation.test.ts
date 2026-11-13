/**
 * go-to-k/cdk-local#929: when the real AssumeRole of an execution role is
 * refused with AccessDenied, every execution-role assume emulates the role's
 * permissions with session policies — GetFederationToken for an IAM user,
 * AssumeRole of `--emulate-role-via` otherwise — and warns that it is an
 * approximation. When emulation is not possible, each site keeps its old
 * refused-assume outcome.
 */
import { rmSync } from 'node:fs';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ResolvedLambda } from '../../../src/local/lambda-resolver.js';
import type { ResolvedAgentCoreRuntime } from '../../../src/local/agentcore-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import { getLogger } from '../../../src/utils/logger.js';

const ACCOUNT = '123456789012';
let roleSeq = 0;
let ROLE = `arn:aws:iam::${ACCOUNT}:role/ExecRole`;
const VIA = `arn:aws:iam::${ACCOUNT}:role/DevRole`;
const USER_ARN = `arn:aws:iam::${ACCOUNT}:user/goto`;
const ASSUMED_ARN = `arn:aws:sts::${ACCOUNT}:assumed-role/SSORole/goto`;
const SECRET = 'emulated-secret-value-not-for-logs';
const DENY_ALL =
  '{"Version":"2012-10-17","Statement":[{"Effect":"Deny","Action":"*","Resource":"*"}]}';

const aws = vi.hoisted(() => ({
  sent: [] as Array<{ name: string; input: Record<string, unknown> }>,
  /** Every SDK client constructor config (STS and IAM), in order. */
  configs: [] as Array<{ client: string; config: Record<string, unknown> }>,
  callerArn: 'arn:aws:iam::123456789012:user/goto',
  callerIdError: undefined as unknown,
  /** Fail the AssumeRole whose RoleArn is this one (the execution role). */
  denyRole: undefined as string | undefined,
  denyError: undefined as unknown,
  tokenError: undefined as unknown,
  tokenEmpty: false,
  tokenUndefined: false,
  iamError: undefined as unknown,
  inline: {} as Record<string, unknown>,
  managed: [] as string[],
  boundary: undefined as string | undefined,
  /** Split the List* answers into pages of this size (0: one page). */
  pageSize: 0,
}));

function command(name: string) {
  return vi.fn(function (this: Record<string, unknown>, input: Record<string, unknown>) {
    this['__name'] = name;
    this['input'] = input;
  });
}

function accessDenied(): Error {
  return Object.assign(new Error('User is not authorized to perform: sts:AssumeRole'), {
    name: 'AccessDenied',
    $fault: 'client',
    $metadata: { httpStatusCode: 403 },
  });
}

function page<T>(items: T[], marker: unknown): { items: T[]; IsTruncated: boolean; Marker?: string } {
  if (aws.pageSize === 0) return { items, IsTruncated: false };
  const start = marker === undefined ? 0 : Number(String(marker).replace('m', ''));
  const end = start + aws.pageSize;
  return {
    items: items.slice(start, end),
    IsTruncated: end < items.length,
    ...(end < items.length && { Marker: `m${end}` }),
  };
}

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn(function STSClient(config: Record<string, unknown>) {
    aws.configs.push({ client: 'STS', config });
    return {
      config: { region: async () => 'us-east-1' },
      send: vi.fn(async (cmd: { __name: string; input: Record<string, unknown> }) => {
        aws.sent.push({ name: cmd.__name, input: cmd.input });
        if (cmd.__name === 'GetCallerIdentity') {
          if (aws.callerIdError !== undefined) throw aws.callerIdError;
          return { Arn: aws.callerArn, Account: '123456789012' };
        }
        if (cmd.__name === 'AssumeRole' && cmd.input['RoleArn'] === aws.denyRole) {
          throw aws.denyError ?? accessDenied();
        }
        if (cmd.__name === 'AssumeRole' || cmd.__name === 'GetFederationToken') {
          if (aws.tokenError !== undefined) throw aws.tokenError;
          if (aws.tokenUndefined) return undefined;
          if (aws.tokenEmpty) return {};
          return {
            Credentials: {
              AccessKeyId: `ASIA-${cmd.__name}`,
              SecretAccessKey: 'emulated-secret-value-not-for-logs',
              SessionToken: `token-${cmd.__name}`,
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
  IAMClient: vi.fn(function IAMClient(config: Record<string, unknown>) {
    aws.configs.push({ client: 'IAM', config });
    return {
      send: vi.fn(async (cmd: { __name: string; input: Record<string, unknown> }) => {
        aws.sent.push({ name: cmd.__name, input: cmd.input });
        if (aws.iamError !== undefined) throw aws.iamError;
        if (cmd.__name === 'GetRole') {
          return {
            Role: aws.boundary
              ? { PermissionsBoundary: { PermissionsBoundaryArn: aws.boundary } }
              : {},
          };
        }
        if (cmd.__name === 'ListRolePolicies') {
          const p = page(Object.keys(aws.inline), cmd.input['Marker']);
          return { PolicyNames: p.items, IsTruncated: p.IsTruncated, Marker: p.Marker };
        }
        if (cmd.__name === 'GetRolePolicy') {
          const doc = aws.inline[cmd.input['PolicyName'] as string];
          if (typeof doc === 'string') return { PolicyDocument: encodeURIComponent(doc) };
          return { PolicyDocument: encodeURIComponent(JSON.stringify(doc)) };
        }
        if (cmd.__name === 'ListAttachedRolePolicies') {
          const p = page(aws.managed, cmd.input['Marker']);
          return {
            AttachedPolicies: p.items.map((PolicyArn) => ({ PolicyArn })),
            IsTruncated: p.IsTruncated,
            Marker: p.Marker,
          };
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

const {
  buildSessionPolicy,
  emulateRoleAfterDeniedAssume,
  isAssumeRoleAccessDenied,
  SESSION_POLICY_MAX_CHARS,
  __resetRoleEmulationWarnings,
} = await import('../../../src/utils/role-permission-emulation.js');
const { assumeRoleCredentials, AssumeRoleFailure } = await import(
  '../../../src/utils/role-arn.js'
);
const { emulateRoleViaOption, warnIfEmulateRoleViaUnused, isRoleFlagRequested } = await import(
  '../../../src/cli/options.js'
);
const { resolveLambdaContainerEnv } = await import('../../../src/cli/commands/local-invoke.js');
const { buildContainerSpec } = await import('../../../src/cli/commands/local-start-api.js');
const { buildContainerEnv, resolveHostCredentialsForSigV4 } = await import(
  '../../../src/cli/commands/local-invoke-agentcore.js'
);
const { assumeTaskRoleForTest: assumeServiceTaskRole } = await import(
  '../../../src/cli/commands/ecs-service-emulator.js'
);
const { assumeTaskRoleForTest: assumeRunTaskRole } = await import(
  '../../../src/cli/commands/local-run-task.js'
);
const { buildLambdaEnvOptions } = await import(
  '../../../src/cli/commands/local-start-cloudfront.js'
);
const { LocalStartServiceError } = await import('../../../src/utils/error-handler.js');

const S3_LIST = {
  Version: '2012-10-17',
  Statement: [{ Sid: 'List', Effect: 'Allow', Action: 's3:ListAllMyBuckets', Resource: '*' }],
};
const LOGS = {
  Version: '2012-10-17',
  Statement: { Sid: 'List', Effect: 'Allow', Action: 'logs:PutLogEvents', Resource: '*' },
};
const BASIC = 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole';

const ENV_KEYS = [
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
] as const;
const savedEnv: Record<string, string | undefined> = {};
let warn: ReturnType<typeof vi.spyOn>;
const args = {
  roleArn: ROLE,
  region: 'us-east-1' as string | undefined,
  profile: undefined as string | undefined,
  flag: '--assume-role',
  sessionNameSuffix: 'start-service',
};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  ROLE = `arn:aws:iam::${ACCOUNT}:role/ExecRole${++roleSeq}`;
  args.roleArn = ROLE;
  aws.sent = [];
  aws.configs = [];
  aws.callerArn = USER_ARN;
  aws.callerIdError = undefined;
  aws.denyRole = ROLE;
  aws.denyError = undefined;
  aws.tokenError = undefined;
  aws.tokenEmpty = false;
  aws.tokenUndefined = false;
  aws.iamError = undefined;
  aws.inline = { A: S3_LIST, B: LOGS };
  aws.managed = [BASIC];
  aws.boundary = undefined;
  aws.pageSize = 0;
  warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  warn.mockRestore();
  __resetRoleEmulationWarnings();
});

const warnings = (): string =>
  (warn.mock.calls as unknown[][]).map((c) => String(c[0])).join('\n');
const sentNames = (): string[] => aws.sent.map((s) => s.name);
const sent = (name: string) => aws.sent.find((s) => s.name === name);

describe('buildSessionPolicy', () => {
  it('combines every inline policy into one minified document without Sids', () => {
    expect(buildSessionPolicy({ inline: [S3_LIST, LOGS], managedArns: [] })).toEqual({
      ok: true,
      policy:
        '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:ListAllMyBuckets","Resource":"*"},{"Effect":"Allow","Action":"logs:PutLogEvents","Resource":"*"}]}',
      policyArns: [],
    });
  });

  it('denies everything for a role with no policies (no session policy would grant all)', () => {
    expect(buildSessionPolicy({ inline: [], managedArns: [] })).toEqual({
      ok: true,
      policy: DENY_ALL,
      policyArns: [],
    });
  });

  it('denies everything when the inline policies have no statement and nothing is managed', () => {
    const plan = buildSessionPolicy({
      inline: [{ Version: '2012-10-17', Statement: [] }, { Version: '2012-10-17' }],
      managedArns: [],
    });
    expect(plan).toEqual({ ok: true, policy: DENY_ALL, policyArns: [] });
  });

  it('passes only the ARNs (no Policy) when the role has managed policies alone', () => {
    expect(buildSessionPolicy({ inline: [], managedArns: [BASIC] })).toEqual({
      ok: true,
      policy: '',
      policyArns: [BASIC],
    });
  });

  it('refuses more than 10 managed policies', () => {
    const arns = Array.from({ length: 11 }, (_, i) => `arn:aws:iam::aws:policy/P${i}`);
    const plan = buildSessionPolicy({ inline: [], managedArns: arns });
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.reason).toContain('11 managed policies');
  });

  /** An inline document whose minified session policy is exactly `chars` long. */
  function inlineOf(chars: number): unknown {
    const doc = (pad: string) => ({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: `arn:aws:s3:::${pad}` }],
    });
    const base = buildSessionPolicy({ inline: [doc('')], managedArns: [] });
    return doc('b'.repeat(chars - (base.ok ? base.policy.length : 0)));
  }
  const ARN_49 = `arn:aws:iam::aws:policy/${'x'.repeat(49 - 24)}`;

  it('counts the managed ARNs: 2,000 inline characters plus a 49-character ARN is refused', () => {
    expect(ARN_49).toHaveLength(49);
    const plan = buildSessionPolicy({ inline: [inlineOf(2000)], managedArns: [ARN_49] });
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.reason).toContain('2049 characters');
  });

  it('accepts exactly 2,048 characters', () => {
    const plan = buildSessionPolicy({ inline: [inlineOf(1999)], managedArns: [ARN_49] });
    expect(plan.ok).toBe(true);
    expect(plan.ok && plan.policy.length + ARN_49.length).toBe(SESSION_POLICY_MAX_CHARS);
  });

  it('refuses inline policies whose Versions differ', () => {
    const plan = buildSessionPolicy({
      inline: [S3_LIST, { ...LOGS, Version: '2008-10-17' }],
      managedArns: [],
    });
    expect(plan.ok).toBe(false);
  });
});

describe('isAssumeRoleAccessDenied', () => {
  it('is the AccessDenied name', () => {
    expect(isAssumeRoleAccessDenied(accessDenied())).toBe(true);
  });

  it.each(['InvalidClientTokenId', 'SignatureDoesNotMatch', 'ExpiredToken'])(
    'is not a bare 403 (%s: broken caller credentials)',
    (name) => {
      expect(isAssumeRoleAccessDenied({ name, $metadata: { httpStatusCode: 403 } })).toBe(false);
    }
  );
});

describe('emulateRoleAfterDeniedAssume', () => {
  it('does nothing, and warns nothing, for a failure that is not AccessDenied', async () => {
    const err = Object.assign(new Error('bad token'), {
      name: 'InvalidClientTokenId',
      $metadata: { httpStatusCode: 403 },
    });
    expect(await emulateRoleAfterDeniedAssume(err, args)).toBeUndefined();
    expect(aws.sent).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('an IAM user gets GetFederationToken with the role policies as session policies', async () => {
    const creds = await emulateRoleAfterDeniedAssume(accessDenied(), args);
    expect(creds?.accessKeyId).toBe('ASIA-GetFederationToken');
    const token = sent('GetFederationToken');
    expect(JSON.parse(token?.input['Policy'] as string).Statement).toHaveLength(2);
    expect(token?.input['PolicyArns']).toEqual([{ arn: BASIC }]);
    expect(String(token?.input['Name'])).toMatch(/^[\w+=,.@-]{2,32}$/);
    expect(sentNames()).not.toContain('AssumeRole');
    const text = warnings();
    expect(text).toContain('EMULATED');
    expect(text).toContain('APPROXIMATION');
    expect(text).toContain('resource-based policies');
    expect(text).toContain('session tags');
    expect(text).toContain('aws:username');
    expect(text).toContain('cannot call IAM, nor STS except GetCallerIdentity');
    expect(text).not.toContain(SECRET);
  });

  it('a managed-only role sends no Policy key', async () => {
    aws.inline = {};
    await emulateRoleAfterDeniedAssume(accessDenied(), args);
    const token = sent('GetFederationToken');
    expect(token?.input).not.toHaveProperty('Policy');
    expect(token?.input['PolicyArns']).toEqual([{ arn: BASIC }]);
  });

  it('a policy-less role sends the deny-all policy and no ARNs', async () => {
    aws.inline = {};
    aws.managed = [];
    await emulateRoleAfterDeniedAssume(accessDenied(), args);
    const token = sent('GetFederationToken');
    expect(token?.input['Policy']).toBe(DENY_ALL);
    expect(token?.input).not.toHaveProperty('PolicyArns');
  });

  it('reads the role by the last segment of a path role ARN', async () => {
    await emulateRoleAfterDeniedAssume(accessDenied(), {
      ...args,
      roleArn: `arn:aws:iam::${ACCOUNT}:role/service-role/X`,
    });
    expect(sent('ListRolePolicies')?.input['RoleName']).toBe('X');
    expect(sent('ListAttachedRolePolicies')?.input['RoleName']).toBe('X');
  });

  it('follows every List* page and uses the policies of all of them', async () => {
    aws.pageSize = 1;
    aws.managed = [BASIC, 'arn:aws:iam::aws:policy/Other'];
    await emulateRoleAfterDeniedAssume(accessDenied(), args);
    const lists = aws.sent.filter((s) => s.name === 'ListRolePolicies');
    expect(lists.map((s) => s.input['Marker'])).toEqual([undefined, 'm1']);
    const attached = aws.sent.filter((s) => s.name === 'ListAttachedRolePolicies');
    expect(attached.map((s) => s.input['Marker'])).toEqual([undefined, 'm1']);
    const token = sent('GetFederationToken');
    expect(JSON.parse(token?.input['Policy'] as string).Statement).toHaveLength(2);
    expect(token?.input['PolicyArns']).toHaveLength(2);
  });

  it('prints the approximation notice once per role', async () => {
    await emulateRoleAfterDeniedAssume(accessDenied(), args);
    await emulateRoleAfterDeniedAssume(accessDenied(), args);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a non-IAM-user caller without --emulate-role-via is not emulated, and is told the flag', async () => {
    aws.callerArn = ASSUMED_ARN;
    expect(await emulateRoleAfterDeniedAssume(accessDenied(), args)).toBeUndefined();
    expect(sentNames()).toEqual(['GetCallerIdentity']);
    expect(warnings()).toContain('--emulate-role-via');
  });

  it('prints the cannot-emulate warning once per role (agentcore assumes up to 3 times)', async () => {
    aws.callerArn = ASSUMED_ARN;
    for (let i = 0; i < 3; i++) await emulateRoleAfterDeniedAssume(accessDenied(), args);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('--emulate-role-via assumes that role with the session policies', async () => {
    aws.callerArn = ASSUMED_ARN;
    const creds = await emulateRoleAfterDeniedAssume(accessDenied(), {
      ...args,
      emulateRoleVia: VIA,
    });
    expect(creds?.accessKeyId).toBe('ASIA-AssumeRole');
    const assume = sent('AssumeRole');
    expect(assume?.input['RoleArn']).toBe(VIA);
    expect(assume?.input['Policy']).toBeTypeOf('string');
    expect(assume?.input['PolicyArns']).toHaveLength(1);
    expect(String(assume?.input['RoleSessionName'])).toMatch(/^[\w+=,.@-]{2,64}$/);
    expect(sentNames()).not.toContain('GetFederationToken');
    expect(warnings()).toContain('APPROXIMATION');
    expect(warnings()).not.toContain('cannot call IAM');
  });

  it('refuses a malformed --emulate-role-via before sending it (guarded send)', async () => {
    const creds = await emulateRoleAfterDeniedAssume(accessDenied(), {
      ...args,
      emulateRoleVia: 'arn:aws:iam::1:role/x\nforged',
    });
    expect(creds).toBeUndefined();
    expect(sentNames()).toEqual(['GetCallerIdentity']);
    expect(warnings()).toContain('not a well-formed IAM role ARN');
  });

  it('refuses a role in another account (IAM is read by name in the caller account)', async () => {
    const other = 'arn:aws:iam::999999999999:role/ExecRole';
    expect(
      await emulateRoleAfterDeniedAssume(accessDenied(), { ...args, roleArn: other })
    ).toBeUndefined();
    expect(sentNames()).toEqual(['GetCallerIdentity']);
    expect(warnings()).toContain("not in your credentials' account");
  });

  it('refuses a role with a permissions boundary (session policies are a union, so it would widen)', async () => {
    aws.boundary = 'arn:aws:iam::123456789012:policy/Boundary';
    expect(await emulateRoleAfterDeniedAssume(accessDenied(), args)).toBeUndefined();
    expect(sentNames()).not.toContain('GetFederationToken');
    expect(warnings()).toContain('permissions boundary');
  });

  it('warns again when a later attempt fails for a different reason', async () => {
    aws.callerArn = ASSUMED_ARN;
    await emulateRoleAfterDeniedAssume(accessDenied(), args);
    aws.callerArn = USER_ARN;
    aws.boundary = 'arn:aws:iam::123456789012:policy/Boundary';
    await emulateRoleAfterDeniedAssume(accessDenied(), args);
    await emulateRoleAfterDeniedAssume(accessDenied(), args);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('a non-JSON inline policy document never reaches a log line', async () => {
    const debug = vi.spyOn(getLogger(), 'debug').mockImplementation(() => undefined);
    aws.inline = { Bad: 'SNIPPET-OF-THE-POLICY' };
    expect(await emulateRoleAfterDeniedAssume(accessDenied(), args)).toBeUndefined();
    const all = [...warn.mock.calls, ...debug.mock.calls].map((c) => String(c[0])).join('\n');
    debug.mockRestore();
    expect(all).toContain('not valid JSON');
    expect(all).not.toContain('SNIPPET');
  });

  it('over the limits: warns and asks STS for nothing', async () => {
    aws.managed = Array.from({ length: 11 }, (_, i) => `arn:aws:iam::aws:policy/P${i}`);
    expect(await emulateRoleAfterDeniedAssume(accessDenied(), args)).toBeUndefined();
    expect(sentNames()).not.toContain('GetFederationToken');
    expect(warnings()).toContain('11 managed policies');
  });

  it.each(['PackedPolicyTooLargeException', 'PackedPolicyTooLarge'])(
    '%s gets its dedicated message',
    async (name) => {
      aws.tokenError = Object.assign(new Error('packed too large'), {
        name,
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      });
      expect(await emulateRoleAfterDeniedAssume(accessDenied(), args)).toBeUndefined();
      expect(warnings()).toContain(
        'larger than STS accepts as session policies (PackedPolicyTooLarge)'
      );
    }
  );

  it('a refused GetFederationToken (temporary IAM-user credentials) points at --emulate-role-via', async () => {
    aws.tokenError = Object.assign(
      new Error('Cannot call GetFederationToken with session credentials'),
      { name: 'AccessDenied', $fault: 'client', $metadata: { httpStatusCode: 403 } }
    );
    expect(await emulateRoleAfterDeniedAssume(accessDenied(), args)).toBeUndefined();
    expect(warnings()).toContain('Temporary IAM user credentials');
    expect(warnings()).toContain('--emulate-role-via');
  });

  it.each([
    ['no usable credentials', () => (aws.tokenEmpty = true), 'STS returned no usable credentials'],
    [
      'a GetCallerIdentity failure',
      () =>
        (aws.callerIdError = Object.assign(new Error('x'), {
          name: 'Throttling',
          $fault: 'client',
          $metadata: {},
        })),
      'cannot be emulated',
    ],
    [
      'an IAM read failure',
      () =>
        (aws.iamError = Object.assign(new Error('no iam'), {
          name: 'AccessDenied',
          $fault: 'client',
          $metadata: {},
        })),
      "reading the role's policies failed",
    ],
    [
      'an unexpected exception',
      () => (aws.tokenUndefined = true),
      "emulating the role's permissions failed",
    ],
  ])('%s: undefined and a warning, never a throw', async (_label, arrange, warned) => {
    arrange();
    expect(await emulateRoleAfterDeniedAssume(accessDenied(), args)).toBeUndefined();
    expect(warnings()).toContain(warned);
  });

  it('builds both emulation clients on the refused hop config (region, profile)', async () => {
    await emulateRoleAfterDeniedAssume(accessDenied(), { ...args, profile: 'dev' });
    const iam = aws.configs.find((c) => c.client === 'IAM')?.config;
    const stsCfg = aws.configs.find((c) => c.client === 'STS')?.config;
    expect(iam).toMatchObject({ region: 'us-east-1', profile: 'dev' });
    expect(stsCfg).toMatchObject({ region: 'us-east-1', profile: 'dev' });
  });
});

describe('assumeRoleCredentials falls back to emulation on a refused assume', () => {
  const hop = (extra: Record<string, unknown> = {}) =>
    assumeRoleCredentials({
      roleArn: ROLE,
      region: 'us-east-1',
      profile: undefined,
      sessionNameSuffix: 'invoke',
      ...extra,
    });

  it('returns the emulated credentials (IAM user, no flag)', async () => {
    const creds = await hop();
    expect(creds.accessKeyId).toBe('ASIA-GetFederationToken');
    expect(warnings()).toContain(`--assume-role: AssumeRole(${ROLE}) was refused`);
  });

  it('assumes --emulate-role-via for a non-IAM-user caller, naming the given flag', async () => {
    aws.callerArn = ASSUMED_ARN;
    const creds = await hop({ emulateRoleVia: VIA, roleFlag: '--assume-task-role' });
    expect(creds.accessKeyId).toBe('ASIA-AssumeRole');
    expect(aws.sent.filter((s) => s.name === 'AssumeRole').map((s) => s.input['RoleArn'])).toEqual(
      [ROLE, VIA]
    );
    expect(warnings()).toContain('--assume-task-role: AssumeRole(');
  });

  it('emulation impossible: the ORIGINAL refusal is thrown, as before', async () => {
    aws.callerArn = ASSUMED_ARN;
    const err = await hop().then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(AssumeRoleFailure);
    expect((err as Error).message).toContain(
      'AccessDenied: User is not authorized to perform: sts:AssumeRole'
    );
  });

  it('a refusal that is not AccessDenied is not emulated', async () => {
    aws.denyError = Object.assign(new Error('expired'), {
      name: 'ExpiredToken',
      $fault: 'client',
      $metadata: { httpStatusCode: 403 },
    });
    await expect(hop()).rejects.toThrow(/ExpiredToken/);
    expect(sentNames()).toEqual(['AssumeRole']);
  });

  it('a trusted role is assumed directly, with no emulation', async () => {
    aws.denyRole = undefined;
    const creds = await hop({ emulateRoleVia: VIA });
    expect(creds.accessKeyId).toBe('ASIA-AssumeRole');
    expect(sentNames()).toEqual(['AssumeRole']);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('--emulate-role-via reaches each execution-role assume (assumed-role caller)', () => {
  beforeEach(() => {
    aws.callerArn = ASSUMED_ARN;
  });
  const viaAssumed = (): boolean =>
    aws.sent.some((s) => s.name === 'AssumeRole' && s.input['RoleArn'] === VIA);

  const inlineTmpDirs = new Set<string>();
  afterEach(() => {
    for (const d of inlineTmpDirs) rmSync(d, { recursive: true, force: true });
    inlineTmpDirs.clear();
  });

  function lambdaStack(): StackInfo {
    return {
      stackName: 'S',
      displayName: 'S',
      artifactId: 'S',
      dependencyNames: [],
      region: 'us-east-1',
      template: {
        Resources: {
          Fn: {
            Type: 'AWS::Lambda::Function',
            Properties: {
              Runtime: 'nodejs20.x',
              Handler: 'index.handler',
              Code: { ZipFile: 'exports.handler = () => {};' },
            },
          },
        },
      },
    } as unknown as StackInfo;
  }

  it('invoke / start-cloudfront / start-alb Lambda / start-microvm / start-web-function: resolveLambdaContainerEnv', async () => {
    const stack = lambdaStack();
    const lambda = {
      kind: 'zip',
      stack,
      logicalId: 'Fn',
      resource: stack.template.Resources!['Fn'],
      memoryMb: 128,
      timeoutSec: 3,
      layers: [],
      runtime: 'nodejs20.x',
      handler: 'index.handler',
      codePath: '/tmp/code',
    } as unknown as ResolvedLambda;
    const result = await resolveLambdaContainerEnv(
      lambda,
      { assumeRole: ROLE, emulateRoleVia: VIA },
      undefined
    );
    expect(viaAssumed()).toBe(true);
    expect(result.env['AWS_ACCESS_KEY_ID']).toBe('ASIA-AssumeRole');
    expect(result.assumeRoleApplied).toBe(true);
  });

  it('invoke: emulation impossible keeps the shell-credentials fallback warning', async () => {
    const stack = lambdaStack();
    const lambda = {
      kind: 'zip',
      stack,
      logicalId: 'Fn',
      resource: stack.template.Resources!['Fn'],
      memoryMb: 128,
      timeoutSec: 3,
      layers: [],
      runtime: 'nodejs20.x',
      handler: 'index.handler',
      codePath: '/tmp/code',
    } as unknown as ResolvedLambda;
    const result = await resolveLambdaContainerEnv(lambda, { assumeRole: ROLE }, undefined);
    expect(result.assumeRoleApplied).toBe(false);
    expect(warnings()).toContain("Falling back to the developer's shell credentials");
  });

  it('start-cloudfront: buildLambdaEnvOptions carries --emulate-role-via', () => {
    expect(
      buildLambdaEnvOptions({ assumeRole: true, emulateRoleVia: VIA } as never, undefined)
    ).toMatchObject({ assumeRole: true, emulateRoleVia: VIA });
  });

  it('start-api: buildContainerSpec', async () => {
    const spec = await buildContainerSpec({
      logicalId: 'Fn',
      stacks: [lambdaStack()],
      overrides: undefined,
      assumeRole: { globalArn: ROLE, perLambda: {} },
      emulateRoleVia: VIA,
      containerHost: '127.0.0.1',
      stsRegion: 'us-east-1',
      inlineTmpDirs,
      layerTmpDirs: new Set(),
      stateByStack: new Map(),
      skipPull: true,
    } as never);
    expect(viaAssumed()).toBe(true);
    expect(spec.env['AWS_ACCESS_KEY_ID']).toBe('ASIA-AssumeRole');
  });

  it('start-service / start-alb: the task-role assume', async () => {
    const creds = await assumeServiceTaskRole(ROLE, 'us-east-1', undefined, VIA);
    expect(viaAssumed()).toBe(true);
    expect(creds.accessKeyId).toBe('ASIA-AssumeRole');
  });

  it('start-service: the warnings name the flag the user typed', async () => {
    await expect(
      assumeServiceTaskRole(ROLE, 'us-east-1', undefined, undefined, '--assume-task-role')
    ).rejects.toThrow(LocalStartServiceError);
    expect(warnings()).toContain('--assume-task-role: AssumeRole(');
  });

  it('start-service / start-alb: emulation impossible keeps the LocalStartServiceError', async () => {
    await expect(assumeServiceTaskRole(ROLE, 'us-east-1', undefined, undefined)).rejects.toThrow(
      LocalStartServiceError
    );
  });

  it('run-task: the task-role assume', async () => {
    const creds = await assumeRunTaskRole(ROLE, 'us-east-1', undefined, VIA);
    expect(viaAssumed()).toBe(true);
    expect(creds.accessKeyId).toBe('ASIA-AssumeRole');
  });

  const runtime = (): ResolvedAgentCoreRuntime =>
    ({
      stack: { stackName: 'S', region: 'us-east-1' },
      logicalId: 'Agent',
      resource: { Type: 'AWS::BedrockAgentCore::Runtime', Properties: {} },
      containerUri: 'repo:tag',
      environmentVariables: {},
      protocol: 'HTTP',
    }) as unknown as ResolvedAgentCoreRuntime;

  it('invoke-agentcore / start-agentcore: buildContainerEnv', async () => {
    const out = await buildContainerEnv(
      runtime(),
      {
        platform: 'linux/arm64',
        pull: true,
        build: true,
        region: 'us-east-1',
        assumeRole: ROLE,
        emulateRoleVia: VIA,
      } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    );
    expect(viaAssumed()).toBe(true);
    expect(out.env['AWS_ACCESS_KEY_ID']).toBe('ASIA-AssumeRole');
  });

  it('invoke-agentcore: emulation impossible keeps the shell-credentials fallback', async () => {
    const out = await buildContainerEnv(
      runtime(),
      { platform: 'linux/arm64', pull: true, build: true, region: 'us-east-1', assumeRole: ROLE } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    );
    expect(out.env['AWS_ACCESS_KEY_ID']).toBeUndefined();
    expect(warnings()).toContain("Falling back to the developer's shell credentials");
  });

  it('invoke-agentcore --sigv4: resolveHostCredentialsForSigV4', async () => {
    const creds = await resolveHostCredentialsForSigV4(
      { assumeRole: ROLE, emulateRoleVia: VIA } as never,
      runtime() as never,
      undefined,
      'us-east-1',
      undefined
    );
    expect(viaAssumed()).toBe(true);
    expect(creds.accessKeyId).toBe('ASIA-AssumeRole');
  });
});

describe('--emulate-role-via option', () => {
  const parse = (argv: string[]): Record<string, unknown> => {
    const cmd = new Command().exitOverride().addOption(emulateRoleViaOption('--assume-role'));
    cmd.configureOutput({ writeErr: () => undefined });
    cmd.parse(argv, { from: 'user' });
    return cmd.opts();
  };

  it('parses a role ARN', () => {
    expect(parse(['--emulate-role-via', VIA])['emulateRoleVia']).toBe(VIA);
  });

  it('refuses a malformed ARN at parse', () => {
    expect(() => parse(['--emulate-role-via', 'DevRole'])).toThrow(/--emulate-role-via/);
  });

  it('warns that it has no effect without the role flag', () => {
    warnIfEmulateRoleViaUnused(VIA, { roleFlag: '--assume-role', roleRequested: false });
    expect(warnings()).toContain('--emulate-role-via has no effect without --assume-role');
  });

  it('is silent with the role flag, or without the option', () => {
    warnIfEmulateRoleViaUnused(VIA, { roleFlag: '--assume-role', roleRequested: true });
    warnIfEmulateRoleViaUnused(undefined, { roleFlag: '--assume-role', roleRequested: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    [true, true],
    ['arn', true],
    [false, false],
    [undefined, false],
  ] as const)('isRoleFlagRequested(%s) is %s', (value, expected) => {
    expect(isRoleFlagRequested(value)).toBe(expected);
  });
});
