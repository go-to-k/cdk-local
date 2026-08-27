import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

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

import {
  applyRoleArnIfSet,
  assumeRoleCredentials,
  AssumeRoleFailure,
} from '../../../src/utils/role-arn.js';
import { getLogger } from '../../../src/utils/logger.js';

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

  /**
   * CONTRACT CHANGE, issue #579 review round 4. This case previously asserted
   * `expect(failure).toBe(transport)` — the raw SDK error propagating by
   * identity. That was the documented behaviour ("STS transport errors always
   * propagate unwrapped") and it is exactly the defect: nothing between here
   * and `withErrorHandling` -> `formatError` caught it, so `formatError`
   * printed `${error.name}: ${error.message}` unflattened and unclamped at
   * DEFAULT level, from every `--assume-role` path in the CLI. A
   * `CredentialsProviderError`'s message can be a `credential_process` command
   * line.
   *
   * The error is now wrapped through the caller's `makeError` (so a caller
   * that catches its own class keeps working, and now does so for transport
   * failures too, which it could not before) with the detail rendered by the
   * shared credential-error policy.
   */
  it('wraps an STS transport error through makeError and withholds its message', async () => {
    class CallerError extends Error {}
    const transport = new Error('Command failed: /opt/bin/get-creds --pass s3cr3t');
    Object.defineProperty(transport, 'name', { value: 'CredentialsProviderError' });
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
    expect(failure).toBeInstanceOf(CallerError);
    const message = (failure as Error).message;
    expect(message).toContain(`AssumeRole(${ROLE_ARN}) failed: `);
    expect(message).toContain('CredentialsProviderError; ');
    expect(message).toContain('message withheld');
    expect(message).not.toContain('s3cr3t');
    // The socket pool is still released on the failure path.
    expect(destroyed.count).toBe(1);
  });

  /**
   * The DOUBLE-WITHHOLD guard.
   *
   * `assumeRoleCredentials` renders the failure itself because three of its
   * four call paths are unguarded to `formatError`. The fourth
   * (`local-invoke.ts`'s `resolveLambdaContainerEnv`) renders it too, and
   * feeding that renderer this helper's output withholds ALREADY-SANITIZED
   * text: the wrapper is a plain `Error`, cdk-local's own, so it carries no
   * `$fault` and takes the withheld branch. `ExpiredTokenException: The
   * security token ... is expired` became `Error; 138-character message
   * withheld` until `detail` existed.
   *
   * #570's harness is what caught it, and still covers the call-site half.
   * This case covers the contract half: `detail` is the bare rendered text, so
   * a caller with its own framing has something to print that is neither
   * double-framed nor double-withheld.
   */
  it('exposes the rendered detail separately so a relaying caller cannot re-withhold it', async () => {
    const expired = new Error('The security token included in the request is expired');
    Object.defineProperty(expired, 'name', { value: 'ExpiredTokenException' });
    Object.assign(expired, { $fault: 'client', $metadata: { httpStatusCode: 403 } });
    sendImpl.fn = async () => {
      throw expired;
    };
    const failure = await assumeRoleCredentials({
      roleArn: ROLE_ARN,
      region: undefined,
      profile: undefined,
      sessionNameSuffix: 'invoke',
    }).then(
      () => undefined,
      (err: unknown) => err
    );
    expect(failure).toBeInstanceOf(AssumeRoleFailure);
    const failed = failure as InstanceType<typeof AssumeRoleFailure>;
    // `detail` is the BARE rendered half -- no `AssumeRole(<arn>) failed:`
    // framing, so a caller adding its own does not double it.
    expect(failed.detail).toBe(
      'ExpiredTokenException: The security token included in the request is expired'
    );
    // `message` keeps the framing, for the three paths that print it directly.
    expect(failed.message).toBe(`AssumeRole(${ROLE_ARN}) failed: ${failed.detail}`);
  });

  /**
   * The SIBLING throw, issue #579 review round 5.
   *
   * Round 4 classed the transport failure and left this one a bare `Error`,
   * one throw over, carrying the identical defect: at `local-invoke.ts` it
   * missed the `instanceof` test, fell into `describeAwsFailureForWarn`, and
   * rendered as `Error; 47-character message withheld` — cdk-local's own
   * sentence withheld from the user by cdk-local's own policy. It shipped
   * unfenced because no case drove an empty-`Credentials` response through a
   * RELAYING caller; the file-header rule in
   * `tests/unit/local/aws-error-relay-sites.test.ts` predicts exactly this.
   */
  it('classes the no-usable-credentials throw so a relay cannot withhold it', async () => {
    sendImpl.fn = async () => ({});
    const failure = await assumeRoleCredentials({
      roleArn: ROLE_ARN,
      region: undefined,
      profile: undefined,
      sessionNameSuffix: 'invoke',
    }).then(
      () => undefined,
      (err: unknown) => err
    );
    expect(failure).toBeInstanceOf(AssumeRoleFailure);
    const failed = failure as InstanceType<typeof AssumeRoleFailure>;
    // BYTE-IDENTICAL to what it threw before #579: three direct-print paths
    // quote it, and so does `credential-error.ts`'s worked example.
    expect(failed.message).toBe(`AssumeRole(${ROLE_ARN}) returned no usable credentials.`);
    // `detail` drops the framing a relaying caller has already written.
    expect(failed.detail).toBe('the response carried no usable credentials');
  });

  it('does NOT use the sentinel when makeError is supplied', async () => {
    // Every `makeError` path is in the unguarded group and asked for its own
    // class; handing it the sentinel instead would break that.
    class CallerError extends Error {}
    sendImpl.fn = async () => {
      throw new Error('boom');
    };
    const failure = await assumeRoleCredentials({
      roleArn: ROLE_ARN,
      region: undefined,
      profile: undefined,
      sessionNameSuffix: 'start-service',
      makeError: (message) => new CallerError(message),
    }).then(
      () => undefined,
      (err: unknown) => err
    );
    expect(failure).toBeInstanceOf(CallerError);
    expect(failure).not.toBeInstanceOf(AssumeRoleFailure);
  });

  it('keeps a modeled STS service exception message, which is the diagnosis', async () => {
    const expired = new Error('The security token included in the request is expired');
    Object.defineProperty(expired, 'name', { value: 'ExpiredTokenException' });
    Object.assign(expired, { $fault: 'client', $metadata: { httpStatusCode: 403 } });
    sendImpl.fn = async () => {
      throw expired;
    };
    const failure = await assumeRoleCredentials({
      roleArn: ROLE_ARN,
      region: undefined,
      profile: undefined,
      sessionNameSuffix: 'start-api',
    }).then(
      () => undefined,
      (err: unknown) => err
    );
    expect((failure as Error).message).toBe(
      `AssumeRole(${ROLE_ARN}) failed: ExpiredTokenException: ` +
        'The security token included in the request is expired'
    );
  });

  it('flattens a forged newline in the role ARN', async () => {
    // Reachable because the bare `--assume-role` form resolves this ARN from a
    // live `GetFunctionConfiguration` / `GetAgentRuntime` response behind only
    // a `startsWith('arn:')` check.
    sendImpl.fn = async () => ({});
    const failure = await assumeRoleCredentials({
      roleArn: `${ROLE_ARN}\nWARN: signature verified`,
      region: undefined,
      profile: undefined,
      sessionNameSuffix: 'start-api',
    }).then(
      () => undefined,
      (err: unknown) => err
    );
    const message = (failure as Error).message;
    expect(message).toContain(`AssumeRole(${ROLE_ARN} WARN: signature verified)`);
    expect(message).not.toContain('\n');
  });
});

