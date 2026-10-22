import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { http } from '../../helpers/agentless-http.js';

vi.mock('../../../src/local/rie-client.js', () => ({
  invokeRie: vi.fn(),
  invokeRieStreaming: vi.fn(),
}));

import { startApiServer } from '../../../src/local/http-server.js';
import type { RouteWithAuth } from '../../../src/local/authorizer-resolver.js';
import type { ContainerPool } from '../../../src/local/container-pool.js';
import { createAuthorizerCache } from '../../../src/local/authorizer-cache.js';
import { getLogger } from '../../../src/utils/logger.js';
import * as rieClient from '../../../src/local/rie-client.js';

/** The logger line without colour or the severity prefix, which depend on the TTY / env the suite runs under. */
function plainLogLine(m: unknown): string {
  // eslint-disable-next-line no-control-regex -- ANSI SGR sequences are what is stripped.
  return String(m).replace(/\u001b\[[0-9;]*m/g, '').replace(/^(?:WARN|ERROR): /, '');
}

const invokeRieMock = rieClient.invokeRie as unknown as ReturnType<typeof vi.fn>;

// #761: assembly-chosen identifiers in the start-api server's messages render
// bare when plain and as ONE JSON literal when they could forge a boundary.
// Expected strings are written by hand.

let lines: string[] = [];

function makePool(acquireImpl?: () => Promise<unknown>): ContainerPool {
  return {
    acquire: vi.fn(
      acquireImpl ??
        (async () => ({
          containerId: 'c1',
          containerHost: '127.0.0.1',
          hostPort: 1234,
          logicalId: 'X',
          release: vi.fn(),
        }))
    ),
    release: vi.fn(),
    dispose: vi.fn(async () => undefined),
  } as unknown as ContainerPool;
}

function route(opts: {
  lambda?: string;
  declaredAt?: string;
  authorizerId?: string;
  rest?: boolean;
}): RouteWithAuth {
  return {
    route: {
      method: 'GET',
      pathPattern: '/x',
      lambdaLogicalId: opts.lambda ?? 'Fn',
      source: 'rest-v1',
      apiVersion: 'v1',
      stage: 'prod',
      declaredAt: opts.declaredAt ?? 'S/Method-X',
      ...(opts.rest && { restV1Integration: { kind: 'mock' } }),
    } as never,
    ...(opts.authorizerId !== undefined && {
      authorizer: {
        kind: 'lambda-request',
        logicalId: opts.authorizerId,
        lambdaLogicalId: 'AuthFn',
        identitySources: [{ kind: 'header', name: 'authorization' }],
        resultTtlSeconds: 300,
        apiVersion: 'v1',
        declaredAt: 'S/Method-X',
      },
    }),
  };
}

async function hit(
  r: RouteWithAuth,
  pool: ContainerPool,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const server = await startApiServer({
    state: { routes: [r], pool, corsConfigByApiId: new Map() },
    rieTimeoutMs: 1000,
    host: '127.0.0.1',
    port: 0,
    ...extra,
  });
  try {
    await http(`http://${server.host}:${server.port}/x`, {
      headers: { authorization: 'Bearer t' },
    });
  } finally {
    await server.close();
  }
}

function lineWith(needle: string): string {
  const l = lines.find((x) => x.includes(needle));
  expect(l, `no line contained ${needle}`).toBeDefined();
  return l!.replace(/^.*?(?=(Authorizer|REST v1|Failed to|RIE |AWS_IAM|\[))/, '');
}

beforeEach(() => {
  lines = [];
  invokeRieMock.mockReset();
  const grab = (m: unknown): void => {
    lines.push(plainLogLine(m));
  };
  vi.spyOn(console, 'error').mockImplementation(grab);
  vi.spyOn(console, 'warn').mockImplementation(grab);
  vi.spyOn(console, 'debug').mockImplementation(grab);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('http-server renders ids and declaredAt through displayIdent (#761)', () => {
  const throwingCache = (): ReturnType<typeof createAuthorizerCache> =>
    ({
      get: () => {
        throw new Error('boom');
      },
      set: () => undefined,
    }) as never;

  it('Authorizer threw: plain bare', async () => {
    await hit(route({ authorizerId: 'Auth' }), makePool(), { authorizerCache: throwingCache() });
    expect(lineWith('Authorizer ')).toBe('Authorizer Auth threw for S/Method-X: boom');
  });

  it('Authorizer threw: forging ids as JSON literals', async () => {
    await hit(route({ authorizerId: "a' b", declaredAt: 'x\u001b[2Kforged' }), makePool(), {
      authorizerCache: throwingCache(),
    });
    expect(lineWith('Authorizer ')).toBe('Authorizer "a\' b" threw for "x [2Kforged": boom');
  });

  it('REST v1 dispatch failed: plain bare, forging quoted', async () => {
    // A mock integration with no config makes the real dispatcher throw; only
    // the prefix is asserted, the tail is the dispatcher's own message.
    await hit(route({ rest: true }), makePool());
    expect(lineWith('REST v1 ')).toMatch(/^REST v1 mock dispatch failed for S\/Method-X: /);
    lines = [];
    await hit(route({ rest: true, declaredAt: "a' b" }), makePool());
    expect(lineWith('REST v1 ')).toMatch(/^REST v1 mock dispatch failed for "a' b": /);
  });

  it('Failed to acquire container: plain bare, forging quoted', async () => {
    const fail = async (): Promise<never> => {
      throw new Error('nope');
    };
    await hit(route({ lambda: 'Fn1' }), makePool(fail));
    expect(lineWith('Failed to acquire')).toBe('Failed to acquire container for Fn1: nope');
    lines = [];
    await hit(route({ lambda: "a' b" }), makePool(fail));
    expect(lineWith('Failed to acquire')).toBe('Failed to acquire container for "a\' b": nope');
  });

  it('RIE invoke failed: plain bare, forging quoted', async () => {
    invokeRieMock.mockRejectedValue(new Error('down'));
    await hit(route({ lambda: 'Fn1' }), makePool());
    expect(lineWith('RIE invoke failed')).toBe('RIE invoke failed for Fn1: down');
    lines = [];
    await hit(route({ lambda: 'x\u001b[2Kforged' }), makePool());
    expect(lineWith('RIE invoke failed')).toBe('RIE invoke failed for "x [2Kforged": down');
  });

  it('RIE streaming invoke failed: plain bare, forging quoted', async () => {
    (rieClient.invokeRieStreaming as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('down')
    );
    const mk = (lambda: string): RouteWithAuth => {
      const r = route({ lambda });
      (r.route as { invokeMode?: string }).invokeMode = 'RESPONSE_STREAM';
      return r;
    };
    await hit(mk('Fn1'), makePool());
    expect(lineWith('RIE streaming')).toBe('RIE streaming invoke failed for Fn1: down');
    lines = [];
    await hit(mk("a' b"), makePool());
    expect(lineWith('RIE streaming')).toBe('RIE streaming invoke failed for "a\' b": down');
  });

  it('service-integration mapping error warn prefix: plain bare, forging quoted', async () => {
    const mk = (declaredAt: string): RouteWithAuth => ({
      route: {
        method: 'GET',
        pathPattern: '/x',
        lambdaLogicalId: '',
        source: 'http-api',
        apiVersion: 'v2',
        stage: '$default',
        declaredAt,
        serviceIntegration: { subtype: 'SQS-SendMessage', requestParameters: { QueueUrl: 5 } },
      } as never,
    });
    await hit(mk('S/Route-X'), makePool());
    expect(lines.find((l) => l.includes('RequestParameters'))).toContain(
      '[S/Route-X] RequestParameters["QueueUrl"] must be a string'
    );
    lines = [];
    await hit(mk("a' b"), makePool());
    expect(lines.find((l) => l.includes('RequestParameters'))).toContain(
      '["a\' b"] RequestParameters["QueueUrl"] must be a string'
    );
  });

  it('AWS_IAM without a credentials loader (debug): plain bare, forging quoted', async () => {
    const prev = getLogger().getLevel();
    getLogger().setLevel('debug');
    try {
      const mk = (declaredAt: string): RouteWithAuth => {
        const r = route({ declaredAt });
        r.authorizer = { kind: 'iam', logicalId: 'Iam', declaredAt } as never;
        return r;
      };
      await hit(mk('S/Method-X'), makePool());
      expect(lineWith('AWS_IAM authorizer')).toBe(
        'AWS_IAM authorizer for S/Method-X: no SigV4 credentials loader configured — denying.'
      );
      lines = [];
      await hit(mk("a' b"), makePool());
      expect(lineWith('AWS_IAM authorizer')).toBe(
        'AWS_IAM authorizer for "a\' b": no SigV4 credentials loader configured — denying.'
      );
    } finally {
      getLogger().setLevel(prev);
    }
  });
});
