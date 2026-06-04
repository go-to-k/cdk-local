import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  pickBucketLogicalIdFromOrigin,
  pickFunctionLogicalIdFromArn,
  pickFunctionUrlLogicalIdFromOrigin,
  pickTargetFunctionLogicalId,
  resolveCloudFrontDistribution,
} from '../../../src/local/cloudfront-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

let outDir: string;

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), 'cdkl-cf-resolver-'));
});
afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

/** Build a StackInfo backed by an on-disk asset manifest + staged asset dir. */
function buildStack(template: CloudFormationTemplate, assetHash?: string): StackInfo {
  const assetManifestPath = join(outDir, 'Stack.assets.json');
  const files: Record<string, unknown> = {};
  if (assetHash) {
    const assetPath = `asset.${assetHash}`;
    mkdirSync(join(outDir, assetPath), { recursive: true });
    writeFileSync(join(outDir, assetPath, 'index.html'), '<h1>root</h1>');
    files[assetHash] = {
      displayName: 'Site',
      source: { path: assetPath, packaging: 'zip' },
      destinations: { current: { bucketName: 'b', objectKey: `${assetHash}.zip` } },
    };
  }
  writeFileSync(assetManifestPath, JSON.stringify({ version: '1', files, dockerImages: {} }));
  return {
    stackName: 'Stack',
    displayName: 'Stack',
    artifactId: 'Stack',
    template,
    assetManifestPath,
    dependencyNames: [],
  };
}

const HASH = 'a'.repeat(64);

function s3DistributionTemplate(): CloudFormationTemplate {
  return {
    Resources: {
      SiteBucket: { Type: 'AWS::S3::Bucket', Properties: {} },
      RewriteFn: {
        Type: 'AWS::CloudFront::Function',
        Properties: {
          FunctionCode:
            "function handler(event){var r=event.request; if(r.uri.endsWith('/')) r.uri+='index.html'; return r;}",
          FunctionConfig: { Runtime: 'cloudfront-js-2.0', Comment: 'c' },
        },
      },
      Deploy: {
        Type: 'Custom::CDKBucketDeployment',
        Properties: {
          DestinationBucketName: { Ref: 'SiteBucket' },
          SourceObjectKeys: [`${HASH}.zip`],
        },
      },
      Dist: {
        Type: 'AWS::CloudFront::Distribution',
        Properties: {
          DistributionConfig: {
            DefaultRootObject: 'index.html',
            Origins: [
              {
                Id: 'origin1',
                DomainName: { 'Fn::GetAtt': ['SiteBucket', 'RegionalDomainName'] },
                S3OriginConfig: { OriginAccessIdentity: '' },
              },
            ],
            DefaultCacheBehavior: {
              TargetOriginId: 'origin1',
              ViewerProtocolPolicy: 'redirect-to-https',
              FunctionAssociations: [
                { EventType: 'viewer-request', FunctionARN: { 'Fn::GetAtt': ['RewriteFn', 'FunctionARN'] } },
              ],
            },
            CustomErrorResponses: [{ ErrorCode: 403, ResponseCode: 200, ResponsePagePath: '/index.html' }],
          },
        },
      },
    },
  };
}

describe('resolveCloudFrontDistribution — S3 origin happy path', () => {
  it('resolves behaviors, the viewer-request function, the S3 origin dir, and custom errors', () => {
    const stack = buildStack(s3DistributionTemplate(), HASH);
    const resolved = resolveCloudFrontDistribution({ stack, logicalId: 'Dist' });

    expect(resolved.defaultRootObject).toBe('index.html');
    expect(resolved.behaviors).toHaveLength(1);
    const def = resolved.behaviors[0]!;
    expect(def.pathPattern).toBeUndefined();
    expect(def.targetOriginId).toBe('origin1');
    expect(def.viewerProtocolPolicy).toBe('redirect-to-https');
    expect(def.viewerRequest?.logicalId).toBe('RewriteFn');
    expect(def.viewerResponse).toBeUndefined();
    expect(def.hasLambdaEdge).toBe(false);

    const origin = resolved.origins.get('origin1');
    expect(origin?.kind).toBe('s3');
    if (origin?.kind === 's3') {
      expect(origin.localDirs).toHaveLength(1);
      expect(origin.localDirs[0]).toContain(`asset.${HASH}`);
    }

    expect(resolved.customErrorResponses).toEqual([
      { errorCode: 403, responseCode: 200, responsePagePath: '/index.html' },
    ]);
  });
});

