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
import { dispatchMockIntegration } from '../../../src/local/rest-v1-integrations.js';
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
    // Also fence the parser's PHRASING, not just the quoted segment: a
    // message that kept `Unexpected token 'h', is not valid JSON` with only
    // the quote stripped still leaks the first character and the offset.
    expect(message).not.toContain('Unexpected token');

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
    expect(message).not.toContain('Unexpected token');

    expect(message).toContain('$util.parseJson');
    expect(message).toContain('SyntaxError');
    expect(message).toContain('argument length 4)');
  });

  it('reports the COERCED length for every value that coerces to the empty string', () => {
    // `coerce` answers `''` two different ways, and only one of them was
    // covered before: `JSON.stringify` THROWS on a circular object, and
    // RETURNS `undefined` for a function / symbol / `toJSON`-yielding-
    // undefined. The second kind used to make `s.length` throw a TypeError,
    // so the caller got something OTHER than a `VtlEvaluationError` -- the
    // class hosts are documented to be able to `instanceof`.
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const toJsonUndefined = { toJSON: () => undefined };

    for (const [label, value] of [
      ['circular (stringify throws)', circular],
      ['function (stringify returns undefined)', () => 'x'],
      ['symbol (stringify returns undefined)', Symbol('s')],
      ['toJSON -> undefined', toJsonUndefined],
    ] as const) {
      let caught: unknown;
      try {
        buildDefaultUtil().parseJson(value);
      } catch (err) {
        caught = err;
      }
      expect(caught, label).toBeInstanceOf(VtlEvaluationError);
      expect((caught as Error).message, label).toContain('argument length 0)');
    }
  });

  it('reaches the empty-coercion path from a TEMPLATE, not just a direct call', () => {
    // `$input.json` / `$input.path` / `$input.params` are own-property
    // FUNCTIONS on the object `buildVtlInput` returns, so forgetting the call
    // parens hands one straight to `$util.parseJson`. This is the reachable
    // spelling of the case above.
    const ctx = contextWithBody('{"a":1}');
    let caught: unknown;
    try {
      evaluateVtl('$util.parseJson($input.params)', ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VtlEvaluationError);
    expect((caught as Error).message).toContain('argument length 0)');
  });
});

describe('the 502 RESPONSE BODY must not carry the parsed input (go-to-k/cdkd#2203)', () => {
  // The reason reaches the WIRE, not just a terminal: `vtlFailure` copies the
  // VTL failure message into the 502 body. That channel had only Docker-gated
  // coverage (the `local-start-api-rest-v1-non-proxy` integ arm); this case
  // fences it with no container, so a regression INSIDE `vtlFailure` -- say
  // attaching the raw `err`, or dropping the template truncation -- reds in
  // the ordinary unit run.
  //
  // A MOCK integration is the cheapest reachable spelling: its VTL context is
  // built with a hardcoded EMPTY body, so the caller-supplied value has to be
  // a header, which is also the vector the leak was reproduced with.
  function mockRequestWithHeader(value: string) {
    return {
      method: 'POST',
      matchedPath: '/login',
      pathParameters: {},
      querystring: {},
      headers: { xpayload: value },
      body: Buffer.alloc(0),
      sourceIp: '1.2.3.4',
      userAgent: 'test-agent',
      stage: 'prod',
      resourcePath: '/login',
      requestId: 'req-1',
    };
  }

  it('returns 502 without the header value the template failed to parse', () => {
    const needle = 'hunter2pw';
    const outcome = dispatchMockIntegration(
      {
        kind: 'mock',
        requestTemplate: '#set($p = $util.parseJson($input.params(\'xpayload\')))\n{"statusCode": 200}',
        responses: [{ StatusCode: '200', ResponseTemplates: { 'application/json': '{"ok":true}' } }],
      },
      mockRequestWithHeader(needle)
    );

    expect(outcome.statusCode).toBe(502);
    const body = outcome.body.toString();

    // Positives first -- absence alone is satisfied by any unrelated failure.
    expect(body).toContain('VTL request-template evaluation failed');
    expect(body).toContain('$util.parseJson');
    expect(body).toContain('SyntaxError');
    expect(body).toContain(`argument length ${needle.length})`);

    expect(body).not.toContain(needle);
    expect(body).not.toContain('Unexpected token');
  });
});
