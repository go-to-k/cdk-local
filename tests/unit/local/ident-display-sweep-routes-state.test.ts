/**
 * go-to-k/cdk-local#761 sweep (route discovery / state resolver / VTL /
 * REST v1 mapping): an assembly-chosen identifier interpolated into a message
 * prints bare when plain and as ONE JSON string literal when it could forge a
 * boundary. Expected strings are computed by hand, never by calling the helper.
 */
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { discoverRoutes } from '../../../src/local/route-discovery.js';
import { discoverWebSocketApis } from '../../../src/local/websocket-route-discovery.js';
import { substituteAgainstState } from '../../../src/local/state-resolver.js';
import { dispatchHttpProxyIntegration } from '../../../src/local/rest-v1-integrations.js';
import { getLogger } from '../../../src/utils/logger.js';
import { evaluateResponseParameters } from '../../../src/local/integration-response-selector.js';
import { evaluateVtl, buildDefaultUtil, buildVtlInput, buildVtlRequestContext } from '../../../src/local/vtl-engine.js';
import type { VtlContext } from '../../../src/local/vtl-engine.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { TemplateResource } from '../../../src/types/resource.js';

function buildStack(stackName: string, resources: Record<string, TemplateResource>): StackInfo {
  return {
    stackName,
    displayName: stackName,
    artifactId: stackName,
    template: { Resources: resources },
    dependencyNames: [],
  };
}

function restOrphan(parentLogicalId: string, stackName = 'S'): StackInfo {
  return buildStack(stackName, {
    Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
    Orphan: {
      Type: 'AWS::ApiGateway::Resource',
      Properties: {
        RestApiId: { Ref: 'Api' },
        ParentId: { Ref: parentLogicalId },
        PathPart: 'orphan',
      },
    },
    Method: {
      Type: 'AWS::ApiGateway::Method',
      Properties: {
        HttpMethod: 'GET',
        RestApiId: { Ref: 'Api' },
        ResourceId: { Ref: 'Orphan' },
        Integration: { Type: 'AWS_PROXY', Uri: { 'Fn::GetAtt': ['Fn', 'Arn'] } },
      },
    },
  });
}

describe('route-discovery ident display', () => {
  it('renders a plain logical id bare', () => {
    expect(() => discoverRoutes([restOrphan('Gone')])).toThrow(
      'S/Method: ParentId chain references missing resource Gone'
    );
  });

  it("renders a forging logical id as one JSON literal, not inside cdk-local's quotes", () => {
    expect(() => discoverRoutes([restOrphan("a' b")])).toThrow(
      `S/Method: ParentId chain references missing resource "a' b"`
    );
  });

  it('flattens a control character in a stack name at the message prefix', () => {
    expect(() => discoverRoutes([restOrphan('Gone', 'x\u001b[2Kforged')])).toThrow(
      '"x [2Kforged/Method": ParentId chain references missing resource Gone'
    );
  });
});

describe('websocket-route-discovery ident display', () => {
  function wsStack(routeKey: string): StackInfo {
    return buildStack('S', {
      Fn: { Type: 'AWS::Lambda::Function', Properties: {} },
      WsApi: {
        Type: 'AWS::ApiGatewayV2::Api',
        Properties: { ProtocolType: 'WEBSOCKET', RouteSelectionExpression: '$request.body.action' },
      },
      Integ: {
        Type: 'AWS::ApiGatewayV2::Integration',
        Properties: { ApiId: { Ref: 'WsApi' }, IntegrationType: 'MOCK' },
      },
      Route: {
        Type: 'AWS::ApiGatewayV2::Route',
        Properties: {
          ApiId: { Ref: 'WsApi' },
          RouteKey: routeKey,
          Target: { 'Fn::Join': ['/', ['integrations', { Ref: 'Integ' }]] },
        },
      },
    });
  }

  it('renders a plain IntegrationType bare', () => {
    const { errors } = discoverWebSocketApis([wsStack('$connect')]);
    expect(errors[0]).toContain('S/Route: WebSocket route IntegrationType MOCK is not supported');
  });

  it('renders a forging IntegrationType as a JSON literal', () => {
    const stack = wsStack('$connect');
    stack.template.Resources!['Integ']!.Properties!['IntegrationType'] = "a' b";
    const { errors } = discoverWebSocketApis([stack]);
    expect(errors[0]).toContain(`IntegrationType "a' b" is not supported`);
  });
});

