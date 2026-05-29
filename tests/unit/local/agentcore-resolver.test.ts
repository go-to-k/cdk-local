import { describe, expect, it } from 'vite-plus/test';
import {
  AgentCoreResolutionError,
  pickAgentCoreCandidateStack,
  resolveAgentCoreTarget,
} from '../../../src/local/agentcore-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { CloudFormationTemplate, TemplateResource } from '../../../src/types/resource.js';

function buildStack(
  stackName: string,
  resources: Record<string, TemplateResource>,
  region?: string
): StackInfo {
  const template: CloudFormationTemplate = { Resources: resources };
  return {
    stackName,
    displayName: stackName,
    artifactId: stackName,
    template,
    dependencyNames: [],
    ...(region !== undefined && { region }),
  };
}

function withPath(resource: TemplateResource, cdkPath: string): TemplateResource {
  return { ...resource, Metadata: { 'aws:cdk:path': cdkPath } };
}

function containerRuntime(
  overrides: Record<string, unknown> = {},
  containerUri: unknown = '123456789012.dkr.ecr.us-east-1.amazonaws.com/agent:v1'
): TemplateResource {
  return {
    Type: 'AWS::BedrockAgentCore::Runtime',
    Properties: {
      AgentRuntimeName: 'my-agent',
      RoleArn: 'arn:aws:iam::123456789012:role/AgentRole',
      ProtocolConfiguration: 'HTTP',
      AgentRuntimeArtifact: { ContainerConfiguration: { ContainerUri: containerUri } },
      EnvironmentVariables: { MODEL_ID: 'anthropic.claude' },
      ...overrides,
    },
  };
}

describe('resolveAgentCoreTarget — happy path', () => {
  it('resolves a literal container URI, env vars, role, and HTTP protocol', () => {
    const stack = buildStack('App', { ChatAgent: containerRuntime() });
    const resolved = resolveAgentCoreTarget('ChatAgent', [stack]);
    expect(resolved.logicalId).toBe('ChatAgent');
    expect(resolved.stack.stackName).toBe('App');
    expect(resolved.containerUri).toBe('123456789012.dkr.ecr.us-east-1.amazonaws.com/agent:v1');
    expect(resolved.environmentVariables).toEqual({ MODEL_ID: 'anthropic.claude' });
    expect(resolved.roleArn).toBe('arn:aws:iam::123456789012:role/AgentRole');
    expect(resolved.protocol).toBe('HTTP');
  });

  it('treats an absent ProtocolConfiguration as HTTP', () => {
    const stack = buildStack('App', {
      ChatAgent: containerRuntime({ ProtocolConfiguration: undefined }),
    });
    expect(resolveAgentCoreTarget('ChatAgent', [stack]).protocol).toBe('HTTP');
  });

  it('returns {} when EnvironmentVariables is absent and undefined roleArn for an intrinsic RoleArn', () => {
    const stack = buildStack('App', {
      ChatAgent: containerRuntime({
        EnvironmentVariables: undefined,
        RoleArn: { 'Fn::GetAtt': ['AgentRole', 'Arn'] },
      }),
    });
    const resolved = resolveAgentCoreTarget('ChatAgent', [stack]);
    expect(resolved.environmentVariables).toEqual({});
    expect(resolved.roleArn).toBeUndefined();
  });

  it('returns an Fn::Sub container URI verbatim (asset-hash matching happens downstream)', () => {
    const sub = '${AWS::AccountId}.dkr.ecr.${AWS::Region}.${AWS::URLSuffix}/cdk-assets:abcdef0123';
    const stack = buildStack('App', {
      ChatAgent: containerRuntime({}, { 'Fn::Sub': sub }),
    });
    expect(resolveAgentCoreTarget('ChatAgent', [stack]).containerUri).toBe(sub);
  });

  it('resolves an imported-ECR Fn::Join via region-derived pseudo parameters', () => {
    const join = {
      'Fn::Join': ['', ['123456789012.dkr.ecr.us-east-1.', { Ref: 'AWS::URLSuffix' }, '/repo:tag']],
    };
    const stack = buildStack('App', { ChatAgent: containerRuntime({}, join) }, 'us-east-1');
    expect(resolveAgentCoreTarget('ChatAgent', [stack]).containerUri).toBe(
      '123456789012.dkr.ecr.us-east-1.amazonaws.com/repo:tag'
    );
  });

  it('substitutes ${AWS::*} in an Fn::Sub container URI when an imageContext is supplied', () => {
    const sub = '${AWS::AccountId}.dkr.ecr.${AWS::Region}.${AWS::URLSuffix}/agent:tag';
    const stack = buildStack('App', { ChatAgent: containerRuntime({}, { 'Fn::Sub': sub }) });
    const resolved = resolveAgentCoreTarget('ChatAgent', [stack], {
      pseudoParameters: {
        accountId: '123456789012',
        region: 'us-east-1',
        partition: 'aws',
        urlSuffix: 'amazonaws.com',
      },
    });
    expect(resolved.containerUri).toBe('123456789012.dkr.ecr.us-east-1.amazonaws.com/agent:tag');
  });
});

