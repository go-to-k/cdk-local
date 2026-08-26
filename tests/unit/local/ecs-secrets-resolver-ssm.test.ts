/**
 * Issue #557 — `resolveSsm`, the SSM Parameter Store half of the ECS
 * `Secrets[].ValueFrom` resolver, had no unit coverage repo-wide. Both test
 * files that mock this resolver's SDK boundary create an `ssmSend` and then
 * never give it a resolved value, so every case there drives the Secrets
 * Manager branch.
 *
 * Nothing here is a leak: the SSM branch never parses the resolved value, it
 * returns `Parameter.Value` verbatim, so it carries none of #554's echo.
 * What is unfenced is ordinary behavior whose regression is SILENT —
 * `WithDecryption: true` dropped hands the container a SecureString's
 * ciphertext instead of failing, and only a real deploy would show it.
 *
 * The command RETAINS its input here. A `class {}` that discards it (the
 * shape the sibling files use, which is why they could not have caught this)
 * cannot tell a correct call from a wrong-argument one: `send` resolving for
 * any argument hides a dropped `WithDecryption`, a `Name` still carrying the
 * whole ARN, and a lost leading slash alike.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { smSend, ssmSend } = vi.hoisted(() => ({
  smSend: vi.fn(),
  ssmSend: vi.fn(),
}));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    send = smSend;
    destroy(): void {}
  },
  GetSecretValueCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class {
    send = ssmSend;
    destroy(): void {}
  },
  GetParameterCommand: class {
    constructor(public input: unknown) {}
  },
}));

const { resolveEcsSecrets, EcsSecretsResolutionError } = await import(
  '../../../src/local/ecs-secrets-resolver.js'
);

/** An SSM Parameter ARN whose name is a NESTED path, so a lost slash shows. */
const SSM_ARN = 'arn:aws:ssm:us-east-1:123456789012:parameter/app/db/password';
/** The name `classifySecretArn` extracts from it — leading slash included. */
const SSM_NAME = '/app/db/password';

const SM_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:app-token';

function entry(
  valueFrom: string,
  name = 'DB_PASSWORD'
): { containerName: string; name: string; valueFrom: string } {
  return { containerName: 'ApiContainer', name, valueFrom };
}

/** The input of the single `GetParameterCommand` the resolver sent. */
function sentParameterInput(): unknown {
  expect(ssmSend).toHaveBeenCalledTimes(1);
  return (ssmSend.mock.calls[0]![0] as { input: unknown }).input;
}

/**
 * Resolve one SSM entry and return the failure message. Fails the test if
 * the resolve SUCCEEDS — otherwise a mock that stopped rejecting would make
 * every negative below pass while fencing nothing.
 */
async function ssmFailure(): Promise<string> {
  try {
    await resolveEcsSecrets([entry(SSM_ARN)]);
  } catch (err) {
    expect(err).toBeInstanceOf(EcsSecretsResolutionError);
    return (err as Error).message;
  }
  return expect.fail('resolveEcsSecrets should have thrown for this SSM response');
}

describe('resolveSsm — the GetParameter call (issue #557)', () => {
  beforeEach(() => {
    smSend.mockReset();
    ssmSend.mockReset();
  });

  it('requests decryption — a dropped WithDecryption yields ciphertext, silently', async () => {
    ssmSend.mockResolvedValue({ Parameter: { Value: 'plaintext' } });
    await resolveEcsSecrets([entry(SSM_ARN)]);
    // Asserted on its own, not only inside the whole-input compare below, so
    // the failure names the field a regression would have dropped. A
    // SecureString resolved WITHOUT this comes back as a base64 KMS blob
    // that the container accepts as its password.
    expect((sentParameterInput() as { WithDecryption?: unknown }).WithDecryption).toBe(true);
  });

  it('sends exactly the parameter NAME classifySecretArn extracted, not the ARN', async () => {
    ssmSend.mockResolvedValue({ Parameter: { Value: 'plaintext' } });
    await resolveEcsSecrets([entry(SSM_ARN)]);
    // Whole-input compare: an EXTRA field is as wrong as a missing one, and
    // `Name` must keep the leading slash `parameter/app/db/password` implies.
    expect(sentParameterInput()).toEqual({ Name: SSM_NAME, WithDecryption: true });
  });

  it('returns Parameter.Value verbatim — no parsing, no json-key extraction', async () => {
    // A JSON-shaped value is the sharp case: the Secrets Manager branch
    // would parse this, the SSM branch must not. `:<json-key>::` is a
    // Secrets Manager convention and has no SSM counterpart.
    const stored = '{"password":"hunter2"}';
    ssmSend.mockResolvedValue({ Parameter: { Value: stored } });
    const out = await resolveEcsSecrets([entry(SSM_ARN)]);
    expect(out).toEqual([
      {
        containerName: 'ApiContainer',
        name: 'DB_PASSWORD',
        valueFrom: SSM_ARN,
        value: stored,
      },
    ]);
  });

  it('keeps an empty-string parameter value rather than treating it as missing', async () => {
    // `Parameter.Value === ''` is a real, resolvable value; only `undefined`
    // is the missing case. A truthiness check here would turn a legitimate
    // empty parameter into a hard failure.
    ssmSend.mockResolvedValue({ Parameter: { Value: '' } });
    const out = await resolveEcsSecrets([entry(SSM_ARN)]);
    expect(out[0]!.value).toBe('');
  });
});

