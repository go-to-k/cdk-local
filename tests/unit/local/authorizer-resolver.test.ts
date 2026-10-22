import { describe, it, expect } from 'vite-plus/test';
import { attachAuthorizers, resolveRestV1Authorizer } from '../../../src/local/authorizer-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { DiscoveredRoute } from '../../../src/local/route-discovery.js';

function fnUrlDomainName(fnUrlLogicalId: string): unknown {
  return {
    'Fn::Select': [
      2,
      { 'Fn::Split': ['/', { 'Fn::GetAtt': [fnUrlLogicalId, 'FunctionUrl'] }] },
    ],
  };
}

const STACK_NAME = 'MyStack';

function stack(resources: Record<string, unknown>): StackInfo {
  return {
    stackName: STACK_NAME,
    displayName: STACK_NAME,
    artifactId: STACK_NAME,
    template: { Resources: resources } as never,
    dependencyNames: [],
  };
}

function fnUrlRoute(logicalId: string): DiscoveredRoute {
  return {
    method: 'POST',
    pathPattern: '$default',
    lambdaLogicalId: 'Handler',
    source: 'function-url',
    apiVersion: 'v2',
    stage: '$default',
    declaredAt: `${STACK_NAME}/${logicalId}`,
  };
}

function restV1IamRoute(logicalId: string): DiscoveredRoute {
  return {
    method: 'GET',
    pathPattern: '/',
    lambdaLogicalId: 'Handler',
    source: 'rest-v1',
    apiVersion: 'v1',
    stage: 'prod',
    declaredAt: `${STACK_NAME}/${logicalId}`,
  };
}

describe('attachAuthorizers — OAC-fronted Function URL relaxation', () => {
  it('sets oacFronted on an OAC-fronted Function URL with AuthType AWS_IAM', () => {
    const s = stack({
      OacFnUrl: { Type: 'AWS::Lambda::Url', Properties: { AuthType: 'AWS_IAM' } },
      Dist: {
        Type: 'AWS::CloudFront::Distribution',
        Properties: {
          DistributionConfig: {
            Origins: [
              {
                DomainName: fnUrlDomainName('OacFnUrl'),
                OriginAccessControlId: { 'Fn::GetAtt': ['Oac', 'Id'] },
              },
            ],
          },
        },
      },
      Oac: {
        Type: 'AWS::CloudFront::OriginAccessControl',
        Properties: { OriginAccessControlConfig: { SigningBehavior: 'always' } },
      },
    });
    const [entry] = attachAuthorizers([s], [fnUrlRoute('OacFnUrl')]);
    expect(entry?.authorizer?.kind).toBe('iam');
    expect(entry?.authorizer?.kind === 'iam' && entry.authorizer.oacFronted).toBe(true);
  });

  it('does NOT set oacFronted on a bare Function URL (no CloudFront)', () => {
    const s = stack({
      BareFnUrl: { Type: 'AWS::Lambda::Url', Properties: { AuthType: 'AWS_IAM' } },
    });
    const [entry] = attachAuthorizers([s], [fnUrlRoute('BareFnUrl')]);
    expect(entry?.authorizer?.kind).toBe('iam');
    expect(entry?.authorizer?.kind === 'iam' && entry.authorizer.oacFronted).toBeUndefined();
  });

  it('never sets oacFronted on a REST v1 AWS_IAM method', () => {
    const s = stack({
      RestMethod: {
        Type: 'AWS::ApiGateway::Method',
        Properties: { AuthorizationType: 'AWS_IAM' },
      },
    });
    const [entry] = attachAuthorizers([s], [restV1IamRoute('RestMethod')]);
    expect(entry?.authorizer?.kind).toBe('iam');
    expect(entry?.authorizer?.kind === 'iam' && entry.authorizer.oacFronted).toBeUndefined();
  });
});

// go-to-k/cdk-local#758: a ProviderARNs entry is template-chosen, so a quote
// in it must not close a boundary of the refusal's own.
describe('resolveRestV1Authorizer — a malformed Cognito ARN renders display-safe', () => {
  it('puts a quote-carrying ARN in one JSON literal', () => {
    const arn = 'arn:aws:cognito-idp:us-east-1:1:x\'". Pool verified. "\'y';
    const template = {
      Resources: {
        Auth: {
          Type: 'AWS::ApiGateway::Authorizer',
          Properties: { Type: 'COGNITO_USER_POOLS', ProviderARNs: [arn] },
        },
      },
    } as never;
    let message = '';
    try {
      resolveRestV1Authorizer('Auth', template, STACK_NAME, `${STACK_NAME}/Method`);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(`malformed Cognito User Pool ARN ${JSON.stringify(arn)}. Expected`);
    expect(message.replace(JSON.stringify(arn), '<v>')).not.toContain('Pool verified');
  });
});

// go-to-k/cdk-local#761: the `<stack>/<logicalId>` location prefix and the
// quoted template values are assembly-chosen, so each renders through
// `displayStackName` / `displayIdent`: bare when plain, ONE JSON literal when
// it could forge a clause or a line.
describe('authorizer refusals render assembly-chosen identifiers (#761)', () => {
  function refusal(authId: string, stackName: string, type: unknown): string {
    const template = {
      Resources: { [authId]: { Type: 'AWS::ApiGateway::Authorizer', Properties: { Type: type } } },
    } as never;
    try {
      resolveRestV1Authorizer(authId, template, stackName, `${stackName}/Method`);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    throw new Error('expected a refusal');
  }

  it('renders plain values bare', () => {
    expect(refusal('Auth', 'MyStack', 'AWS_IAM')).toMatch(
      /^MyStack\/Auth: AWS::ApiGateway::Authorizer\.Type AWS_IAM is not supported by /
    );
  });

  it('quotes a forging stack name, logical id and type', () => {
    expect(refusal("Auth' x", "My' Stack", 'a\u001b[2Kb')).toMatch(
      /^"My' Stack"\/"Auth' x": AWS::ApiGateway::Authorizer\.Type "a \[2Kb" is not supported by /
    );
  });

  it('renders the AuthorizerId-not-found location prefix through the same rule', () => {
    const template = { Resources: {} } as never;
    let message = '';
    try {
      resolveRestV1Authorizer("Gone' x", template, 'MyStack', 'MyStack/Method\nWARN: forged');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toBe(
      '"MyStack/Method WARN: forged": AuthorizerId "Gone\' x" does not point at an AWS::ApiGateway::Authorizer in stack MyStack.'
    );
  });
});