describe('resolveAgentCoreTarget — unresolvable container URI', () => {
  it('throws an actionable error for an unsupported intrinsic container URI', () => {
    const stack = buildStack('App', {
      ChatAgent: containerRuntime({}, { 'Fn::ImportValue': 'SomeExportedUri' }),
    });
    expect(() => resolveAgentCoreTarget('App:ChatAgent', [stack])).toThrow(
      AgentCoreResolutionError
    );
    expect(() => resolveAgentCoreTarget('App:ChatAgent', [stack])).toThrow(/cannot resolve/);
  });
});

describe('resolveAgentCoreTarget — target matching', () => {
  it('matches a CDK display path', () => {
    const stack = buildStack('App', {
      ChatAgent: withPath(containerRuntime(), 'App/ChatAgent/Resource'),
    });
    expect(resolveAgentCoreTarget('App/ChatAgent', [stack]).logicalId).toBe('ChatAgent');
  });

  it('matches the stack:logicalId form', () => {
    const stack = buildStack('App', { ChatAgent: containerRuntime() });
    expect(resolveAgentCoreTarget('App:ChatAgent', [stack]).logicalId).toBe('ChatAgent');
  });

  it('requires a stack prefix in a multi-stack app', () => {
    const a = buildStack('A', { ChatAgent: containerRuntime() });
    const b = buildStack('B', { Other: containerRuntime() });
    expect(() => resolveAgentCoreTarget('ChatAgent', [a, b])).toThrow(AgentCoreResolutionError);
  });

  it('throws a not-found error listing available runtimes', () => {
    const stack = buildStack('App', { ChatAgent: containerRuntime() });
    expect(() => resolveAgentCoreTarget('App:Missing', [stack])).toThrow(/ChatAgent/);
  });

  it('rejects a non-AgentCore resource', () => {
    const stack = buildStack('App', {
      NotAgent: { Type: 'AWS::Lambda::Function', Properties: {} },
    });
    expect(() => resolveAgentCoreTarget('App:NotAgent', [stack])).toThrow(
      /not AWS::BedrockAgentCore::Runtime/
    );
  });
});

describe('resolveAgentCoreTarget — CodeConfiguration (managed runtime)', () => {
  function codeRuntime(code: Record<string, unknown>): TemplateResource {
    return {
      Type: 'AWS::BedrockAgentCore::Runtime',
      Properties: {
        AgentRuntimeName: 'my-agent',
        ProtocolConfiguration: 'HTTP',
        AgentRuntimeArtifact: { CodeConfiguration: code },
      },
    };
  }

  it('extracts runtime, entryPoint, and the fromCodeAsset hash (Prefix <hash>.zip)', () => {
    const stack = buildStack('App', {
      ChatAgent: codeRuntime({
        Code: { S3: { Bucket: { 'Fn::Sub': 'cdk-assets-${AWS::AccountId}' }, Prefix: 'abc123def456.zip' } },
        EntryPoint: ['app.py'],
        Runtime: 'PYTHON_3_13',
      }),
    });
    const resolved = resolveAgentCoreTarget('App:ChatAgent', [stack]);
    expect(resolved.containerUri).toBeUndefined();
    expect(resolved.codeArtifact).toEqual({
      runtime: 'PYTHON_3_13',
      entryPoint: ['app.py'],
      codeAssetHash: 'abc123def456',
    });
  });

  it('strips a key prefix from Code.S3.Prefix when deriving the hash', () => {
    const stack = buildStack('App', {
      ChatAgent: codeRuntime({
        Code: { S3: { Bucket: 'b', Prefix: 'assets/abc123.zip' } },
        EntryPoint: ['opentelemetry-instrument', 'main.py'],
        Runtime: 'PYTHON_3_12',
      }),
    });
    const resolved = resolveAgentCoreTarget('App:ChatAgent', [stack]);
    expect(resolved.codeArtifact?.codeAssetHash).toBe('abc123');
    expect(resolved.codeArtifact?.entryPoint).toEqual(['opentelemetry-instrument', 'main.py']);
  });

  it('throws when Runtime is missing', () => {
    const stack = buildStack('App', {
      ChatAgent: codeRuntime({ Code: { S3: { Bucket: 'b', Prefix: 'h.zip' } }, EntryPoint: ['app.py'] }),
    });
    expect(() => resolveAgentCoreTarget('App:ChatAgent', [stack])).toThrow(/no string Runtime/);
  });

  it('throws when EntryPoint is missing/empty', () => {
    const stack = buildStack('App', {
      ChatAgent: codeRuntime({ Code: { S3: { Bucket: 'b', Prefix: 'h.zip' } }, Runtime: 'PYTHON_3_12' }),
    });
    expect(() => resolveAgentCoreTarget('App:ChatAgent', [stack])).toThrow(/no EntryPoint/);
  });

  it('throws (fromS3 not supported) when Code.S3.Prefix is a non-literal intrinsic', () => {
    const stack = buildStack('App', {
      ChatAgent: codeRuntime({
        Code: { S3: { Bucket: 'b', Prefix: { Ref: 'SomeParam' } } },
        EntryPoint: ['app.py'],
        Runtime: 'PYTHON_3_12',
      }),
    });
    expect(() => resolveAgentCoreTarget('App:ChatAgent', [stack])).toThrow(/not a literal string/);
    expect(() => resolveAgentCoreTarget('App:ChatAgent', [stack])).toThrow(/fromS3/);
  });
});