describe('resolveCloudFrontDistribution — unresolved + custom origins', () => {
  it('marks an S3 origin with no BucketDeployment as s3-unresolved', () => {
    const template = s3DistributionTemplate();
    delete (template.Resources as Record<string, unknown>)['Deploy'];
    const stack = buildStack(template, HASH);
    const resolved = resolveCloudFrontDistribution({ stack, logicalId: 'Dist' });
    const origin = resolved.origins.get('origin1');
    expect(origin?.kind).toBe('s3-unresolved');
  });

  it('honors an --origin override even when resolution would succeed', () => {
    const stack = buildStack(s3DistributionTemplate(), HASH);
    const overrideDir = mkdtempSync(join(tmpdir(), 'cdkl-cf-override-'));
    try {
      const resolved = resolveCloudFrontDistribution({
        stack,
        logicalId: 'Dist',
        originOverrides: new Map([['origin1', overrideDir]]),
      });
      const origin = resolved.origins.get('origin1');
      expect(origin?.kind).toBe('s3');
      if (origin?.kind === 's3') expect(origin.localDirs[0]).toBe(overrideDir);
    } finally {
      rmSync(overrideDir, { recursive: true, force: true });
    }
  });

  it('classifies a non-S3 origin as custom', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Dist: {
          Type: 'AWS::CloudFront::Distribution',
          Properties: {
            DistributionConfig: {
              Origins: [
                {
                  Id: 'api',
                  DomainName: 'api.example.com',
                  CustomOriginConfig: { OriginProtocolPolicy: 'https-only' },
                },
              ],
              DefaultCacheBehavior: { TargetOriginId: 'api' },
            },
          },
        },
      },
    };
    const stack = buildStack(template);
    const resolved = resolveCloudFrontDistribution({ stack, logicalId: 'Dist' });
    const origin = resolved.origins.get('api');
    expect(origin?.kind).toBe('custom');
    if (origin?.kind === 'custom') expect(origin.domainName).toBe('api.example.com');
  });

  it('records a Lambda@Edge association as hasLambdaEdge', () => {
    const template = s3DistributionTemplate();
    const dc = (template.Resources!['Dist']!.Properties as Record<string, Record<string, unknown>>)[
      'DistributionConfig'
    ]!;
    (dc['DefaultCacheBehavior'] as Record<string, unknown>)['LambdaFunctionAssociations'] = [
      { EventType: 'origin-request', LambdaFunctionArn: 'arn:aws:lambda:...' },
    ];
    const stack = buildStack(template, HASH);
    const resolved = resolveCloudFrontDistribution({ stack, logicalId: 'Dist' });
    expect(resolved.behaviors[0]!.hasLambdaEdge).toBe(true);
  });

  it('resolves CacheBehaviors[] in declared order after the default', () => {
    const template = s3DistributionTemplate();
    const dc = (template.Resources!['Dist']!.Properties as Record<string, Record<string, unknown>>)[
      'DistributionConfig'
    ]!;
    dc['CacheBehaviors'] = [{ PathPattern: '/api/*', TargetOriginId: 'origin1' }];
    const stack = buildStack(template, HASH);
    const resolved = resolveCloudFrontDistribution({ stack, logicalId: 'Dist' });
    expect(resolved.behaviors.map((b) => b.pathPattern)).toEqual([undefined, '/api/*']);
  });

  it('skips a CacheBehaviors[] entry with a non-literal PathPattern (no silent catch-all)', () => {
    const template = s3DistributionTemplate();
    const dc = (template.Resources!['Dist']!.Properties as Record<string, Record<string, unknown>>)[
      'DistributionConfig'
    ]!;
    // An intrinsic / missing PathPattern would default to '*' and shadow the
    // default behavior; it must be skipped instead.
    dc['CacheBehaviors'] = [{ PathPattern: { Ref: 'Something' }, TargetOriginId: 'origin1' }];
    const stack = buildStack(template, HASH);
    const resolved = resolveCloudFrontDistribution({ stack, logicalId: 'Dist' });
    expect(resolved.behaviors.map((b) => b.pathPattern)).toEqual([undefined]);
  });

  it('throws on a distribution with no DistributionConfig', () => {
    const template: CloudFormationTemplate = {
      Resources: { Dist: { Type: 'AWS::CloudFront::Distribution', Properties: {} } },
    };
    const stack = buildStack(template);
    expect(() => resolveCloudFrontDistribution({ stack, logicalId: 'Dist' })).toThrow(
      /has no DistributionConfig/
    );
  });
});

