import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ResolvedArnLambdaLayer } from '../../../src/local/lambda-resolver.js';

/**
 * Issue go-to-k/cdk-local#647, the SITE half.
 *
 * `tests/unit/utils/aws-proxy-fetch.test.ts` proves the HELPER routes
 * through the proxy; this proves each production call site actually reaches
 * it. The distinction is the whole defect: both sites already had a test
 * seam (`fetchZip`, `fetchImpl`), and every existing test SUPPLIES it — so
 * the production default, which is the only thing issue #647 is about, was
 * exercised by nothing. Mocking `src/utils/aws-proxy.js` and driving the
 * seam-less call is what makes the binding visible.
 *
 * Two properties each case is written to keep, because a binding test is
 * easy to write in a way that goes red for the wrong reason:
 *
 *   - Every URL is a `.invalid` host (RFC 2606). Reverting a call site to
 *     the global `fetch` must FAIL LOCALLY, never leave a unit suite making
 *     a real request to AWS.
 *   - The binding assertion runs BEFORE any assertion about the outcome, and
 *     the call's own rejection is captured rather than thrown. Otherwise a
 *     revert reds the case on the production path throwing first and the
 *     binding assertion is never reached — which reports the right verdict
 *     for the wrong reason, and would keep reporting it after the binding
 *     was fixed but the outcome was not.
 */

const { proxyAwareFetchMock } = vi.hoisted(() => ({ proxyAwareFetchMock: vi.fn() }));

// Spread the REAL module and replace one export. A hand-written stand-in
// froze `buildProxyClientConfig` / `isProxyEnvConfigured` into constants that
// no contract change could fail, and left every other export
// (`EnvRoutingProxyAgent`, the types) undefined for anything else that imports
// this module in the same graph.
vi.mock('../../../src/utils/aws-proxy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/utils/aws-proxy.js')>()),
  proxyAwareFetch: proxyAwareFetchMock,
}));

const { materializeLayerFromArn } = await import('../../../src/local/layer-arn-materializer.js');
const { createJwksCache, verifyJwtViaDiscovery } = await import(
  '../../../src/local/cognito-jwt.js'
);
const { getLogger, setLogger } = await import('../../../src/utils/logger.js');

/**
 * The smallest legal ZIP: an End of Central Directory record declaring zero
 * entries. Enough for `unzipBufferToDirectory` to succeed, so the assertion
 * is about the DOWNLOAD rather than an unzip failure downstream.
 */
function emptyZip(): Buffer {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  return eocd;
}

const PRESIGNED_URL =
  'https://awslambda-layers.s3.us-east-1.amazonaws.invalid/snapshots/l.zip?X-Amz-Signature=deadbeef';
const JWKS_URL = 'https://cognito-idp.us-east-1.amazonaws.invalid/pool/.well-known/jwks.json';
const DISCOVERY_URL = 'https://idp.invalid/.well-known/openid-configuration';

const layer: ResolvedArnLambdaLayer = {
  kind: 'arn',
  logicalId: 'arn:aws:lambda:us-east-1:111122223333:layer:MyLayer:3',
  arn: 'arn:aws:lambda:us-east-1:111122223333:layer:MyLayer:3',
  region: 'us-east-1',
  accountId: '111122223333',
  name: 'MyLayer',
  version: '3',
};

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  proxyAwareFetchMock.mockReset();
});

