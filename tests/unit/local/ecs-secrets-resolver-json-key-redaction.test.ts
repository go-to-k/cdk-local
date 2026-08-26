/**
 * `resolveEcsSecrets` must not echo the parser's own message when a
 * `:json-key::` `ValueFrom` points at a secret whose value is not JSON.
 * V8 embeds a prefix of the PARSED INPUT in `SyntaxError.message`, and the
 * parsed input here IS the secret plaintext this resolver just fetched from
 * Secrets Manager -- so the echo puts the secret on stderr and into any
 * surrounding log capture. `cdkl run-task` reaches it on an ordinary user
 * mistake (issue #554; the same defect the cdkd host fixed as
 * go-to-k/cdkd#2189).
 *
 * Each case pairs the negative with POSITIVES. "The secret is absent" on its
 * own is a confluence point -- an unrelated rejection (a bad ARN, a mock that
 * never resolved) satisfies it while fencing nothing -- so the discriminators
 * that must SURVIVE are asserted alongside it.
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
  GetSecretValueCommand: class {},
}));

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class {
    send = ssmSend;
    destroy(): void {}
  },
  GetParameterCommand: class {},
}));

const { resolveEcsSecrets, EcsSecretsResolutionError } = await import(
  '../../../src/local/ecs-secrets-resolver.js'
);

/** A Secrets Manager ARN carrying the `:<json-key>::` extraction suffix. */
const ARN_WITH_JSON_KEY =
  'arn:aws:secretsmanager:us-east-1:123456789012:secret:app-db:password::';

/**
 * Resolve one json-key entry against a secret whose stored value is `stored`,
 * and return the failure message. Fails the test if the resolve SUCCEEDS --
 * otherwise a mock that stopped rejecting would make every negative below
 * pass while fencing nothing.
 */
async function jsonKeyFailure(stored: string): Promise<string> {
  smSend.mockResolvedValue({ SecretString: stored });
  try {
    await resolveEcsSecrets([
      { containerName: 'ApiContainer', name: 'DB_PASSWORD', valueFrom: ARN_WITH_JSON_KEY },
    ]);
  } catch (err) {
    expect(err).toBeInstanceOf(EcsSecretsResolutionError);
    return (err as Error).message;
  }
  return expect.fail('resolveEcsSecrets should have thrown on a non-JSON secret value');
}

/** The discriminators that must survive the redaction, in every case. */
function expectStillActionable(message: string): void {
  expect(message).toContain("Container 'ApiContainer'");
  expect(message).toContain("secret 'DB_PASSWORD'");
  expect(message).toContain("json-key 'password'");
  expect(message).toContain('not valid JSON (SyntaxError)');
  expect(message).toContain('withheld');
}

describe('resolveEcsSecrets json-key parse failure (issue #554)', () => {
  beforeEach(() => {
    smSend.mockReset();
    ssmSend.mockReset();
  });

  it('withholds the ~10-character prefix V8 quotes from a long secret', async () => {
    // `JSON.parse('supersecretpassword12345')` answers
    // `Unexpected token 's', "supersecre"... is not valid JSON` on Node 24.15.
    // The needle is the PREFIX, not the whole secret: `not.toContain(secret)`
    // would pass WITHOUT the fix, since V8 never emits past its window -- an
    // assertion that cannot fail reads as protection that is not there.
    const secret = 'supersecretpassword12345';
    const message = await jsonKeyFailure(secret);

    expect(message).not.toContain('supersecre');
    // Fence the parser's PHRASING too, not just the quoted segment: a message
    // that kept `Unexpected token 's', is not valid JSON` with only the quote
    // stripped still leaks the secret's first character.
    expect(message).not.toContain('Unexpected token');

    expectStillActionable(message);
  });

  it('withholds a SHORT secret, which V8 quotes in FULL rather than truncating', async () => {
    // The worst case and a distinct leak shape: V8 appends `...` only PAST its
    // prefix window, so `JSON.parse('pw42')` quotes the whole string. A guard
    // written only against the truncated shape misses this one entirely.
    // Chosen so the needle appears nowhere else in the message -- the
    // container, env var and json-key literals do not contain it.
    const secret = 'pw42';
    const message = await jsonKeyFailure(secret);

    expect(message).not.toContain(secret);
    expect(message).not.toContain('Unexpected token');

    expectStillActionable(message);
  });

  it('still extracts the key when the secret IS valid JSON', async () => {
    // The premise of both cases above: this resolver reaches the json-key
    // branch at all. Without this, a change that stopped extracting -- or
    // stopped honouring the `:json-key::` suffix -- would leave the two
    // negatives passing over a path that no longer parses anything.
    smSend.mockResolvedValue({ SecretString: JSON.stringify({ password: 'pw42' }) });

    const out = await resolveEcsSecrets([
      { containerName: 'ApiContainer', name: 'DB_PASSWORD', valueFrom: ARN_WITH_JSON_KEY },
    ]);

    expect(out).toEqual([
      {
        containerName: 'ApiContainer',
        name: 'DB_PASSWORD',
        valueFrom: ARN_WITH_JSON_KEY,
        value: 'pw42',
      },
    ]);
  });
});
