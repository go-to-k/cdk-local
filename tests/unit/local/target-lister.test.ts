import { describe, expect, it } from 'vite-plus/test';
import { countTargets, listTargets } from '../../../src/local/target-lister.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { CloudFormationTemplate, TemplateResource } from '../../../src/types/resource.js';

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
      },
    ]);
  });

  it('lists a Function URL keyed by its own logical ID but pathed to the backing Lambda', () => {
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
    // start-api matches a Function URL by the backing Lambda's cdk path,
    // so displayPath is the Lambda's path while the logical ID is the URL.
    expect(apis).toEqual([
      {
        logicalId: 'HandlerUrl',
        stackName: 'App',
        qualifiedId: 'App:HandlerUrl',
        displayPath: 'App/Handler',
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
      },
    ]);
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
    });
    const listing = listTargets([stack]);
    expect(countTargets(listing)).toBe(3);
  });

  it('returns 0 for an app with no runnable targets', () => {
    const stack = buildStack('App', {
      Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
    });
    const listing = listTargets([stack]);
    expect(countTargets(listing)).toBe(0);
    expect(listing).toEqual({ lambdas: [], apis: [], ecsServices: [], ecsTaskDefinitions: [] });
  });
});
