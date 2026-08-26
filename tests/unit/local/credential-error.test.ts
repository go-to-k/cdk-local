import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  clampErrorName,
  describeAwsFailureForWarn,
  describeCredentialLoadFailure,
  isAwsServiceException,
  sanitizeServiceExceptionMessage,
  stringifyThrown,
} from '../../../src/local/credential-error.js';
import { getLogger } from '../../../src/utils/logger.js';

/**
 * Issue #570 — the helper half. The nine CALL SITES are fenced separately in
 * `tests/unit/cli/sts-error-relay-sites.test.ts`, because a correct helper
 * says nothing about whether a given `logger.warn` routes through it.
 */

/**
 * The shape this exists for, reused from the #564 fixture:
 * `@aws-sdk/credential-provider-process` copies the rejection of
 * `promisify(child_process.exec)` — `Command failed: <command line>\n<stderr>`
 * — into the error it throws, and BOTH lines can carry a passphrase.
 */
const PASSPHRASE = 'hunter2-do-not-log';
const CHAIN_MESSAGE =
  `Command failed: /opt/bin/get-creds --vault-passphrase ${PASSPHRASE}\n` +
  `  vault: unlocked with passphrase ${PASSPHRASE}`;

/** Measured below, not assumed. */
const CHAIN_MESSAGE_LENGTH = 125;

class CredentialsProviderError extends Error {
  override name = 'CredentialsProviderError';
}

function namedError(name: string, message: string): Error {
  const e = new Error(message);
  Object.defineProperty(e, 'name', { value: name });
  return e;
}

/**
 * A modeled AWS service exception, built the way the SDK builds one: the
 * `name` comes off the wire (`x-amzn-errortype`) and `$fault` / `$metadata`
 * are what {@link isAwsServiceException} keys on.
 */
function serviceException(name: string, message: string): Error {
  const e = namedError(name, message);
  Object.assign(e, {
    $fault: 'client',
    $metadata: { httpStatusCode: 403, requestId: 'req-1' },
  });
  return e;
}

