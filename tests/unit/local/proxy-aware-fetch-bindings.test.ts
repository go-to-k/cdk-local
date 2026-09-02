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
 */

const { proxyAwareFetchMock } = vi.hoisted(() => ({ proxyAwareFetchMock: vi.fn() }));

vi.mock('../../../src/utils/aws-proxy.js', () => ({
  proxyAwareFetch: proxyAwareFetchMock,
  // The layer materializer builds its Lambda / STS clients through this;
  // the empty fragment is the real no-proxy return value.
  buildProxyClientConfig: () => ({}),
  isProxyEnvConfigured: () => false,
}));

const { materializeLayerFromArn } = await import('../../../src/local/layer-arn-materializer.js');
const { createJwksCache, verifyJwtViaDiscovery } = await import(
  '../../../src/local/cognito-jwt.js'
);

/**
 * The smallest legal ZIP: an End of Central Directory record declaring zero
 * entries. Enough for `unzipBufferToDirectory` to succeed, so the assertion
 * is about the DOWNLOAD rather than about an unzip failure downstream.
 */
function emptyZip(): Buffer {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  return eocd;
}

const PRESIGNED_URL =
  'https://awslambda-us-east-1-layers.s3.us-east-1.amazonaws.com/snapshots/l.zip?X-Amz-Signature=deadbeef';

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

    const dir = await materializeLayerFromArn(layer, {
      lambdaClientFactory: () => ({
        send: async () => ({ Content: { Location: PRESIGNED_URL } }),
      }),
    });
    cleanupDirs.push(dir);

    expect(proxyAwareFetchMock).toHaveBeenCalledTimes(1);
    expect(proxyAwareFetchMock).toHaveBeenCalledWith(PRESIGNED_URL);
  });

  it('the JWKS cache reads through proxyAwareFetch when no fetchImpl seam is supplied', async () => {
    proxyAwareFetchMock.mockResolvedValue(new Response(JSON.stringify({ keys: [] }), { status: 200 }));

    const cache = createJwksCache();
    const entry = await cache.fetchAndCache('https://cognito-idp.us-east-1.amazonaws.com/pool/.well-known/jwks.json');

    expect(entry.passThrough).toBe(false);
    expect(proxyAwareFetchMock).toHaveBeenCalledWith(
      'https://cognito-idp.us-east-1.amazonaws.com/pool/.well-known/jwks.json'
    );
  });

  it('OIDC discovery reads through proxyAwareFetch when no fetchImpl seam is supplied', async () => {
    proxyAwareFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          issuer: 'https://idp.example.com',
          jwks_uri: 'https://idp.example.com/.well-known/jwks.json',
        }),
        { status: 200 }
      )
    );

    await verifyJwtViaDiscovery(
      {
        kind: 'discovery',
        discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
        allowedAudience: ['aud'],
      },
      'Bearer not.a.jwt',
      createJwksCache({ fetchImpl: async () => new Response('{"keys":[]}', { status: 200 }) })
    );

    expect(proxyAwareFetchMock).toHaveBeenCalledWith(
      'https://idp.example.com/.well-known/openid-configuration'
    );
  });
});
