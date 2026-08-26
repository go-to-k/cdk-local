/**
 * `$util.parseJson` must not echo a prefix of the argument it failed to
 * parse. Under `start-api` that argument is routinely `$input.body` -- the
 * incoming HTTP request body, which on a login endpoint carries the caller's
 * password -- and V8 embeds a prefix of the PARSED INPUT in
 * `SyntaxError.message`. The echo also reaches the wire, because
 * `vtlFailure` in `rest-v1-integrations.ts` copies the reason into the 502
 * response body. Reported against the cdkd host as go-to-k/cdkd#2203.
 *
 * Each case pairs the negative with POSITIVES: "the needle is absent" on its
 * own is a confluence point that any unrelated rejection also satisfies, so
 * the discriminators that must SURVIVE are asserted too.
 */

import { describe, expect, it } from 'vite-plus/test';
import {
  buildDefaultUtil,
  buildVtlInput,
  buildVtlRequestContext,
  evaluateVtl,
  VtlEvaluationError,
  type VtlContext,
} from '../../../src/local/vtl-engine.js';

function contextWithBody(body: string): VtlContext {
  return {
    input: buildVtlInput(body, {}, {}, {}),
    context: buildVtlRequestContext({
      requestId: 'req-1',
      httpMethod: 'POST',
      resourcePath: '/login',
      stage: 'prod',
      sourceIp: '1.2.3.4',
      userAgent: 'test-agent',
    }),
    util: buildDefaultUtil(),
  };
}

/** Render `$util.parseJson($input.body)` and return the failure message. */
function parseJsonFailure(body: string): string {
  try {
    evaluateVtl('$util.parseJson($input.body)', contextWithBody(body));
  } catch (err) {
    expect(err).toBeInstanceOf(VtlEvaluationError);
    return (err as Error).message;
  }
  return expect.fail('$util.parseJson should have thrown on a non-JSON body');
}

describe('$util.parseJson failure message (go-to-k/cdkd#2203)', () => {
  it('withholds the ~10-character prefix V8 quotes from a long body', () => {
    // `JSON.parse('hunter2-my-db-password')` answers
    // `Unexpected token 'h', "hunter2-my"... is not valid JSON` on Node 24.15.
    // The needle is the PREFIX, not the whole body: `not.toContain(body)`
    // would pass WITHOUT the fix, since V8 never emits past its window.
    const body = 'hunter2-my-db-password';
    const message = parseJsonFailure(body);

    expect(message).not.toContain('hunter2-my');

    expect(message).toContain('$util.parseJson');
    expect(message).toContain('SyntaxError');
    // Anchored with the trailing `)`: a bare `argument length 22` is a
    // substring of `argument length 220`, so an inflated count would pass.
    expect(message).toContain(`argument length ${body.length})`);
  });

  it('withholds a SHORT body, which V8 quotes in FULL rather than truncating', () => {
    // A distinct leak shape: V8 appends `...` only past its prefix window, so
    // `JSON.parse('pw42')` quotes the whole string. A guard written only
    // against the truncated shape misses this one entirely, and this is the
    // shape the cdkd host reproduced over HTTP with a real header value.
    const body = 'pw42';
    const message = parseJsonFailure(body);

    expect(message).not.toContain(body);

    expect(message).toContain('$util.parseJson');
    expect(message).toContain('SyntaxError');
    expect(message).toContain('argument length 4)');
  });

  it('reports the COERCED length, so a circular argument is not called an empty body', () => {
    // `coerce` answers `''` for a value `JSON.stringify` refuses, so the
    // reported length is 0 for a non-empty argument. The message therefore
    // says "argument length 0" and deliberately does NOT claim the caller
    // sent an empty body.
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const util = buildDefaultUtil();

    let message = '';
    try {
      util.parseJson(circular);
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain('argument length 0)');
    expect(message).not.toContain('empty body');
  });
});