function spy(level: 'warn' | 'debug'): { calls: () => string; restore: () => void } {
  const s = vi.spyOn(getLogger(), level).mockImplementation(() => {});
  return {
    calls: () => s.mock.calls.map((c) => String(c[0])).join('\n'),
    restore: () => s.mockRestore(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('stringifyThrown — total, so a throw cannot escape a catch', () => {
  it('returns an Error message', () => {
    expect(stringifyThrown(new Error('boom'))).toBe('boom');
  });

  it('measures the chain fixture, so every length assertion below is grounded', () => {
    expect(stringifyThrown(new CredentialsProviderError(CHAIN_MESSAGE)).length).toBe(
      CHAIN_MESSAGE_LENGTH
    );
  });

  it('pins the CORRECTION to #564: a Symbol throw does not break String()', () => {
    // #564's JSDoc listed a `Symbol` throw as a `String()` failure. Measured
    // here instead of assumed: `String(sym)` is fine, and it is template
    // INTERPOLATION that throws. Both the old code and the helper call
    // `String()` explicitly, so this case was never reachable — the case is
    // kept so the corrected claim stays measured rather than remembered.
    expect(String(Symbol('x'))).toBe('Symbol(x)');
    expect(() => `${Symbol('x') as unknown as string}`).toThrow(TypeError);
    expect(stringifyThrown(Symbol('x'))).toBe('Symbol(x)');
  });

  it('does not throw on a null-prototype object, which String() DOES reject', () => {
    const hostile = Object.create(null) as object;
    expect(() => String(hostile)).toThrow(TypeError);
    expect(stringifyThrown(hostile)).toBe('[unstringifiable throw]');
  });

  it('does not throw when the thrown value has a toString that throws', () => {
    const hostile = {
      toString(): string {
        throw new Error('nope');
      },
    };
    expect(() => String(hostile)).toThrow('nope');
    expect(stringifyThrown(hostile)).toBe('[unstringifiable throw]');
  });

  it('does not throw when an Error message getter throws', () => {
    const hostile = new Error('placeholder');
    Object.defineProperty(hostile, 'message', {
      get(): string {
        throw new Error('nope');
      },
    });
    expect(stringifyThrown(hostile)).toBe('[unstringifiable throw]');
  });

  it('stringifies a non-Error throw', () => {
    expect(stringifyThrown('plain string throw')).toBe('plain string throw');
  });
});

describe('clampErrorName — the wire-derived name cannot forge a log line', () => {
  it('keeps a real class name', () => {
    expect(clampErrorName(new CredentialsProviderError('x'))).toBe('CredentialsProviderError');
  });

  it("reports 'unknown' for a non-Error throw rather than guessing a class", () => {
    expect(clampErrorName('plain string throw')).toBe('unknown');
  });

  it('keeps a 64-character name and rejects a 65-character one', () => {
    expect(clampErrorName(namedError('A'.repeat(64), 'x'))).toBe('A'.repeat(64));
    expect(clampErrorName(namedError('A'.repeat(65), 'x'))).toBe('unknown');
  });

  it('rejects a newline-carrying forged name outright, not by truncating it', () => {
    const forged = 'Foo\nWARN: signature verified';
    // The WRONG fix the JSDoc names: slicing keeps the newline, so the second
    // line still lands in the log. Assert that slicing would NOT have worked,
    // so this case cannot go green under it.
    expect(forged.slice(0, 64)).toContain('\n');
    expect(clampErrorName(namedError(forged, 'x'))).toBe('unknown');
  });

  it('rejects a bidi-override name', () => {
    expect(clampErrorName(namedError('Foo\u202Ebar', 'x'))).toBe('unknown');
  });
});

describe('isAwsServiceException — the positively-defined safe state', () => {
  it('accepts a modeled service exception', () => {
    expect(isAwsServiceException(serviceException('AccessDenied', 'nope'))).toBe(true);
  });

  it('rejects a credential-chain error', () => {
    expect(isAwsServiceException(new CredentialsProviderError(CHAIN_MESSAGE))).toBe(false);
  });

  it('rejects a plain Error, a string throw, null and undefined', () => {
    expect(isAwsServiceException(new Error('x'))).toBe(false);
    expect(isAwsServiceException('x')).toBe(false);
    expect(isAwsServiceException(null)).toBe(false);
    expect(isAwsServiceException(undefined)).toBe(false);
  });

  it('rejects an object carrying only ONE of the two markers', () => {
    const faultOnly = Object.assign(new Error('x'), { $fault: 'client' });
    const metadataOnly = Object.assign(new Error('x'), { $metadata: { httpStatusCode: 403 } });
    expect(isAwsServiceException(faultOnly)).toBe(false);
    expect(isAwsServiceException(metadataOnly)).toBe(false);
  });

  it('rejects a $fault that is not one of the two modeled values', () => {
    const bogus = Object.assign(new Error('x'), {
      $fault: 'definitely-a-service-error',
      $metadata: { httpStatusCode: 403 },
    });
    expect(isAwsServiceException(bogus)).toBe(false);
  });
});

describe('sanitizeServiceExceptionMessage — the line stays one line', () => {
  it('leaves an ordinary AWS message untouched', () => {
    const msg = 'The security token included in the request is expired';
    expect(sanitizeServiceExceptionMessage(msg)).toBe(msg);
  });

  it('flattens control characters, so an injected newline cannot forge a line', () => {
    const out = sanitizeServiceExceptionMessage('Denied\nWARN: signature verified\r\nx\tY\u0000Z');
    expect(out).not.toContain('\n');
    expect(out).not.toContain('\r');
    expect(out).not.toContain('\t');
    expect(out).not.toContain('\u0000');
    expect(out).toBe('Denied WARN: signature verified  x Y Z');
  });

  it('flattens a bidi override, which forges how the rest of the line reads', () => {
    expect(sanitizeServiceExceptionMessage('a\u202Eb')).toBe('a b');
  });

  it('keeps a 512-character message whole', () => {
    const msg = 'A'.repeat(512);
    expect(sanitizeServiceExceptionMessage(msg)).toBe(msg);
  });

  it('truncates at 513 and names the true length', () => {
    const out = sanitizeServiceExceptionMessage('A'.repeat(513));
    expect(out).toBe(`${'A'.repeat(512)}[... truncated; 513-character message]`);
  });

  it('names the SANITIZED length, which is the string the prefix is a prefix of', () => {
    // 600 newlines become 600 spaces, so the counts happen to coincide; the
    // assertion that matters is that the prefix and the count describe the
    // SAME string — the prefix must be all spaces, not the raw newlines.
    const out = sanitizeServiceExceptionMessage('\n'.repeat(600));
    expect(out).toBe(`${' '.repeat(512)}[... truncated; 600-character message]`);
    expect(out).not.toContain('\n');
  });
});

describe('describeCredentialLoadFailure — #564 shape, unchanged by the move', () => {
  it('reports the clamped class name and the length, never the message', () => {
    const out = describeCredentialLoadFailure(new CredentialsProviderError(CHAIN_MESSAGE));
    expect(out).toBe(
      `CredentialsProviderError; ${CHAIN_MESSAGE_LENGTH}-character message withheld, ` +
        `logged at debug level under --verbose`
    );
    expect(out).not.toContain(PASSPHRASE);
    expect(out).not.toContain('Command failed');
  });
});

describe('describeAwsFailureForWarn — the split by population', () => {
  it('withholds a credential-chain message and prints it at debug', () => {
    const debug = spy('debug');
    const out = describeAwsFailureForWarn(
      new CredentialsProviderError(CHAIN_MESSAGE),
      'STS GetCallerIdentity'
    );
    expect(out).toBe(
      `CredentialsProviderError; ${CHAIN_MESSAGE_LENGTH}-character message withheld, ` +
        `logged at debug level under --verbose`
    );
    expect(out).not.toContain(PASSPHRASE);
    expect(debug.calls()).toContain('STS GetCallerIdentity');
    expect(debug.calls()).toContain(PASSPHRASE);
    debug.restore();
  });

  it('keeps a modeled service exception message, which is the diagnosis', () => {
    const out = describeAwsFailureForWarn(
      serviceException('ExpiredToken', 'The security token included in the request is expired'),
      'STS GetCallerIdentity'
    );
    expect(out).toBe('ExpiredToken: The security token included in the request is expired');
  });

  it('does NOT re-log a kept service message at debug', () => {
    const debug = spy('debug');
    describeAwsFailureForWarn(serviceException('AccessDenied', 'nope'), 'STS AssumeRole');
    expect(debug.calls()).toBe('');
    debug.restore();
  });

  it('clamps a forged wire-derived name on the kept branch too', () => {
    const out = describeAwsFailureForWarn(
      serviceException('Foo\nWARN: signature verified', 'body'),
      'STS AssumeRole'
    );
    expect(out).toBe('unknown: body');
    expect(out).not.toContain('\n');
  });

  it('flattens a forged newline inside a kept service MESSAGE', () => {
    const out = describeAwsFailureForWarn(
      serviceException('AccessDenied', 'denied\nWARN: signature verified'),
      'STS AssumeRole'
    );
    expect(out).toBe('AccessDenied: denied WARN: signature verified');
    expect(out).not.toContain('\n');
  });

  it('withholds when a hostile endpoint forges the chain class name, i.e. fails safe', () => {
    // `x-amzn-errortype: CredentialsProviderError` would make `err.name` say
    // "chain error" while `$fault` still says "service exception". The
    // discriminator is `$fault` / `$metadata`, so this stays on the KEPT
    // branch; the point of the assertion is that the forged name cannot make
    // the helper disclose MORE than the message it already judged printable.
    const out = describeAwsFailureForWarn(
      serviceException('CredentialsProviderError', 'body'),
      'STS AssumeRole'
    );
    expect(out).toBe('CredentialsProviderError: body');
  });

  it('withholds an unrecognised throw shape (a bare string) rather than relaying it', () => {
    const debug = spy('debug');
    const out = describeAwsFailureForWarn('raw throw text', 'STS AssumeRole');
    expect(out).toBe(
      'unknown; 14-character message withheld, logged at debug level under --verbose'
    );
    expect(out).not.toContain('raw throw text');
    expect(debug.calls()).toContain('raw throw text');
    debug.restore();
  });

  it('withholds a socket-level Error, which carries no service diagnosis', () => {
    const out = describeAwsFailureForWarn(
      namedError('TimeoutError', 'socket hang up'),
      'STS GetCallerIdentity'
    );
    expect(out).toBe(
      'TimeoutError; 14-character message withheld, logged at debug level under --verbose'
    );
  });

  it('does not throw when the thrown value is unstringifiable', () => {
    const debug = spy('debug');
    // `'[unstringifiable throw]'` is 23 characters — the length field
    // describes the placeholder, which is the only string that exists.
    expect(describeAwsFailureForWarn(Object.create(null), 'STS AssumeRole')).toBe(
      'unknown; 23-character message withheld, logged at debug level under --verbose'
    );
    debug.restore();
  });
});