describe('state-resolver ident display', () => {
  const ctx = { resources: {} };

  it('renders a plain unsupported intrinsic bare', () => {
    const r = substituteAgainstState({ 'Fn::Bogus': 1 }, ctx);
    expect(r).toEqual({
      kind: 'unresolved',
      reason: expect.stringContaining('unsupported intrinsic Fn::Bogus ('),
    });
  });

  it('renders a forging Ref target as a JSON literal', () => {
    const r = substituteAgainstState({ Ref: "a' b" }, ctx);
    expect(r.kind).toBe('unresolved');
    expect((r as { reason: string }).reason).toContain(`Ref "a' b": no record in the state source`);
  });

  it('flattens a control character in a GetAtt logical id', () => {
    const r = substituteAgainstState({ 'Fn::GetAtt': ['x\u001b[2Kforged', 'Arn'] }, ctx);
    expect((r as { reason: string }).reason).toContain(
      'Fn::GetAtt "x [2Kforged.Arn": no record in the state source'
    );
  });

  it('keeps the Sub placeholder braces and renders the name bare when plain', () => {
    const r = substituteAgainstState({ 'Fn::Sub': 'x-${Missing}' }, ctx);
    expect((r as { reason: string }).reason).toContain('Fn::Sub placeholder ${Missing}: Ref Missing:');
  });
});

describe('integration-response-selector ident display', () => {
  it('renders a forging ResponseParameter value as a JSON literal', () => {
    const reasons: string[] = [];
    evaluateResponseParameters(
      { 'method.response.header.X': "integration.response.header.a' b" },
      { onUnsupported: (_k, _v, reason) => reasons.push(reason) }
    );
    expect(reasons[0]).toContain(`ResponseParameter value "integration.response.header.a' b" is a mapping`);
  });

  it('renders a plain mapping expression bare', () => {
    const reasons: string[] = [];
    evaluateResponseParameters(
      { 'method.response.header.X': 'integration.response.header.Foo' },
      { onUnsupported: (_k, _v, reason) => reasons.push(reason) }
    );
    expect(reasons[0]).toContain('ResponseParameter value integration.response.header.Foo is a mapping');
  });
});

describe('vtl-engine ident display', () => {
  const vtlCtx: VtlContext = {
    input: buildVtlInput('{}', {}, {}, {}),
    context: buildVtlRequestContext({
      requestId: 'r',
      httpMethod: 'GET',
      resourcePath: '/',
      stage: 'prod',
      sourceIp: '1.2.3.4',
      userAgent: 'ua',
    }),
    util: buildDefaultUtil(),
  };

  it('renders the offending #set left side as a JSON literal', () => {
    expect(() => evaluateVtl("#set(a\u001b[2K = 1)", vtlCtx)).toThrow(
      `#set left side must be a $var reference (got "a [2K")`
    );
  });

  it('renders a plain left side bare', () => {
    expect(() => evaluateVtl('#set(plain = 1)', vtlCtx)).toThrow(
      '#set left side must be a $var reference (got plain)'
    );
  });
});


describe('rest-v1 RequestParameter warn ident display', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function warnsFor(requestParameters: Record<string, string>): Promise<string[]> {
    const warns: string[] = [];
    const logger = getLogger().child('start-api');
    vi.spyOn(Object.getPrototypeOf(logger), 'warn').mockImplementation((m: unknown) => {
      warns.push(String(m));
    });
    await dispatchHttpProxyIntegration(
      { kind: 'http-proxy', uri: 'http://example.com/x', requestParameters, responses: [] },
      {
        method: 'GET',
        matchedPath: '/x',
        pathParameters: {},
        querystring: {},
        headers: {},
        body: Buffer.alloc(0),
        sourceIp: '1.2.3.4',
        userAgent: 'ua',
        stage: 'prod',
        resourcePath: '/x',
        requestId: 'r',
      },
      {
        pool: { acquire: vi.fn(), release: vi.fn() } as never,
        rieTimeoutMs: 1000,
        fetch: (async () => new Response('ok', { status: 200 })) as typeof fetch,
      }
    );
    return warns;
  }

  it('renders a plain key bare', async () => {
    const warns = await warnsFor({ Foo: "bar" });
    expect(warns).toContain("RequestParameter Foo value bar is not a recognized mapping; skipping.");
  });

  it('renders a forging key and value as JSON literals', async () => {
    const warns = await warnsFor({ "bad' key": 'x\u001b[2Kforged' });
    expect(warns.some((w) => w.includes('RequestParameter "bad\' key" value "x [2Kforged" is not a recognized mapping'))).toBe(true);
  });
});
