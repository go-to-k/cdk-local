import { describe, it, expect } from 'vite-plus/test';
import { isFunctionUrlOacFronted } from '../../../src/local/cors-handler.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

/** The canonical CDK 2.x origin DomainName chain pointing at a Function URL. */
function fnUrlDomainName(fnUrlLogicalId: string): unknown {
  return {
    'Fn::Select': [
      2,
      { 'Fn::Split': ['/', { 'Fn::GetAtt': [fnUrlLogicalId, 'FunctionUrl'] }] },
    ],
  };
}

function template(resources: Record<string, unknown>): CloudFormationTemplate {
  return { Resources: resources } as unknown as CloudFormationTemplate;
}

function distribution(origins: unknown[]): Record<string, unknown> {
  return {
    Type: 'AWS::CloudFront::Distribution',
    Properties: { DistributionConfig: { Origins: origins } },
  };
}

function oacResource(signingBehavior?: string): Record<string, unknown> {
  return {
    Type: 'AWS::CloudFront::OriginAccessControl',
    Properties: {
      OriginAccessControlConfig: {
        OriginAccessControlOriginType: 'lambda',
        SigningProtocol: 'sigv4',
        ...(signingBehavior !== undefined && { SigningBehavior: signingBehavior }),
      },
    },
  };
}

describe('isFunctionUrlOacFronted', () => {
  it('returns true for a Function URL fronted by an OAC origin (Fn::GetAtt ref, always)', () => {
    const t = template({
      FnUrl: { Type: 'AWS::Lambda::Url', Properties: { AuthType: 'AWS_IAM' } },
      Dist: distribution([
        {
          DomainName: fnUrlDomainName('FnUrl'),
          OriginAccessControlId: { 'Fn::GetAtt': ['Oac', 'Id'] },
        },
      ]),
      Oac: oacResource('always'),
    });
    expect(isFunctionUrlOacFronted(t, 'FnUrl')).toBe(true);
  });

  it('returns true when OAC is referenced via { Ref }', () => {
    const t = template({
      FnUrl: { Type: 'AWS::Lambda::Url', Properties: { AuthType: 'AWS_IAM' } },
      Dist: distribution([
        { DomainName: fnUrlDomainName('FnUrl'), OriginAccessControlId: { Ref: 'Oac' } },
      ]),
      Oac: oacResource('always'),
    });
    expect(isFunctionUrlOacFronted(t, 'FnUrl')).toBe(true);
  });

  it('returns true for signing behavior no-override', () => {
    const t = template({
      FnUrl: { Type: 'AWS::Lambda::Url', Properties: { AuthType: 'AWS_IAM' } },
      Dist: distribution([
        {
          DomainName: fnUrlDomainName('FnUrl'),
          OriginAccessControlId: { 'Fn::GetAtt': ['Oac', 'Id'] },
        },
      ]),
      Oac: oacResource('no-override'),
    });
    expect(isFunctionUrlOacFronted(t, 'FnUrl')).toBe(true);
  });

  it('returns true when the OAC has no resolvable resource (imported literal id)', () => {
    const t = template({
      FnUrl: { Type: 'AWS::Lambda::Url', Properties: { AuthType: 'AWS_IAM' } },
      Dist: distribution([
        { DomainName: fnUrlDomainName('FnUrl'), OriginAccessControlId: 'E2IMPORTEDLITERAL' },
      ]),
    });
    // Literal-string OAC id resolves to no logical id; presence still counts.
    expect(isFunctionUrlOacFronted(t, 'FnUrl')).toBe(true);
  });

  it('returns false when SigningBehavior is explicitly never (CloudFront does not sign)', () => {
    const t = template({
      FnUrl: { Type: 'AWS::Lambda::Url', Properties: { AuthType: 'AWS_IAM' } },
      Dist: distribution([
        {
          DomainName: fnUrlDomainName('FnUrl'),
          OriginAccessControlId: { 'Fn::GetAtt': ['Oac', 'Id'] },
        },
      ]),
      Oac: oacResource('never'),
    });
    expect(isFunctionUrlOacFronted(t, 'FnUrl')).toBe(false);
  });

  it('returns false when the origin has no OriginAccessControlId', () => {
    const t = template({
      FnUrl: { Type: 'AWS::Lambda::Url', Properties: { AuthType: 'AWS_IAM' } },
      Dist: distribution([{ DomainName: fnUrlDomainName('FnUrl') }]),
    });
    expect(isFunctionUrlOacFronted(t, 'FnUrl')).toBe(false);
  });

  it('returns false when no CloudFront origin points at the Function URL', () => {
    const t = template({
      FnUrl: { Type: 'AWS::Lambda::Url', Properties: { AuthType: 'AWS_IAM' } },
      Dist: distribution([
        {
          DomainName: fnUrlDomainName('OtherFnUrl'),
          OriginAccessControlId: { 'Fn::GetAtt': ['Oac', 'Id'] },
        },
      ]),
      Oac: oacResource('always'),
    });
    expect(isFunctionUrlOacFronted(t, 'FnUrl')).toBe(false);
  });

  it('returns false for a template with no CloudFront distribution', () => {
    const t = template({
      FnUrl: { Type: 'AWS::Lambda::Url', Properties: { AuthType: 'AWS_IAM' } },
    });
    expect(isFunctionUrlOacFronted(t, 'FnUrl')).toBe(false);
  });

  it('matches the correct Function URL among multiple origins', () => {
    const t = template({
      FnUrlA: { Type: 'AWS::Lambda::Url', Properties: { AuthType: 'AWS_IAM' } },
      FnUrlB: { Type: 'AWS::Lambda::Url', Properties: { AuthType: 'AWS_IAM' } },
      Dist: distribution([
        { DomainName: fnUrlDomainName('FnUrlA') },
        {
          DomainName: fnUrlDomainName('FnUrlB'),
          OriginAccessControlId: { 'Fn::GetAtt': ['Oac', 'Id'] },
        },
      ]),
      Oac: oacResource('always'),
    });
    expect(isFunctionUrlOacFronted(t, 'FnUrlA')).toBe(false);
    expect(isFunctionUrlOacFronted(t, 'FnUrlB')).toBe(true);
  });
});
