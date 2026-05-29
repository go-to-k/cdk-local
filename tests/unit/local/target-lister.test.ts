import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  countTargets,
  listTargets,
  sortApiEntries,
  type TargetEntry,
} from '../../../src/local/target-lister.js';
import { getLogger } from '../../../src/utils/logger.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { CloudFormationTemplate, TemplateResource } from '../../../src/types/resource.js';

describe('sortApiEntries', () => {
  it('groups by kind (HTTP -> REST -> Function URL -> WebSocket), then path within a kind', () => {
    const e = (logicalId: string, kind: string): TargetEntry => ({
      logicalId,
      stackName: 'App',
      qualifiedId: `App:${logicalId}`,
      displayPath: `App/${logicalId}`,
      kind,
    });
    const sorted = sortApiEntries([
      e('OacUrl', 'Function URL'),
      e('MyRest', 'REST API v1'),
      e('IamUrl', 'Function URL'),
      e('MyHttp', 'HTTP API v2'),
      e('Ws', 'WebSocket'),
    ]);
    expect(sorted.map((x) => x.logicalId)).toEqual([
      'MyHttp', // HTTP API v2
      'MyRest', // REST API v1
      'IamUrl', // Function URL, path-sorted (App/IamUrl < App/OacUrl)
      'OacUrl',
      'Ws', // WebSocket
    ]);
  });

  it('orders by stack first in a multi-stack app, then kind, then path', () => {
    const e = (stackName: string, logicalId: string, kind: string): TargetEntry => ({
      logicalId,
      stackName,
      qualifiedId: `${stackName}:${logicalId}`,
      displayPath: `${stackName}/${logicalId}`,
      kind,
    });
    const sorted = sortApiEntries([
      e('Beta', 'BFn', 'Function URL'),
      e('Alpha', 'AFn', 'Function URL'),
      e('Beta', 'BHttp', 'HTTP API v2'),
      e('Alpha', 'AHttp', 'HTTP API v2'),
    ]);
    // Alpha block (kind-grouped) first, then Beta block.
    expect(sorted.map((x) => `${x.stackName}:${x.logicalId}`)).toEqual([
      'Alpha:AHttp',
      'Alpha:AFn',
      'Beta:BHttp',
      'Beta:BFn',
    ]);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function buildStack(stackName: string, resources: Record<string, TemplateResource>): StackInfo {
  const template: CloudFormationTemplate = { Resources: resources };
  return {
    stackName,
    displayName: stackName,
    artifactId: stackName,
    template,
    dependencyNames: [],
  };
}

function withPath(resource: TemplateResource, cdkPath: string): TemplateResource {
  return { ...resource, Metadata: { 'aws:cdk:path': cdkPath } };
}

describe('listTargets — Lambda functions', () => {
  it('enumerates AWS::Lambda::Function with both target forms, stripping trailing /Resource', () => {
    const stack = buildStack('App', {
      Handler: withPath(
        { Type: 'AWS::Lambda::Function', Properties: {} },
        'App/Handler/Resource'
      ),
    });
    const { lambdas } = listTargets([stack]);
    expect(lambdas).toEqual([
      {
        logicalId: 'Handler',
        stackName: 'App',
        qualifiedId: 'App:Handler',
        displayPath: 'App/Handler',
      },
    ]);
  });

  it('omits displayPath when the resource carries no aws:cdk:path metadata', () => {
    const stack = buildStack('App', {
      Raw: { Type: 'AWS::Lambda::Function', Properties: {} },
    });
    const { lambdas } = listTargets([stack]);
    expect(lambdas).toEqual([
      { logicalId: 'Raw', stackName: 'App', qualifiedId: 'App:Raw' },
    ]);
  });
});

describe('listTargets — ECS', () => {
  it('separates AWS::ECS::Service (start-service) from AWS::ECS::TaskDefinition (run-task)', () => {
    const stack = buildStack('App', {
      OrdersService: withPath(
        { Type: 'AWS::ECS::Service', Properties: {} },
        'App/OrdersService/Service'
      ),
      OrdersTaskDef: withPath(
        { Type: 'AWS::ECS::TaskDefinition', Properties: {} },
        'App/OrdersService/TaskDef/Resource'
      ),
    });
    const { ecsServices, ecsTaskDefinitions } = listTargets([stack]);
    expect(ecsServices).toEqual([
      {
        logicalId: 'OrdersService',
        stackName: 'App',
        qualifiedId: 'App:OrdersService',
        displayPath: 'App/OrdersService/Service',
      },
    ]);
    expect(ecsTaskDefinitions).toEqual([
      {
        logicalId: 'OrdersTaskDef',
        stackName: 'App',
        qualifiedId: 'App:OrdersTaskDef',
        displayPath: 'App/OrdersService/TaskDef',
      },
    ]);
  });
});

describe('listTargets — AgentCore Runtimes', () => {
  it('enumerates AWS::BedrockAgentCore::Runtime with both target forms', () => {
    const stack = buildStack('App', {
      ChatAgent: withPath(
        { Type: 'AWS::BedrockAgentCore::Runtime', Properties: {} },
        'App/ChatAgent/Resource'
      ),
    });
    const { agentCoreRuntimes } = listTargets([stack]);
    expect(agentCoreRuntimes).toEqual([
      {
        logicalId: 'ChatAgent',
        stackName: 'App',
        qualifiedId: 'App:ChatAgent',
        displayPath: 'App/ChatAgent',
      },
    ]);
  });
});

describe('listTargets — APIs', () => {
  it('collapses an HTTP API v2 to one entry across its routes', () => {
    const api = withPath(
      { Type: 'AWS::ApiGatewayV2::Api', Properties: { ProtocolType: 'HTTP' } },
      'App/HttpApi/Resource'
    );
    const integration: TemplateResource = {
      Type: 'AWS::ApiGatewayV2::Integration',
      Properties: {
        IntegrationType: 'AWS_PROXY',
        IntegrationUri: { 'Fn::GetAtt': ['Handler', 'Arn'] },
      },
    };
    const route = (key: string): TemplateResource => ({
      Type: 'AWS::ApiGatewayV2::Route',
      Properties: {
        ApiId: { Ref: 'HttpApi' },
        RouteKey: key,
        Target: { 'Fn::Join': ['', ['integrations/', { Ref: 'Integration' }]] },
      },
    });
    const stack = buildStack('App', {
      HttpApi: api,
      Integration: integration,
      RouteA: route('GET /a'),
      RouteB: route('POST /b'),
      Handler: { Type: 'AWS::Lambda::Function', Properties: {} },
    });
    const { apis } = listTargets([stack]);
    expect(apis).toEqual([
      {
        logicalId: 'HttpApi',
        stackName: 'App',
        qualifiedId: 'App:HttpApi',
        displayPath: 'App/HttpApi',
        kind: 'HTTP API v2',
      },
    ]);
  });

  it('lists a Function URL keyed and pathed by its backing Lambda (start-api target form)', () => {
    const stack = buildStack('App', {
      Handler: withPath(
        { Type: 'AWS::Lambda::Function', Properties: {} },
        'App/Handler/Resource'
      ),
      HandlerUrl: {
        Type: 'AWS::Lambda::Url',
        Properties: { TargetFunctionArn: { 'Fn::GetAtt': ['Handler', 'Arn'] }, AuthType: 'NONE' },
      },
    });
    const { apis } = listTargets([stack]);
    // start-api addresses a Function URL by its BACKING LAMBDA (logical ID
    // + cdk path), not the URL resource — so both forms point at Handler,
    // matching `routeMatchesIdentifier` in api-server-grouping.ts.
    expect(apis).toEqual([
      {
        logicalId: 'Handler',
        stackName: 'App',
        qualifiedId: 'App:Handler',
        displayPath: 'App/Handler',
        kind: 'Function URL',
      },
    ]);
  });

  it('includes WebSocket APIs (one entry, paths to the API resource)', () => {
    const stack = buildStack('App', {
      WsHandler: { Type: 'AWS::Lambda::Function', Properties: {} },
      WsApi: withPath(
        {
          Type: 'AWS::ApiGatewayV2::Api',
          Properties: { ProtocolType: 'WEBSOCKET', RouteSelectionExpression: '$request.body.action' },
        },
        'App/WsApi/Resource'
      ),
      ConnectInteg: {
        Type: 'AWS::ApiGatewayV2::Integration',
        Properties: {
          ApiId: { Ref: 'WsApi' },
          IntegrationType: 'AWS_PROXY',
          IntegrationUri: { 'Fn::GetAtt': ['WsHandler', 'Arn'] },
        },
      },
      ConnectRoute: {
        Type: 'AWS::ApiGatewayV2::Route',
        Properties: {
          ApiId: { Ref: 'WsApi' },
          RouteKey: '$connect',
          Target: { 'Fn::Join': ['', ['integrations/', { Ref: 'ConnectInteg' }]] },
        },
      },
    });
    const { apis } = listTargets([stack]);
    expect(apis).toEqual([
      {
        logicalId: 'WsApi',
        stackName: 'App',
        qualifiedId: 'App:WsApi',
        displayPath: 'App/WsApi',
        kind: 'WebSocket',
      },
    ]);
  });

  it('downgrades a route-discovery hard error to a warning and still lists other targets', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    const stack = buildStack('App', {
      Handler: { Type: 'AWS::Lambda::Function', Properties: {} },
      // Malformed HTTP API route: ApiId is not a { Ref } — discoverRoutes throws.
      BadRoute: {
        Type: 'AWS::ApiGatewayV2::Route',
        Properties: { ApiId: 'not-a-ref', RouteKey: 'GET /x', Target: 'integrations/whatever' },
      },
    });
    const { apis, lambdas } = listTargets([stack]);
    expect(warn).toHaveBeenCalledOnce();
    expect(apis).toEqual([]);
    // The Lambda category is unaffected by the API-discovery failure.
    expect(lambdas.map((l) => l.qualifiedId)).toEqual(['App:Handler']);
  });

  it('surfaces a WebSocket discovery error as a warning without throwing', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    const stack = buildStack('App', {
      Handler: { Type: 'AWS::Lambda::Function', Properties: {} },
      // WebSocket API with no routes — discoverWebSocketApis returns an error
      // (it does not throw), which listTargets warns about per entry.
      WsApi: {
        Type: 'AWS::ApiGatewayV2::Api',
        Properties: { ProtocolType: 'WEBSOCKET' },
      },
    });
    const { apis, lambdas } = listTargets([stack]);
    expect(warn).toHaveBeenCalledOnce();
    expect(apis).toEqual([]);
    expect(lambdas.map((l) => l.qualifiedId)).toEqual(['App:Handler']);
  });
});

describe('listTargets — multi-stack + ordering', () => {
  it('qualifies each target by its own stack and sorts by display path', () => {
    const stackA = buildStack('Beta', {
      ZHandler: withPath({ Type: 'AWS::Lambda::Function', Properties: {} }, 'Beta/ZHandler/Resource'),
    });
    const stackB = buildStack('Alpha', {
      AHandler: withPath({ Type: 'AWS::Lambda::Function', Properties: {} }, 'Alpha/AHandler/Resource'),
    });
    const { lambdas } = listTargets([stackA, stackB]);
    expect(lambdas.map((l) => l.qualifiedId)).toEqual(['Alpha:AHandler', 'Beta:ZHandler']);
  });
});

describe('countTargets', () => {
  it('sums every category', () => {
    const stack = buildStack('App', {
      Fn: { Type: 'AWS::Lambda::Function', Properties: {} },
      Svc: { Type: 'AWS::ECS::Service', Properties: {} },
      Td: { Type: 'AWS::ECS::TaskDefinition', Properties: {} },
      Agent: { Type: 'AWS::BedrockAgentCore::Runtime', Properties: {} },
    });
    const listing = listTargets([stack]);
    expect(countTargets(listing)).toBe(4);
  });

  it('returns 0 for an app with no runnable targets', () => {
    const stack = buildStack('App', {
      Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
    });
    const listing = listTargets([stack]);
    expect(countTargets(listing)).toBe(0);
    expect(listing).toEqual({
      lambdas: [],
      apis: [],
      ecsServices: [],
      ecsTaskDefinitions: [],
      agentCoreRuntimes: [],
      loadBalancers: [],
    });
  });

  it('enumerates application load balancers (start-alb) and skips network LBs', () => {
    const stack = buildStack('App', {
      WebLB: {
        Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
        Properties: { Type: 'application' },
      },
      DefaultLB: { Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', Properties: {} },
      Nlb: {
        Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
        Properties: { Type: 'network' },
      },
    });
    const listing = listTargets([stack]);
    expect(listing.loadBalancers.map((e) => e.logicalId).sort()).toEqual(['DefaultLB', 'WebLB']);
  });
});