/** A distribution whose default origin is a Lambda Function URL origin. */
function functionUrlDistributionTemplate(
  targetFunctionArn: unknown = { Ref: 'Handler' }
): CloudFormationTemplate {
  return {
    Resources: {
      Handler: {
        Type: 'AWS::Lambda::Function',
        Properties: { Runtime: 'nodejs20.x', Handler: 'index.handler', Code: { ZipFile: 'x' } },
      },
      HandlerUrl: {
        Type: 'AWS::Lambda::Url',
        Properties: { TargetFunctionArn: targetFunctionArn, AuthType: 'NONE' },
      },
      Dist: {
        Type: 'AWS::CloudFront::Distribution',
        Properties: {
          DistributionConfig: {
            Origins: [
              {
                Id: 'lambda',
                // origins.FunctionUrlOrigin: strip scheme + trailing slash off
                // {Fn::GetAtt: [HandlerUrl, 'FunctionUrl']}.
                DomainName: {
                  'Fn::Select': [
                    2,
                    { 'Fn::Split': ['/', { 'Fn::GetAtt': ['HandlerUrl', 'FunctionUrl'] }] },
                  ],
                },
                CustomOriginConfig: { OriginProtocolPolicy: 'https-only' },
              },
            ],
            DefaultCacheBehavior: { TargetOriginId: 'lambda' },
          },
        },
      },
    },
  };
}

describe('resolveCloudFrontDistribution — Lambda Function URL origin', () => {
  it('resolves a FunctionUrlOrigin to lambda-url (Ref TargetFunctionArn)', () => {
    const stack = buildStack(functionUrlDistributionTemplate({ Ref: 'Handler' }));
    const resolved = resolveCloudFrontDistribution({ stack, logicalId: 'Dist' });
    const origin = resolved.origins.get('lambda');
    expect(origin?.kind).toBe('lambda-url');
    if (origin?.kind === 'lambda-url') {
      expect(origin.functionLogicalId).toBe('Handler');
      expect(origin.functionUrlLogicalId).toBe('HandlerUrl');
    }
  });

  it('resolves a FunctionUrlOrigin to lambda-url (Fn::GetAtt Arn TargetFunctionArn)', () => {
    const stack = buildStack(
      functionUrlDistributionTemplate({ 'Fn::GetAtt': ['Handler', 'Arn'] })
    );
    const resolved = resolveCloudFrontDistribution({ stack, logicalId: 'Dist' });
    const origin = resolved.origins.get('lambda');
    expect(origin?.kind).toBe('lambda-url');
    if (origin?.kind === 'lambda-url') expect(origin.functionLogicalId).toBe('Handler');
  });

  it('falls back to custom when the AWS::Lambda::Url resource is absent', () => {
    const template = functionUrlDistributionTemplate();
    delete (template.Resources as Record<string, unknown>)['HandlerUrl'];
    const stack = buildStack(template);
    const resolved = resolveCloudFrontDistribution({ stack, logicalId: 'Dist' });
    expect(resolved.origins.get('lambda')?.kind).toBe('custom');
  });

  it('falls back to custom when TargetFunctionArn does not resolve to a Lambda function', () => {
    const template = functionUrlDistributionTemplate({ Ref: 'Handler' });
    // Make the referenced resource a non-Lambda.
    (template.Resources as Record<string, { Type: string }>)['Handler']!.Type = 'AWS::SNS::Topic';
    const stack = buildStack(template);
    const resolved = resolveCloudFrontDistribution({ stack, logicalId: 'Dist' });
    expect(resolved.origins.get('lambda')?.kind).toBe('custom');
  });
});

