import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// Capture every STSClient construction + AssumeRoleCommand input so the
// tests can assert the shared helper's wire behavior without a real AWS
// call (issue #509 — the single implementation behind every command's
// `--assume-role` / `--assume-task-role` path).
const { sent, clientConfigs, destroyed, sendImpl } = vi.hoisted(() => ({
  sent: [] as unknown[],
  clientConfigs: [] as unknown[],
  destroyed: { count: 0 },
  sendImpl: {
    fn: async (): Promise<unknown> => ({
      Credentials: {
        AccessKeyId: 'AKIATEST',
        SecretAccessKey: 'secretTEST',
        SessionToken: 'tokTEST',
      },
    }),
  },
}));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    constructor(config: unknown) {
      clientConfigs.push(config);
    }
    async send(command: unknown): Promise<unknown> {
      sent.push(command);
      return sendImpl.fn();
    }
    destroy(): void {
      destroyed.count += 1;
    }
  },
  AssumeRoleCommand: class {
    constructor(public input: unknown) {}
  },
}));

import { assumeRoleCredentials } from '../../../src/utils/role-arn.js';

const ROLE_ARN = 'arn:aws:iam::111111111111:role/AppRole';

describe('assumeRoleCredentials (issue #509 shared helper)', () => {
  beforeEach(() => {
    sent.length = 0;
    clientConfigs.length = 0;
    destroyed.count = 0;
    sendImpl.fn = async () => ({
      Credentials: {
        AccessKeyId: 'AKIATEST',
        SecretAccessKey: 'secretTEST',
        SessionToken: 'tokTEST',
      },
    });
  });

  it('returns the minted credentials and destroys the client', async () => {
    const creds = await assumeRoleCredentials({
      roleArn: ROLE_ARN,
      region: 'us-east-1',
      profile: undefined,
      sessionNameSuffix: 'invoke',
    });
    expect(creds).toEqual({
      accessKeyId: 'AKIATEST',
      secretAccessKey: 'secretTEST',
      sessionToken: 'tokTEST',
    });
    expect(destroyed.count).toBe(1);
  });

  it('builds the RoleSessionName from the embed prefix + caller suffix, 1h duration', async () => {
    await assumeRoleCredentials({
      roleArn: ROLE_ARN,
      region: undefined,
      profile: undefined,
      sessionNameSuffix: 'start-service',
    });
    const input = (sent[0] as { input: Record<string, unknown> }).input;
    expect(input['RoleArn']).toBe(ROLE_ARN);
    expect(input['RoleSessionName']).toMatch(/^cdkl-start-service-\d+$/);
    expect(input['DurationSeconds']).toBe(3600);
  });

  it('threads --profile and --region into the STS client config (issue #245)', async () => {
    await assumeRoleCredentials({
      roleArn: ROLE_ARN,
      region: 'eu-west-1',
      profile: 'dev',
      sessionNameSuffix: 'run-task',
    });
    expect(clientConfigs[0]).toMatchObject({ region: 'eu-west-1', profile: 'dev' });
  });

  it('throws a plain Error when the response has no usable credentials', async () => {
    sendImpl.fn = async () => ({ Credentials: { AccessKeyId: 'AKIATEST' } });
    await expect(
      assumeRoleCredentials({
        roleArn: ROLE_ARN,
        region: undefined,
        profile: undefined,
        sessionNameSuffix: 'invoke',
      })
    ).rejects.toThrow(`AssumeRole(${ROLE_ARN}) returned no usable credentials.`);
    expect(destroyed.count).toBe(1);
  });

  it("surfaces the no-credentials failure through the caller's makeError class", async () => {
    class CallerError extends Error {}
    sendImpl.fn = async () => ({});
    await expect(
      assumeRoleCredentials({
        roleArn: ROLE_ARN,
        region: undefined,
        profile: undefined,
        sessionNameSuffix: 'start-service',
        makeError: (message) => new CallerError(message),
      })
    ).rejects.toBeInstanceOf(CallerError);
  });

  it('propagates an STS transport error unwrapped even when makeError is set', async () => {
    class CallerError extends Error {}
    const transport = new Error('connect ETIMEDOUT');
    sendImpl.fn = async () => {
      throw transport;
    };
    const failure = await assumeRoleCredentials({
      roleArn: ROLE_ARN,
      region: undefined,
      profile: undefined,
      sessionNameSuffix: 'start-api',
      makeError: (message) => new CallerError(message),
    }).then(
      () => undefined,
      (err: unknown) => err
    );
    expect(failure).toBe(transport);
    expect(destroyed.count).toBe(1);
  });
});

// Site-level binding lock (same pattern as sts-client-profile-audit): the
// four command call sites delegate to the shared helper through thin,
// non-exported wrappers, so a dropped `sessionNameSuffix` / `makeError`
// would not fail any behavioral test — grep the source instead.
describe('assumeRoleCredentials call-site bindings', () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const commandsDir = join(here, '..', '..', '..', 'src', 'cli', 'commands');
  const read = (file: string): string => readFileSync(join(commandsDir, file), 'utf-8');

  it.each([
    ['local-invoke.ts', 'invoke'],
    ['local-start-api.ts', 'start-api'],
    ['local-run-task.ts', 'run-task'],
    ['ecs-service-emulator.ts', 'start-service'],
  ])('%s mints via the shared helper with suffix %s', (file, suffix) => {
    const source = read(file);
    expect(source).toContain(`sessionNameSuffix: '${suffix}'`);
    expect(source).toMatch(/assumeRoleCredentials\(\{/);
    // No residual inline AssumeRole implementation may survive in the
    // command file (issue #509 — the duplication this helper replaced).
    expect(source).not.toMatch(/new AssumeRoleCommand\(/);
  });

  it('the emulator preserves LocalStartServiceError via makeError', () => {
    const source = read('ecs-service-emulator.ts');
    expect(source).toMatch(/makeError:\s*\(message\)\s*=>\s*new LocalStartServiceError\(message\)/);
  });
});
