import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  pickBucketLogicalIdFromOrigin,
  pickFunctionLogicalIdFromArn,
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

describe('intrinsic helpers', () => {
  it('pickFunctionLogicalIdFromArn unwraps Fn::GetAtt', () => {
    expect(pickFunctionLogicalIdFromArn({ 'Fn::GetAtt': ['Fn', 'FunctionARN'] })).toBe('Fn');
    expect(pickFunctionLogicalIdFromArn('literal')).toBeUndefined();
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
