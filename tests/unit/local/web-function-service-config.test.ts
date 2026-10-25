import { describe, expect, it } from 'vite-plus/test';
import {
  buildWebFunctionLambdaView,
  finalizeWebFunctionEnv,
  readWebFunctionServiceConfig,
  webFunctionAssumeRole,
  webFunctionFidelityWarnings,
} from '../../../src/local/web-function-service-config.js';
import type { ResolvedWebFunction } from '../../../src/local/web-function-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

const ROLE = 'arn:aws:iam::123456789012:role/WebRole';

function resolved(
  serviceConfig: Record<string, unknown>,
  endpoint?: ResolvedWebFunction['endpoint']
): ResolvedWebFunction {
  return {
    stack: { stackName: 'App' } as StackInfo,
    functionLogicalId: 'WebFn',
    functionName: 'my-web',
    revisionLogicalId: 'RevV2',
    revision: {
      Type: 'AWS::Lambda::WebFunctionRevision',
      Properties: { ServiceConfig: serviceConfig },
      Metadata: { 'aws:cdk:path': 'App/Web/V2' },
    },
    endpoint,
    selection: 'endpoint-weight',
  };
}

const homeEndpoint = (over: Partial<NonNullable<ResolvedWebFunction['endpoint']>> = {}) => ({
  logicalId: 'Ep',
  endpointType: 'HomeRegion',
  authType: 'ApplicationManaged',
  weights: [{ revisionLogicalId: 'RevV2', weight: 100 }],
  ...over,
});

describe('readWebFunctionServiceConfig', () => {
  it('reads env, role, timeout and log group', () => {
    const cfg = readWebFunctionServiceConfig(
      resolved({
        EnvironmentVariables: { GREETING: 'hi', TABLE: { Ref: 'Table' } },
        ExecutionRoleArn: ROLE,
        TimeoutSeconds: 30,
        TelemetryConfig: { LoggingConfig: { LogGroup: '/custom/group' } },
      }).revision
    );
    expect(cfg.environmentVariables).toEqual({ GREETING: 'hi', TABLE: { Ref: 'Table' } });
    expect(cfg.environmentUnreadable).toBe(false);
    expect(cfg.executionRoleArn).toBe(ROLE);
    expect(cfg.timeoutSeconds).toBe(30);
    expect(cfg.logGroup).toBe('/custom/group');
  });

  it('flags a whole-map intrinsic EnvironmentVariables as unreadable', () => {
    const cfg = readWebFunctionServiceConfig(
      resolved({ EnvironmentVariables: { 'Fn::If': ['C', {}, {}] } }).revision
    );
    expect(cfg.environmentUnreadable).toBe(true);
    expect(cfg.environmentVariables).toBeUndefined();
    const ref = readWebFunctionServiceConfig(
      resolved({ EnvironmentVariables: { Ref: 'EnvParam' } }).revision
    );
    expect(ref.environmentUnreadable).toBe(true);
    expect(ref.environmentVariables).toBeUndefined();
    const list = readWebFunctionServiceConfig(resolved({ EnvironmentVariables: ['x'] }).revision);
    expect(list.environmentUnreadable).toBe(true);
    expect(list.environmentVariables).toBeUndefined();
  });

  it('tolerates a revision with no ServiceConfig', () => {
    const cfg = readWebFunctionServiceConfig({ Type: 'AWS::Lambda::WebFunctionRevision' });
    expect(cfg.environmentVariables).toBeUndefined();
    expect(cfg.timeoutSeconds).toBeUndefined();
  });
});

describe('buildWebFunctionLambdaView', () => {
  it('maps ServiceConfig.EnvironmentVariables onto Environment.Variables, keyed by the revision', () => {
    const r = resolved({ EnvironmentVariables: { GREETING: 'hi' }, TimeoutSeconds: 12 });
    const view = buildWebFunctionLambdaView(r, readWebFunctionServiceConfig(r.revision), 'nodejs24.x');
    expect(view.logicalId).toBe('RevV2');
    expect(view.resource.Properties).toEqual({ Environment: { Variables: { GREETING: 'hi' } } });
    expect(view.resource.Metadata).toEqual({ 'aws:cdk:path': 'App/Web/V2' });
    expect(view.timeoutSec).toBe(12);
    expect(view.architecture).toBe('arm64');
    expect(view.codePath).toBeNull();
  });

  it('carries ExecutionRoleArn as the view Role, so a bare --assume-role resolves it from state', () => {
    const getAtt = { 'Fn::GetAtt': ['Role', 'Arn'] };
    const r = resolved({ ExecutionRoleArn: getAtt });
    const view = buildWebFunctionLambdaView(r, readWebFunctionServiceConfig(r.revision), 'x');
    expect(view.resource.Properties).toEqual({ Role: getAtt });
  });

  it('declares no Environment when ServiceConfig has none', () => {
    const r = resolved({});
    const view = buildWebFunctionLambdaView(r, readWebFunctionServiceConfig(r.revision), 'x');
    expect(view.resource.Properties).toEqual({});
  });
});

