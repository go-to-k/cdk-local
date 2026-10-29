import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ResolvedDistribution } from '../../../src/local/cloudfront-resolver.js';
import {
  startCloudFrontServer,
  type StartedCloudFrontServer,
} from '../../../src/local/cloudfront-server.js';

/** The logger line without colour or the severity prefix, which depend on the TTY / env the suite runs under. */
function plainLogLine(m: unknown): string {
  // eslint-disable-next-line no-control-regex -- ANSI SGR sequences are what is stripped.
  return String(m).replace(/\u001b\[[0-9;]*m/g, '').replace(/^(?:WARN|ERROR): /, '');
}

// #761: the origin-unavailable body and the not-booted Lambda@Edge warn render
// assembly-chosen identifiers through displayIdent / displayUntrustedValue.
// Expected strings are written by hand.

let server: StartedCloudFrontServer | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await server?.close();
  server = undefined;
});

async function bodyFor(
  dist: Omit<ResolvedDistribution, 'logicalId' | 'stackName' | 'customErrorResponses'>,
  path = '/api'
): Promise<string> {
  server = await startCloudFrontServer({
    distribution: {
      logicalId: 'Dist',
      stackName: 'Stack',
      customErrorResponses: [],
      ...dist,
    } as ResolvedDistribution,
    host: '127.0.0.1',
    port: 0,
  });
  const res = await fetch(`${server.url}${path}`);
  expect(res.status).toBe(502);
  return res.text();
}

describe('cloudfront-server origin-unavailable message (#761)', () => {
  it('unknown origin: plain origin id and pattern bare', async () => {
    const body = await bodyFor({
      behaviors: [{ targetOriginId: 'o1', pathPattern: '/api' }],
      origins: new Map(),
    });
    expect(body).toBe('Behavior /api targets unknown origin o1.\n');
  });

  it('unknown origin: forging origin id and pattern as JSON literals', async () => {
    const body = await bodyFor({
      behaviors: [{ targetOriginId: "a' b", pathPattern: '/api*' }],
      origins: new Map(),
    });
    expect(body).toBe('Behavior "/api*" targets unknown origin "a\' b".\n');
  });

  it('unknown origin: default behavior prints (default)', async () => {
    const body = await bodyFor({
      behaviors: [{ targetOriginId: 'x\u001b[2Kforged' }],
      origins: new Map(),
    });
    expect(body).toBe('Behavior (default) targets unknown origin "x [2Kforged".\n');
  });

  it('lambda-url origin not booted: plain bare, forging quoted', async () => {
    const mk = (originId: string, fn: string) =>
      bodyFor({
        behaviors: [{ targetOriginId: originId }],
        origins: new Map([
          [
            originId,
            { kind: 'lambda-url', originId, functionLogicalId: fn, functionUrlLogicalId: 'U' },
          ],
        ]),
      });
    expect(await mk('fn', 'Fn1')).toBe(
      'Origin fn is a Lambda Function URL origin whose backing function Fn1 was not booted (it was added after start-up). Restart start-cloudfront.\n'
    );
    await server?.close();
    expect(await mk("a' b", 'x\u001b[2Kforged')).toBe(
      'Origin "a\' b" is a Lambda Function URL origin whose backing function "x [2Kforged" was not booted (it was added after start-up). Restart start-cloudfront.\n'
    );
  });

  it('custom origin: plain domain bare, forging domain quoted', async () => {
    const mk = (domainName: string, originId: string) =>
      bodyFor({
        behaviors: [{ targetOriginId: originId }],
        origins: new Map([[originId, { kind: 'custom', originId, domainName }]]),
      });
    expect(await mk('api.example.com', 'c1')).toBe(
      'Origin c1 is a custom (non-S3) origin (api.example.com). cdkl start-cloudfront serves S3, Lambda Function URL and Lambda Web Function endpoint origins only.\n'
    );
    await server?.close();
    expect(await mk('evil.example.com) -- ok (', "a' b")).toBe(
      'Origin "a\' b" is a custom (non-S3) origin ("evil.example.com) -- ok ("). cdkl start-cloudfront serves S3, Lambda Function URL and Lambda Web Function endpoint origins only.\n'
    );
  });

  it('deployed-S3 origin without a reader: plain bare, forging quoted', async () => {
    const mk = (bucketName: string, originId: string) =>
      bodyFor({
        behaviors: [{ targetOriginId: originId }],
        origins: new Map([[originId, { kind: 's3-deployed', originId, bucketName }]]),
      });
    expect(await mk('my-bucket', 's1')).toBe(
      'Origin s1 is a deployed-S3 origin (bucket my-bucket) whose reader was not booted (it was promoted after start-up). Restart start-cloudfront.\n'
    );
    await server?.close();
    expect(await mk("b' x", "a' b")).toBe(
      'Origin "a\' b" is a deployed-S3 origin (bucket "b\' x") whose reader was not booted (it was promoted after start-up). Restart start-cloudfront.\n'
    );
  });

  it('unresolved S3 origin: plain origin id bare, forging quoted', async () => {
    const mk = (originId: string) =>
      bodyFor({
        behaviors: [{ targetOriginId: originId }],
        origins: new Map([[originId, { kind: 's3-unresolved', originId }]]),
      });
    expect(await mk('s1')).toBe(
      'Origin s1 is an S3 origin with no resolvable local source. Point it at a directory with --origin s1=<dir>.\n'
    );
    await server?.close();
    expect(await mk("a' b")).toContain(
      'Origin "a\' b" is an S3 origin with no resolvable local source.'
    );
  });
});

describe('cloudfront-server Lambda@Edge not-booted warn (#761)', () => {
  async function warnFor(fn: string): Promise<string> {
    const lines: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((m: unknown) => {
      lines.push(plainLogLine(m));
    });
    server = await startCloudFrontServer({
      distribution: {
        logicalId: 'Dist',
        stackName: 'Stack',
        customErrorResponses: [],
        behaviors: [
          {
            targetOriginId: 'o1',
            lambdaEdge: { viewerRequest: { functionLogicalId: fn, includeBody: false } },
          },
        ],
        origins: new Map([['o1', { kind: 's3-unresolved', originId: 'o1' }]]),
      } as ResolvedDistribution,
      host: '127.0.0.1',
      port: 0,
    });
    await fetch(`${server.url}/`);
    const line = lines
      .flatMap((l) => l.split('\n'))
      .find((m) => m.includes('was not booted'))
      ?.replace(/^WARN: /, '');
    expect(line).toBeDefined();
    return line!;
  }

  it('plain function id bare', async () => {
    expect(await warnFor('Ghost')).toBe(
      'Lambda@Edge viewer-request function Ghost was not booted (it failed to boot at start-up, see the boot warning, or was added after start-up); skipping. Restart start-cloudfront.'
    );
  });

  it('forging function id as one JSON literal', async () => {
    expect(await warnFor("a' b")).toBe(
      'Lambda@Edge viewer-request function "a\' b" was not booted (it failed to boot at start-up, see the boot warning, or was added after start-up); skipping. Restart start-cloudfront.'
    );
  });
});