describe('proxy-aware fetch call-site bindings (issue #647)', () => {
  it('the layer ZIP download goes through proxyAwareFetch when no fetchZip seam is supplied', async () => {
    proxyAwareFetchMock.mockResolvedValue(new Response(emptyZip(), { status: 200 }));

    const outcome = await materializeLayerFromArn(layer, {
      lambdaClientFactory: () => ({
        send: async () => ({ Content: { Location: PRESIGNED_URL } }),
      }),
    }).catch((err: unknown) => err);

    expect(proxyAwareFetchMock).toHaveBeenCalledTimes(1);
    expect(proxyAwareFetchMock).toHaveBeenCalledWith(PRESIGNED_URL);
    expect(outcome).toEqual(expect.any(String));
    cleanupDirs.push(outcome as string);
  });

  it('the JWKS cache reads through proxyAwareFetch when no fetchImpl seam is supplied', async () => {
    proxyAwareFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ keys: [] }), { status: 200 })
    );

    const entry = await createJwksCache().fetchAndCache(JWKS_URL);

    // The JWKS / discovery reads carry an explicit SHORT stall bound: one of
    // them sits on a per-request auth path, where the 300 s default would
    // hold a socket per inbound request behind a black-holed proxy.
    expect(proxyAwareFetchMock).toHaveBeenCalledWith(JWKS_URL, { timeoutMs: 10_000 });
    // Not pass-through: the read reached the mock rather than failing into
    // the unreachable-JWKS fallback, which accepts every token.
    expect(entry.passThrough).toBe(false);
  });

  // The #579 property this PR invokes: since the transport changed, these
  // `catch`es see `node:net` / OpenSSL / proxy-agent text of arbitrary shape
  // where they used to see undici's fixed `fetch failed`. Both lines are
  // default-level and `cdkl studio` mirrors them into a log ring it serves
  // over HTTP, and `studio-serve-manager` matches its ready lines PER LINE —
  // so an embedded newline is not cosmetic. Deleting the
  // `sanitizeServiceExceptionMessage` calls used to be green.
  it('flattens a multi-line transport error out of the layer-download failure', async () => {
    proxyAwareFetchMock.mockRejectedValue(
      new Error('connect ECONNREFUSED 10.0.0.1:3128\nWARN: forged second line\r\nthird')
    );

    const err = await materializeLayerFromArn(layer, {
      lambdaClientFactory: () => ({
        send: async () => ({ Content: { Location: PRESIGNED_URL } }),
      }),
    }).catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('failed to download layer ZIP');
    expect(err.message).not.toMatch(/[\r\n]/);
    expect(err.message).toContain('forged second line');
  });

  it('flattens a multi-line transport error out of the JWKS-unreachable warn', async () => {
    const warn = vi.fn();
    const previous = getLogger();
    setLogger({ ...previous, warn, child: () => ({ ...previous, warn }) } as never);
    try {
      proxyAwareFetchMock.mockRejectedValue(
        new Error('self-signed certificate\nWARN: forged\nline')
      );
      const entry = await createJwksCache().fetchAndCache(JWKS_URL);
      expect(entry.passThrough).toBe(true);
    } finally {
      setLogger(previous);
    }
    const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes('JWKS unreachable'));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/[\r\n]/);
    expect(line).toContain('forged');
  });

  // The THIRD relay. Round 4 measured that deleting all three
  // `sanitizeServiceExceptionMessage` calls reddened only two cases — this
  // site was pinned by nothing, and `cognito-jwt.test.ts`'s discovery-warn
  // case throws a single short line, so flattening is invisible there.
  it('flattens a multi-line transport error out of the OIDC-discovery warn', async () => {
    const warn = vi.fn();
    const previous = getLogger();
    setLogger({ ...previous, warn, child: () => ({ ...previous, warn }) } as never);
    try {
      proxyAwareFetchMock.mockRejectedValue(
        new Error('tunneling socket could not be established\nWARN: forged\r\nline')
      );
      await verifyJwtViaDiscovery(
        { kind: 'discovery', discoveryUrl: DISCOVERY_URL, allowedAudience: ['aud'] },
        'Bearer not.a.jwt',
        createJwksCache({ fetchImpl: async () => new Response('{"keys":[]}', { status: 200 }) })
      );
    } finally {
      setLogger(previous);
    }
    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('OIDC discovery unreachable'));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/[\r\n]/);
    expect(line).toContain('forged');
  });

  // The cap is the other half of "ONE BOUNDED line" — flattening alone still
  // lets an unbounded relay onto a default-level line studio serves over HTTP.
  it('caps an enormous transport error rather than relaying it whole', async () => {
    proxyAwareFetchMock.mockRejectedValue(new Error('z'.repeat(5000)));

    const err = await materializeLayerFromArn(layer, {
      lambdaClientFactory: () => ({
        send: async () => ({ Content: { Location: PRESIGNED_URL } }),
      }),
    }).catch((e: unknown) => e as Error);

    expect(err.message.length).toBeLessThan(1000);
    expect(err.message).toContain('truncated');
  });

  it('OIDC discovery reads through proxyAwareFetch when no fetchImpl seam is supplied', async () => {
    proxyAwareFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          issuer: 'https://idp.invalid',
          jwks_uri: 'https://idp.invalid/.well-known/jwks.json',
        }),
        { status: 200 }
      )
    );

    await verifyJwtViaDiscovery(
      { kind: 'discovery', discoveryUrl: DISCOVERY_URL, allowedAudience: ['aud'] },
      'Bearer not.a.jwt',
      // The JWKS half is seamed here on purpose: this case is about the
      // DISCOVERY read's binding, and an un-seamed cache would add a second
      // call to the same mock and blur which read is being asserted.
      createJwksCache({ fetchImpl: async () => new Response('{"keys":[]}', { status: 200 }) })
    );

    expect(proxyAwareFetchMock).toHaveBeenCalledTimes(1);
    expect(proxyAwareFetchMock).toHaveBeenCalledWith(DISCOVERY_URL, { timeoutMs: 10_000 });
  });
});