describe('resolveAgentCoreTarget — out-of-scope artifacts', () => {

  it('rejects the A2A protocol with a not-served-yet error', () => {
    const stack = buildStack('App', {
      ChatAgent: containerRuntime({ ProtocolConfiguration: 'A2A' }),
    });
    expect(() => resolveAgentCoreTarget('App:ChatAgent', [stack])).toThrow(/A2A protocol/);
    expect(() => resolveAgentCoreTarget('App:ChatAgent', [stack])).toThrow(/not served yet/);
  });

  it('rejects the AGUI protocol', () => {
    const stack = buildStack('App', {
      ChatAgent: containerRuntime({ ProtocolConfiguration: 'AGUI' }),
    });
    expect(() => resolveAgentCoreTarget('App:ChatAgent', [stack])).toThrow(/AGUI protocol/);
  });
});

describe('resolveAgentCoreTarget — MCP protocol', () => {
  it('resolves an MCP-protocol runtime', () => {
    const stack = buildStack('App', {
      ChatAgent: containerRuntime({ ProtocolConfiguration: 'MCP' }),
    });
    expect(resolveAgentCoreTarget('App:ChatAgent', [stack]).protocol).toBe('MCP');
  });
});

describe('resolveAgentCoreTarget — JWT authorizer extraction', () => {
  it('extracts discoveryUrl + allowedAudience + allowedClients', () => {
    const stack = buildStack('App', {
      ChatAgent: containerRuntime({
        AuthorizerConfiguration: {
          CustomJWTAuthorizer: {
            DiscoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
            AllowedAudience: ['aud-1', 'aud-2'],
            AllowedClients: ['client-9'],
          },
        },
      }),
    });
    const resolved = resolveAgentCoreTarget('App:ChatAgent', [stack]);
    expect(resolved.jwtAuthorizer).toEqual({
      discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
      allowedAudience: ['aud-1', 'aud-2'],
      allowedClients: ['client-9'],
    });
  });

  it('returns undefined when there is no AuthorizerConfiguration', () => {
    const stack = buildStack('App', { ChatAgent: containerRuntime() });
    expect(resolveAgentCoreTarget('App:ChatAgent', [stack]).jwtAuthorizer).toBeUndefined();
  });

  it('omits the audience/client allowlists when absent (discoveryUrl only)', () => {
    const stack = buildStack('App', {
      ChatAgent: containerRuntime({
        AuthorizerConfiguration: {
          CustomJWTAuthorizer: {
            DiscoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
          },
        },
      }),
    });
    expect(resolveAgentCoreTarget('App:ChatAgent', [stack]).jwtAuthorizer).toEqual({
      discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
    });
  });

  it('skips (undefined) when DiscoveryUrl is an unresolved intrinsic', () => {
    const stack = buildStack('App', {
      ChatAgent: containerRuntime({
        AuthorizerConfiguration: {
          CustomJWTAuthorizer: { DiscoveryUrl: { Ref: 'SomeParam' } },
        },
      }),
    });
    expect(resolveAgentCoreTarget('App:ChatAgent', [stack]).jwtAuthorizer).toBeUndefined();
  });
});

describe('pickAgentCoreCandidateStack', () => {
  it('returns the only stack when no prefix is given (single-stack app)', () => {
    const stack = buildStack('App', { ChatAgent: containerRuntime() });
    expect(pickAgentCoreCandidateStack('ChatAgent', [stack])?.stackName).toBe('App');
  });

  it('returns undefined when the prefix is omitted in a multi-stack app (ambiguous)', () => {
    const a = buildStack('A', { ChatAgent: containerRuntime() });
    const b = buildStack('B', { Other: containerRuntime() });
    expect(pickAgentCoreCandidateStack('ChatAgent', [a, b])).toBeUndefined();
  });

  it('resolves the stack from a stack-qualified target', () => {
    const a = buildStack('A', { ChatAgent: containerRuntime() });
    const b = buildStack('B', { Other: containerRuntime() });
    expect(pickAgentCoreCandidateStack('B:Other', [a, b])?.stackName).toBe('B');
  });

  it('returns undefined when the stack pattern matches nothing', () => {
    const stack = buildStack('App', { ChatAgent: containerRuntime() });
    expect(pickAgentCoreCandidateStack('Missing:ChatAgent', [stack])).toBeUndefined();
  });
});
