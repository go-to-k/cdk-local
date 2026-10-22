/**
 * go-to-k/cdk-local#761: route-discovery's v2 Route (Target / RouteKey) and the
 * REST v1 ParentId-cycle messages. An assembly-chosen identifier prints bare when
 * plain and as ONE JSON literal when it could forge a boundary. Expected
 * strings are written by hand.
 */
import { describe, expect, it } from 'vite-plus/test';
import { discoverRoutes } from '../../../src/local/route-discovery.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { TemplateResource } from '../../../src/types/resource.js';

function stack(name: string, resources: Record<string, TemplateResource>): StackInfo {
  return {
    stackName: name,
    displayName: name,
    artifactId: name,
    template: { Resources: resources },
    dependencyNames: [],
  };
}

function v2(opts: {
  stackName?: string;
  routeId?: string;
  routeKey?: string;
  target: unknown;
  extra?: Record<string, TemplateResource>;
}): StackInfo {
  const routeId = opts.routeId ?? 'Route';
  return stack(opts.stackName ?? 'S', {
    Api: { Type: 'AWS::ApiGatewayV2::Api', Properties: { ProtocolType: 'HTTP' } },
    ...opts.extra,
    [routeId]: {
      Type: 'AWS::ApiGatewayV2::Route',
      Properties: {
        ApiId: { Ref: 'Api' },
        RouteKey: opts.routeKey ?? 'GET /x',
        Target: opts.target,
      },
    },
  });
}

describe('route-discovery v2 Route messages (#761)', () => {
  it('literal Target without integrations/: plain bare, forging quoted', () => {
    expect(() => discoverRoutes([v2({ target: 'wrong' })])).toThrow(
      "S/Route.Target: literal Target wrong must start with 'integrations/'"
    );
    expect(() => discoverRoutes([v2({ target: "a' b" })])).toThrow(
      `S/Route.Target: literal Target "a' b" must start with 'integrations/'`
    );
  });

  it('literal Target prefix: forging stack name is quoted at the prefix', () => {
    expect(() => discoverRoutes([v2({ stackName: 'x\u001b[2Kforged', target: 'wrong' })])).toThrow(
      '"x [2Kforged/Route".Target: literal Target wrong'
    );
  });

  it('Target pointing at a non-Integration: plain bare, forging quoted', () => {
    expect(() => discoverRoutes([v2({ target: 'integrations/Missing' })])).toThrow(
      'S/Route (AWS::ApiGatewayV2::Route): Target points at Missing which is not an AWS::ApiGatewayV2::Integration'
    );
    expect(() => discoverRoutes([v2({ target: "integrations/a' b" })])).toThrow(
      `S/Route (AWS::ApiGatewayV2::Route): Target points at "a' b" which is not an AWS::ApiGatewayV2::Integration`
    );
  });

  it('malformed RouteKey: plain bare, forging quoted', () => {
    const integ: Record<string, TemplateResource> = {
      Integ: {
        Type: 'AWS::ApiGatewayV2::Integration',
        Properties: {
          ApiId: { Ref: 'Api' },
          IntegrationType: 'AWS_PROXY',
          IntegrationUri: { 'Fn::GetAtt': ['Handler', 'Arn'] },
        },
      },
    };
    expect(() =>
      discoverRoutes([v2({ routeKey: 'BADKEY', target: 'integrations/Integ', extra: integ })])
    ).toThrow(
      "RouteKey BADKEY is malformed: expected '<METHOD> <path>' (e.g. 'GET /items/{id}') or '$default'."
    );
    expect(() =>
      discoverRoutes([v2({ routeKey: "GET a' b", target: 'integrations/Integ', extra: integ })])
    ).toThrow(
      `RouteKey "GET a' b" is malformed: expected '<METHOD> <path>' (e.g. 'GET /items/{id}') or '$default'.`
    );
  });
});

describe('route-discovery REST v1 ParentId cycle (#761)', () => {
  function cyclic(a: string, b: string): StackInfo {
    return stack('S', {
      Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
      [a]: {
        Type: 'AWS::ApiGateway::Resource',
        Properties: { RestApiId: { Ref: 'Api' }, ParentId: { Ref: b }, PathPart: 'a' },
      },
      [b]: {
        Type: 'AWS::ApiGateway::Resource',
        Properties: { RestApiId: { Ref: 'Api' }, ParentId: { Ref: a }, PathPart: 'b' },
      },
      Method: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'GET',
          RestApiId: { Ref: 'Api' },
          ResourceId: { Ref: a },
          Integration: { Type: 'AWS_PROXY', Uri: { 'Fn::GetAtt': ['Fn', 'Arn'] } },
        },
      },
    });
  }

  it('plain cursor bare, forging cursor as one JSON literal', () => {
    expect(() => discoverRoutes([cyclic('ResA', 'ResB')])).toThrow(
      'S/Method: cycle detected in AWS::ApiGateway::Resource ParentId chain at ResA'
    );
    expect(() => discoverRoutes([cyclic("a' b", 'ResB')])).toThrow(
      `S/Method: cycle detected in AWS::ApiGateway::Resource ParentId chain at "a' b"`
    );
  });
});