describe('resolveCloudFrontDistribution — ResponseHeadersPolicy CORS', () => {
  /** S3 template whose behavior(s) reference an RHP carrying a CORS block. */
  function corsTemplate(opts?: {
    perPathPolicy?: boolean;
    managedPolicyLiteral?: boolean;
  }): CloudFormationTemplate {
    const template = s3DistributionTemplate();
    const resources = template.Resources as Record<string, unknown>;
    resources['Rhp'] = {
      Type: 'AWS::CloudFront::ResponseHeadersPolicy',
      Properties: {
        ResponseHeadersPolicyConfig: {
          CorsConfig: {
            AccessControlAllowCredentials: false,
            AccessControlAllowHeaders: { Items: ['*', 'Authorization'] },
            AccessControlAllowMethods: { Items: ['POST'] },
            AccessControlAllowOrigins: { Items: ['http://127.0.0.1:5050'] },
            OriginOverride: true,
          },
        },
      },
    };
    const dc = (resources['Dist'] as { Properties: { DistributionConfig: Record<string, unknown> } })
      .Properties.DistributionConfig;
    const policyValue = opts?.managedPolicyLiteral
      ? '60669652-455b-4ae9-85a4-c4c02393f86c'
      : { Ref: 'Rhp' };
    if (opts?.perPathPolicy) {
      dc['CacheBehaviors'] = [
        { PathPattern: '/api/*', TargetOriginId: 'origin1', ResponseHeadersPolicyId: policyValue },
      ];
    } else {
      (dc['DefaultCacheBehavior'] as Record<string, unknown>)['ResponseHeadersPolicyId'] =
        policyValue;
    }
    return template;
  }

  it('resolves the default behavior CORS from its ResponseHeadersPolicy', () => {
    const stack = buildStack(corsTemplate(), HASH);
    const resolved = resolveCloudFrontDistribution({ stack, logicalId: 'Dist' });
    const cors = resolved.behaviors[0]!.cors;
    expect(cors).toBeDefined();
    expect(cors!.AllowOrigins).toEqual(['http://127.0.0.1:5050']);
    expect(cors!.AllowMethods).toEqual(['POST']);
    expect(cors!.AllowHeaders).toEqual(['*', 'Authorization']);
    expect(cors!.AllowCredentials).toBe(false);
  });

  it('resolves CORS per CacheBehaviors[] entry (path-specific policy)', () => {
    const stack = buildStack(corsTemplate({ perPathPolicy: true }), HASH);
    const resolved = resolveCloudFrontDistribution({ stack, logicalId: 'Dist' });
    expect(resolved.behaviors[0]!.cors).toBeUndefined(); // default behavior: no policy
    const apiBehavior = resolved.behaviors.find((b) => b.pathPattern === '/api/*');
    expect(apiBehavior?.cors?.AllowOrigins).toEqual(['http://127.0.0.1:5050']);
  });

  it('leaves cors undefined for an AWS-managed policy id literal (not fetchable)', () => {
    const stack = buildStack(corsTemplate({ managedPolicyLiteral: true }), HASH);
    const resolved = resolveCloudFrontDistribution({ stack, logicalId: 'Dist' });
    expect(resolved.behaviors[0]!.cors).toBeUndefined();
  });

  it('leaves cors undefined when the behavior has no ResponseHeadersPolicy', () => {
    const stack = buildStack(s3DistributionTemplate(), HASH);
    const resolved = resolveCloudFrontDistribution({ stack, logicalId: 'Dist' });
    expect(resolved.behaviors[0]!.cors).toBeUndefined();
  });
});

describe('intrinsic helpers', () => {
  it('pickFunctionLogicalIdFromArn unwraps Fn::GetAtt', () => {
    expect(pickFunctionLogicalIdFromArn({ 'Fn::GetAtt': ['Fn', 'FunctionARN'] })).toBe('Fn');
    expect(pickFunctionLogicalIdFromArn('literal')).toBeUndefined();
  });

  it('pickFunctionUrlLogicalIdFromOrigin unwraps the FunctionUrlOrigin domain shape', () => {
    const domain = {
      'Fn::Select': [2, { 'Fn::Split': ['/', { 'Fn::GetAtt': ['U', 'FunctionUrl'] }] }],
    };
    expect(pickFunctionUrlLogicalIdFromOrigin(domain)).toBe('U');
    // Wrong select index (not 2).
    expect(
      pickFunctionUrlLogicalIdFromOrigin({
        'Fn::Select': [1, { 'Fn::Split': ['/', { 'Fn::GetAtt': ['U', 'FunctionUrl'] }] }],
      })
    ).toBeUndefined();
    // Wrong attribute (a RegionalDomainName S3 origin must not match).
    expect(
      pickFunctionUrlLogicalIdFromOrigin({
        'Fn::Select': [2, { 'Fn::Split': ['/', { 'Fn::GetAtt': ['U', 'DomainName'] }] }],
      })
    ).toBeUndefined();
    expect(pickFunctionUrlLogicalIdFromOrigin('literal.example.com')).toBeUndefined();
  });

  it('pickTargetFunctionLogicalId unwraps Ref and Fn::GetAtt Arn', () => {
    expect(pickTargetFunctionLogicalId({ Ref: 'Handler' })).toBe('Handler');
    expect(pickTargetFunctionLogicalId({ 'Fn::GetAtt': ['Handler', 'Arn'] })).toBe('Handler');
    expect(pickTargetFunctionLogicalId('arn:literal')).toBeUndefined();
  });

  it('pickBucketLogicalIdFromOrigin only resolves to an S3 bucket', () => {
    const template: CloudFormationTemplate = {
      Resources: { B: { Type: 'AWS::S3::Bucket', Properties: {} } },
    };
    expect(
      pickBucketLogicalIdFromOrigin({ DomainName: { 'Fn::GetAtt': ['B', 'RegionalDomainName'] } }, template)
    ).toBe('B');
    expect(
      pickBucketLogicalIdFromOrigin({ DomainName: { 'Fn::GetAtt': ['X', 'RegionalDomainName'] } }, template)
    ).toBeUndefined();
  });
});
