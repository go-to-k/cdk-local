/**
 * `resolveEcsSecrets` must not echo the parser's own message when a
 * `:json-key::` `ValueFrom` points at a secret whose value is not JSON.
 * V8 embeds a prefix of the PARSED INPUT in `SyntaxError.message`, and the
 * parsed input here IS the secret plaintext this resolver just fetched from
 * Secrets Manager -- so the echo puts the secret on stderr and into any
 * surrounding log capture. `cdkl run-task` reaches it on an ordinary user
 * mistake (issue #554; reported against the cdkd host as go-to-k/cdkd#2189 and
 * fixed there by go-to-k/cdkd#2214).
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
  // The command RETAINS its input. A `class {}` that discards it cannot tell a
  // correct call from a wrong-argument one, so `send` resolving for any
  // argument would hide, for instance, the resolver passing the whole
  // `valueFrom` (`...:secret:app-db:password::`) where the base ARN belongs --
  // green here, `ResourceNotFound` against real AWS.
  GetSecretValueCommand: class {
    constructor(public input: unknown) {}
  },
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
    // The worst case and a distinct leak shape: an input of 20 characters or
    // fewer is quoted in FULL (`...` first appears at 21), so
    // `JSON.parse('pw42')` quotes the whole string. A guard written only
    // against the truncated shape misses this one entirely.
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

    // ...and it asked AWS for the BASE ARN, with the `:<json-key>::` suffix
    // stripped. Secrets Manager rejects the suffixed form, so a resolver that
    // forwarded `valueFrom` verbatim would pass every assertion above while
    // failing against real AWS -- which is exactly the hole an input-discarding
    // command mock leaves open.
    expect(smSend).toHaveBeenCalledTimes(1);
    expect((smSend.mock.calls[0]![0] as { input: unknown }).input).toEqual({
      SecretId: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:app-db',
    });
  });
});

describe('the three VALUE-consuming sibling branches must stay value-free (issue #554)', () => {
  // The three branches of `resolveSecretsManager` that are HANDED the resolved
  // secret and could therefore disclose it. None echoes today, and the point
  // is to keep it that way: they are where a later "let us be more helpful"
  // edit reaches, and nothing asserted their silence. Each fixture makes its
  // OWN branch the one that fires -- a value that parses cleanly, so the
  // `JSON.parse` catch fixed above is NOT what threw.
  //
  // The FOURTH throw in this function -- the `client.send` catch at
  // `ecs-secrets-resolver.ts:188` -- is deliberately NOT here, and the reason
  // is recorded at that site: it fires BEFORE any value exists, and what it
  // relays is an AWS transport error about the ARN. Naming the exclusion
  // matters because a block titled "the sibling branches" otherwise reads as
  // covering all four.
  //
  // A leak is asserted absent in every ENCODING a plausible edit would emit
  // it in, not just as the literal string. Interpolating a `Uint8Array`
  // yields a decimal byte list and `JSON.stringify` yields an index-keyed
  // object -- both trivially reversible, and both FAR likelier than the
  // hand-decode an earlier cut of this test probed. Fencing only the decoded
  // form is the "probed the mutation nobody would write" trap.
  beforeEach(() => {
    smSend.mockReset();
    ssmSend.mockReset();
  });

  const PLAINTEXT = 'pw42';
  /** A key name the fixture's secret carries and the requested json-key does not. */
  const OTHER_KEY = 'dbUsernameField';

  it.each([
    [
      'the secret root is not a JSON object',
      { SecretString: JSON.stringify([PLAINTEXT]) },
      'the secret root is not a JSON object',
    ],
    [
      'no such key exists in the secret JSON',
      { SecretString: JSON.stringify({ [OTHER_KEY]: PLAINTEXT }) },
      'no such key exists in the secret JSON',
    ],
  ])('%s', async (_label, response, surviving) => {
    smSend.mockResolvedValue(response);

    let caught: unknown;
    try {
      await resolveEcsSecrets([
        { containerName: 'ApiContainer', name: 'DB_PASSWORD', valueFrom: ARN_WITH_JSON_KEY },
      ]);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(EcsSecretsResolutionError);
    const message = (caught as Error).message;

    // Positive first: this is the branch under test, not some earlier throw.
    expect(message).toContain(surviving);
    expect(message).toContain("Container 'ApiContainer'");
    expect(message).toContain("secret 'DB_PASSWORD'");
    expect(message).toContain("json-key 'password'");

    expect(message).not.toContain(PLAINTEXT);
    // The secret's STRUCTURE is disclosure too, and listing the keys it does
    // have (`Available keys: ...`) is the canonical helpful-edit for a
    // missing-key error. Asserted on both rows because the array fixture
    // simply has no keys to list, so the guard costs nothing there.
    expect(message).not.toContain(OTHER_KEY);
  });

  it('binary secret: reports no string value without relaying the bytes in ANY encoding', async () => {
    // The `SecretString === undefined` arm. AWS returns the value under
    // `SecretBinary` here, and relaying it -- decoded, interpolated, or
    // JSON-stringified -- discloses the same plaintext.
    const bytes = new TextEncoder().encode(PLAINTEXT);
    smSend.mockResolvedValue({ SecretBinary: bytes });

    let caught: unknown;
    try {
      await resolveEcsSecrets([
        { containerName: 'ApiContainer', name: 'DB_PASSWORD', valueFrom: ARN_WITH_JSON_KEY },
      ]);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(EcsSecretsResolutionError);
    const message = (caught as Error).message;

    expect(message).toContain('returned no SecretString');
    expect(message).toContain('Binary secrets are not supported');

    // Decoded -- the hand-written `TextDecoder` form.
    expect(message).not.toContain(PLAINTEXT);
    // Interpolated / `String(...)`-ed -- a typed array stringifies to its
    // decimal bytes (`112,119,52,50`). This is what `+ String(resp.SecretBinary)`
    // emits, and it is the likelier edit of the two.
    expect(message).not.toContain(Array.from(bytes).join(','));
    // `JSON.stringify(resp)` renders the array as an INDEX-KEYED object, so
    // the byte list above does not appear in it. Built from the bytes rather
    // than by re-stringifying a guessed response shape, so it still matches
    // when the edit stringifies a response carrying other fields too.
    const indexKeyed = JSON.stringify(
      Object.fromEntries(Array.from(bytes).map((b, i) => [String(i), b]))
    );
    expect(message).not.toContain(indexKeyed);
    // Base64 -- the shape a `Buffer.from(...).toString('base64')` edit emits.
    expect(message).not.toContain(Buffer.from(bytes).toString('base64'));
  });
});