/**
 * Issue #579 review round 4 — `applyRoleArnIfSet`, the NINE-caller site.
 *
 * The most reachable relay the derived population turned up: it runs
 * `AssumeRole` on the default credential chain from `cdkl studio`, the ECS
 * emulator, `invoke-agentcore` and six other entry points, its `send` sat in a
 * `try { … } finally { destroy }` with no `catch`, and NONE of the nine callers
 * catches either — so the raw SDK error reached `formatError`'s
 * `${error.name}: ${error.message}` at DEFAULT level.
 */
describe('applyRoleArnIfSet — the uncaught AssumeRole relay (issue #579)', () => {
  const ENV_KEYS = [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
  ] as const;
  let savedEnv: Record<string, string | undefined>;
  let infoLines: string[];
  let debugLines: string[];

  beforeEach(() => {
    sent.length = 0;
    destroyed.count = 0;
    // `sendImpl.fn` is module-scoped and the cases below reassign it, so the
    // success default has to be restored here or a later case inherits an
    // earlier one's failure.
    sendImpl.fn = async () => ({
      Credentials: {
        AccessKeyId: 'AKIATEST',
        SecretAccessKey: 'secretTEST',
        SessionToken: 'tokTEST',
      },
    });
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    infoLines = [];
    debugLines = [];
    // TWO sinks, because the two lines under test take different paths.
    // `applyRoleArnIfSet` logs through `getLogger().child('role-arn')`, and
    // `ChildLogger` is a SEPARATE `ConsoleLogger` instance rather than a
    // delegate — spying the root does not capture it, so the child's output is
    // read off `console` instead. The `debug` line carrying the withheld text
    // comes from `describeAwsFailureForWarn`, which uses the ROOT logger, so
    // that one is spied directly.
    vi.spyOn(console, 'info').mockImplementation((m?: unknown) => void infoLines.push(String(m)));
    vi.spyOn(console, 'log').mockImplementation((m?: unknown) => void infoLines.push(String(m)));
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(getLogger(), 'debug').mockImplementation(
      (m: string) => void debugLines.push(String(m))
    );
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    vi.restoreAllMocks();
  });

  async function driveFailure(roleArn: string): Promise<string> {
    return applyRoleArnIfSet({ roleArn, region: undefined, profile: undefined }).then(
      () => '',
      (err: unknown) => (err instanceof Error ? err.message : String(err))
    );
  }

  it('withholds a credential-chain message and prints it at debug', async () => {
    const chain = new Error('Command failed: /opt/bin/get-creds --pass s3cr3t');
    Object.defineProperty(chain, 'name', { value: 'CredentialsProviderError' });
    sendImpl.fn = async () => {
      throw chain;
    };
    const message = await driveFailure(ROLE_ARN);
    expect(message).toContain(`AssumeRole(${ROLE_ARN}) failed: `);
    expect(message).toContain('CredentialsProviderError; ');
    expect(message).toContain('message withheld');
    expect(message).not.toContain('s3cr3t');
    expect(message).not.toContain('\n');
    // Withheld at default level is only acceptable while in full at `debug`.
    const withheld = debugLines.filter((l) => l.includes('s3cr3t'));
    expect(withheld).toHaveLength(1);
    expect(withheld[0]!).toContain("STS AssumeRole: the AWS SDK's own failure message was:");
    // The socket pool is released on the failure path.
    expect(destroyed.count).toBe(1);
  });

  it('keeps a modeled STS service exception message', async () => {
    const expired = new Error('The security token included in the request is expired');
    Object.defineProperty(expired, 'name', { value: 'ExpiredTokenException' });
    Object.assign(expired, { $fault: 'client', $metadata: { httpStatusCode: 403 } });
    sendImpl.fn = async () => {
      throw expired;
    };
    expect(await driveFailure(ROLE_ARN)).toBe(
      `AssumeRole(${ROLE_ARN}) failed: ExpiredTokenException: ` +
        'The security token included in the request is expired'
    );
  });

  it("keeps cdk-local's own no-credentials throw, which moved OUT of the try", async () => {
    sendImpl.fn = async () => ({});
    expect(await driveFailure(ROLE_ARN)).toBe(
      `AssumeRole returned no credentials for role ${ROLE_ARN}`
    );
  });

  it("keeps cdk-local's own missing-fields throw", async () => {
    sendImpl.fn = async () => ({ Credentials: { AccessKeyId: 'AKIA' } });
    expect(await driveFailure(ROLE_ARN)).toBe(
      `AssumeRole response missing credentials fields for role ${ROLE_ARN}`
    );
  });

  it('flattens the role ARN on the SUCCESS line, which is the more reachable one', async () => {
    // The bare `--assume-role` form resolves this ARN from a live
    // `GetFunctionConfiguration` / `GetAgentRuntime` response behind only a
    // `startsWith('arn:')` check, and this `info` line fires when the assume
    // SUCCEEDS — so it is strictly more reachable than any failure path.
    await applyRoleArnIfSet({
      roleArn: `${ROLE_ARN}\nWARN: signature verified`,
      region: undefined,
      profile: undefined,
    });
    const line = infoLines.find((l) => l.includes('Assumed role'));
    expect(line).toContain(`Assumed role ${ROLE_ARN} WARN: signature verified`);
    expect(line).not.toContain('\n');
    expect(debugLines.every((l) => !l.includes('\n'))).toBe(true);
    expect(process.env['AWS_ACCESS_KEY_ID']).toBe('AKIATEST');
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