describe('webFunctionAssumeRole', () => {
  it('resolves a bare --assume-role to a literal ExecutionRoleArn', () => {
    const cfg = readWebFunctionServiceConfig(resolved({ ExecutionRoleArn: ROLE }).revision);
    expect(webFunctionAssumeRole(true, cfg)).toBe(ROLE);
  });

  it('passes the bare form through for an intrinsic role', () => {
    const cfg = readWebFunctionServiceConfig(
      resolved({ ExecutionRoleArn: { 'Fn::GetAtt': ['Role', 'Arn'] } }).revision
    );
    expect(webFunctionAssumeRole(true, cfg)).toBe(true);
  });

  it('leaves an explicit ARN and an absent flag alone', () => {
    const cfg = readWebFunctionServiceConfig(resolved({ ExecutionRoleArn: ROLE }).revision);
    const other = 'arn:aws:iam::123456789012:role/Other';
    expect(webFunctionAssumeRole(other, cfg)).toBe(other);
    expect(webFunctionAssumeRole(undefined, cfg)).toBeUndefined();
  });
});

describe('finalizeWebFunctionEnv', () => {
  const lambdaEnv = {
    AWS_LAMBDA_FUNCTION_NAME: 'RevV2',
    AWS_LAMBDA_FUNCTION_MEMORY_SIZE: '128',
    AWS_LAMBDA_FUNCTION_TIMEOUT: '0',
    AWS_LAMBDA_FUNCTION_VERSION: '$LATEST',
    AWS_LAMBDA_LOG_GROUP_NAME: '/aws/lambda/RevV2',
    AWS_LAMBDA_LOG_STREAM_NAME: 'local',
    AWS_REGION: 'us-east-1',
    GREETING: 'hi',
  };

  it('sets AWS_LAMBDA_HTTP_ENDPOINT and the function name, dropping event-invoke vars', () => {
    const { env, replacedHttpEndpoint } = finalizeWebFunctionEnv(lambdaEnv, {
      functionName: 'my-web',
      containerPort: 8080,
      timeoutSeconds: 30,
      logGroup: undefined,
    });
    expect(env).toEqual({
      AWS_LAMBDA_FUNCTION_NAME: 'my-web',
      AWS_LAMBDA_FUNCTION_TIMEOUT: '30',
      AWS_LAMBDA_LOG_GROUP_NAME: '/aws/lambda/my-web',
      AWS_LAMBDA_LOG_STREAM_NAME: 'local',
      AWS_LAMBDA_HTTP_ENDPOINT: '0.0.0.0:8080',
      AWS_REGION: 'us-east-1',
      GREETING: 'hi',
    });
    expect(replacedHttpEndpoint).toBe(false);
  });

  it('replaces a declared AWS_LAMBDA_HTTP_ENDPOINT and reports it', () => {
    const { env, replacedHttpEndpoint } = finalizeWebFunctionEnv(
      { ...lambdaEnv, AWS_LAMBDA_HTTP_ENDPOINT: '127.0.0.1:9' },
      { functionName: 'f', containerPort: 8080, timeoutSeconds: undefined, logGroup: '/g' }
    );
    expect(env['AWS_LAMBDA_HTTP_ENDPOINT']).toBe('0.0.0.0:8080');
    expect(env['AWS_LAMBDA_LOG_GROUP_NAME']).toBe('/g');
    expect(env['AWS_LAMBDA_FUNCTION_TIMEOUT']).toBeUndefined();
    expect(replacedHttpEndpoint).toBe(true);
  });
});

describe('webFunctionFidelityWarnings', () => {
  const warn = (sc: Record<string, unknown>, ep?: ResolvedWebFunction['endpoint']) => {
    const r = resolved(sc, ep);
    return webFunctionFidelityWarnings(r, readWebFunctionServiceConfig(r.revision));
  };

  it('is silent for a HomeRegion, ApplicationManaged, single-revision endpoint', () => {
    expect(warn({}, homeEndpoint())).toEqual([]);
    expect(warn({})).toEqual([]);
  });

  it('warns that an egress network connector is not emulated', () => {
    expect(warn({ EgressNetworkConnectorArn: 'arn:aws:lambda:x:1:network-connector:n:1' })).toEqual([
      expect.stringMatching(/EgressNetworkConnectorArn; the network connector is not emulated/),
    ]);
  });

  it('warns on a non-HomeRegion endpoint type', () => {
    expect(warn({}, homeEndpoint({ endpointType: 'MultiRegion' }))).toEqual([
      expect.stringMatching(/EndpointType MultiRegion; only a single HomeRegion endpoint/),
    ]);
  });

  it('warns that a non-ApplicationManaged auth type is not enforced', () => {
    expect(warn({}, homeEndpoint({ authType: 'AwsIam' }))).toEqual([
      expect.stringMatching(/AuthType AwsIam; it is not enforced locally/),
    ]);
  });

  it('does not count a weight-0 entry as a split', () => {
    expect(
      warn(
        {},
        homeEndpoint({
          weights: [
            { revisionLogicalId: 'RevV1', weight: 0 },
            { revisionLogicalId: 'RevV2', weight: 100 },
          ],
        })
      )
    ).toEqual([]);
  });

  it('warns that weighted splitting is not emulated, naming the served revision', () => {
    expect(
      warn(
        {},
        homeEndpoint({
          weights: [
            { revisionLogicalId: 'RevV1', weight: 10 },
            { revisionLogicalId: 'RevV2', weight: 90 },
          ],
        })
      )
    ).toEqual([
      expect.stringMatching(/splits traffic across 2 revisions.*every request goes to revision RevV2/),
    ]);
  });

  it('warns that a non-map EnvironmentVariables does not reach the container', () => {
    expect(warn({ EnvironmentVariables: 'x' })).toEqual([
      expect.stringMatching(/none of its variables reach the container/),
    ]);
  });
});