describe('resolveSsm — the failure shapes (issue #557)', () => {
  beforeEach(() => {
    smSend.mockReset();
    ssmSend.mockReset();
  });

  it('throws when the response carries a Parameter with no Value', async () => {
    ssmSend.mockResolvedValue({ Parameter: { Name: SSM_NAME } });
    const message = await ssmFailure();
    expect(message).toContain(`SSM parameter '${SSM_NAME}' returned no Value`);
    expect(message).toContain("container 'ApiContainer'");
    expect(message).toContain("env 'DB_PASSWORD'");
    // The `err instanceof EcsSecretsResolutionError` re-throw guard: this
    // throw is raised INSIDE the try, so without the guard the catch would
    // re-wrap it as a transport failure and report a resolvable parameter as
    // an AWS / credentials problem.
    expect(message).not.toContain('Failed to resolve SSM parameter');
  });

  it('throws the same way when the response carries no Parameter at all', async () => {
    ssmSend.mockResolvedValue({});
    const message = await ssmFailure();
    expect(message).toContain(`SSM parameter '${SSM_NAME}' returned no Value`);
    expect(message).not.toContain('Failed to resolve SSM parameter');
  });

  it('wraps an SDK rejection with the container, env, parameter name and cause', async () => {
    // The shape `ssm:GetParameter` answers with for a name that does not
    // exist, or for one the profile's credentials may not read.
    const sdkError = Object.assign(new Error('Parameter /app/db/password not found.'), {
      name: 'ParameterNotFound',
    });
    ssmSend.mockRejectedValue(sdkError);
    const message = await ssmFailure();
    expect(message).toContain(
      "Failed to resolve SSM parameter for container 'ApiContainer' / env 'DB_PASSWORD'"
    );
    expect(message).toContain(`(${SSM_NAME})`);
    expect(message).toContain('Parameter /app/db/password not found.');
  });

  it('wraps an InvalidParameters-style rejection the same way', async () => {
    const sdkError = Object.assign(new Error('InvalidParameters: /app/db/password'), {
      name: 'InvalidParameters',
    });
    ssmSend.mockRejectedValue(sdkError);
    const message = await ssmFailure();
    expect(message).toContain('Failed to resolve SSM parameter');
    expect(message).toContain('InvalidParameters: /app/db/password');
  });

  it('stringifies a non-Error rejection instead of reporting undefined', async () => {
    ssmSend.mockRejectedValue('socket hang up');
    const message = await ssmFailure();
    expect(message).toContain('Failed to resolve SSM parameter');
    expect(message).toContain('socket hang up');
  });
});

describe('resolveEcsSecrets — SSM and Secrets Manager entries in one batch (issue #557)', () => {
  beforeEach(() => {
    smSend.mockReset();
    ssmSend.mockReset();
  });

  it('routes each ValueFrom shape to its own client and keeps entry order', async () => {
    smSend.mockResolvedValue({ SecretString: 'sm-value' });
    ssmSend.mockResolvedValue({ Parameter: { Value: 'ssm-value' } });

    const out = await resolveEcsSecrets([
      entry(SM_ARN, 'API_TOKEN'),
      entry(SSM_ARN, 'DB_PASSWORD'),
    ]);

    expect(out.map((r) => [r.name, r.value])).toEqual([
      ['API_TOKEN', 'sm-value'],
      ['DB_PASSWORD', 'ssm-value'],
    ]);
    // One call each: a shape routed to the wrong client would show up as two
    // on one and zero on the other.
    expect(smSend).toHaveBeenCalledTimes(1);
    expect(ssmSend).toHaveBeenCalledTimes(1);
    expect((smSend.mock.calls[0]![0] as { input: unknown }).input).toEqual({ SecretId: SM_ARN });
    expect(sentParameterInput()).toEqual({ Name: SSM_NAME, WithDecryption: true });
  });

  it('fails the whole batch when only the SSM half fails', async () => {
    // Resolution is all-or-nothing by design: a partially-resolved batch
    // would boot a container with one secret as a literal empty string.
    smSend.mockResolvedValue({ SecretString: 'sm-value' });
    ssmSend.mockRejectedValue(new Error('AccessDeniedException'));
    await expect(
      resolveEcsSecrets([entry(SM_ARN, 'API_TOKEN'), entry(SSM_ARN, 'DB_PASSWORD')])
    ).rejects.toBeInstanceOf(EcsSecretsResolutionError);
  });
});
