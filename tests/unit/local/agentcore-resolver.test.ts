import { describe, expect, it } from 'vite-plus/test';
import {
  AgentCoreResolutionError,
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

describe('resolveAgentCoreTarget — out-of-scope artifacts', () => {
  it('rejects a CodeConfiguration (managed-runtime) artifact', () => {
    const stack = buildStack('App', {
      ChatAgent: containerRuntime({
        AgentRuntimeArtifact: {
          CodeConfiguration: {
            Code: { S3: { Bucket: 'b', Prefix: 'p' } },
            EntryPoint: ['app.py'],
            Runtime: 'PYTHON_3_12',
          },
        },
      }),
    });
    expect(() => resolveAgentCoreTarget('App:ChatAgent', [stack])).toThrow(/container artifacts only/);
  });

  it('rejects a non-HTTP protocol', () => {
    const stack = buildStack('App', {
      ChatAgent: containerRuntime({ ProtocolConfiguration: 'MCP' }),
    });
    expect(() => resolveAgentCoreTarget('App:ChatAgent', [stack])).toThrow(/MCP protocol/);
  });
});
