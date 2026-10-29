import { describe, expect, it } from 'vite-plus/test';
import {
  bucketDeploymentSourceObjectKeys,
  findFileAssetForObjectKey,
  isBucketDeploymentResource,
  resolveBucketDeploymentObjectKey,
} from '../../../src/local/s3-object-asset.js';
import type { AssetManifest } from '../../../src/types/assets.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

describe('findFileAssetForObjectKey', () => {
  const manifest = (objectKey: string): AssetManifest => ({
    version: '52.0.0',
    files: {
      abc123: {
        displayName: 'Code',
        source: { path: 'asset.abc123', packaging: 'zip' },
        destinations: { d: { bucketName: 'b', objectKey } },
      },
    },
    dockerImages: {},
  });

  it('matches the destination objectKey exactly', () => {
    expect(findFileAssetForObjectKey(manifest('abc123.zip'), 'abc123.zip')?.hash).toBe('abc123');
  });

  it('matches a prefixed destination objectKey by its last segment', () => {
    expect(findFileAssetForObjectKey(manifest('pre/abc123.zip'), 'abc123.zip')?.hash).toBe(
      'abc123'
    );
  });

  it('matches a prefixed key only at a segment boundary', () => {
    const other: AssetManifest = {
      version: '52.0.0',
      files: {
        zzz: {
          displayName: 'Other',
          source: { path: 'asset.zzz', packaging: 'zip' },
          destinations: { d: { bucketName: 'b', objectKey: 'xkey.zip' } },
        },
      },
      dockerImages: {},
    };
    expect(findFileAssetForObjectKey(other, 'key.zip')).toBeUndefined();
  });

  it('falls back to the manifest entry keyed by the hash', () => {
    expect(findFileAssetForObjectKey(manifest('other.zip'), 'abc123.zip')?.hash).toBe('abc123');
  });

  it('returns undefined for a key no asset carries', () => {
    expect(findFileAssetForObjectKey(manifest('abc123.zip'), 'zzz.zip')).toBeUndefined();
  });
});


describe('isBucketDeploymentResource / bucketDeploymentSourceObjectKeys', () => {
  it('recognizes the hashed Custom::CDKBucketDeployment type only', () => {
    expect(isBucketDeploymentResource({ Type: 'Custom::CDKBucketDeployment8693BB64' })).toBe(true);
    expect(isBucketDeploymentResource({ Type: 'AWS::CloudFormation::CustomResource' })).toBe(false);
    expect(isBucketDeploymentResource(undefined)).toBe(false);
  });

  it('reads SourceObjectKeys, or [] when it is not a list', () => {
    expect(
      bucketDeploymentSourceObjectKeys({
        Type: 'Custom::CDKBucketDeployment',
        Properties: { SourceObjectKeys: ['a.zip', 'b.zip'] },
      })
    ).toEqual(['a.zip', 'b.zip']);
    expect(bucketDeploymentSourceObjectKeys({ Type: 'Custom::CDKBucketDeployment' })).toEqual([]);
  });
});

describe('resolveBucketDeploymentObjectKey', () => {
  const template = (props: Record<string, unknown>, type = 'Custom::CDKBucketDeploymentABC'): CloudFormationTemplate => ({
    Resources: {
      Upload: {
        Type: type,
        Properties: { SourceObjectKeys: ['one.zip', 'two.zip'], OutputObjectKeys: true, ...props },
      },
      Bucket: { Type: 'AWS::S3::Bucket' },
    },
  });
  const select = (index: unknown, getAtt: unknown = ['Upload', 'SourceObjectKeys']): unknown => ({
    'Fn::Select': [index, { 'Fn::GetAtt': getAtt }],
  });

  it.each([
    ['a numeric index and array GetAtt', select(1)],
    ['a string index', select('1')],
    ['the dotted GetAtt form', select(1, 'Upload.SourceObjectKeys')],
  ])('resolves %s on an extract: false deployment', (_label, value) => {
    expect(resolveBucketDeploymentObjectKey(template({ Extract: false }), value)).toEqual({
      kind: 'resolved',
      deploymentLogicalId: 'Upload',
      index: 1,
      sourceObjectKey: 'two.zip',
    });
  });

  it("treats Extract 'false' (the string the handler receives) like false", () => {
    expect(resolveBucketDeploymentObjectKey(template({ Extract: 'false' }), select(0))).toMatchObject({
      kind: 'resolved',
      sourceObjectKey: 'one.zip',
    });
  });

  it.each([
    ['absent', {}],
    ['true', { Extract: true }],
    ['an intrinsic', { Extract: { 'Fn::If': ['C', true, false] } }],
  ])('reports extracts when Extract is %s', (_label, props) => {
    expect(resolveBucketDeploymentObjectKey(template(props), select(0))).toEqual({
      kind: 'extracts',
      deploymentLogicalId: 'Upload',
      index: 0,
    });
  });

  it('reports the out-of-range, non-literal and no-output-keys cases', () => {
    expect(resolveBucketDeploymentObjectKey(template({ Extract: false }), select(2))).toEqual({
      kind: 'index-out-of-range',
      deploymentLogicalId: 'Upload',
      index: 2,
      sourceCount: 2,
    });
    expect(
      resolveBucketDeploymentObjectKey(
        template({ Extract: false, SourceObjectKeys: [{ Ref: 'K' }] }),
        select(0)
      )
    ).toEqual({ kind: 'source-key-not-literal', deploymentLogicalId: 'Upload', index: 0 });
    expect(
      resolveBucketDeploymentObjectKey(template({ Extract: false, OutputObjectKeys: false }), select(0))
    ).toEqual({ kind: 'object-keys-not-output', deploymentLogicalId: 'Upload', index: 0 });
  });

  it.each([
    ['a literal', 'one.zip'],
    ['another intrinsic', { 'Fn::ImportValue': 'X' }],
    ['a GetAtt of another attribute', select(0, ['Upload', 'DestinationBucketArn'])],
    ['a GetAtt of a resource that is not a BucketDeployment', select(0, ['Bucket', 'SourceObjectKeys'])],
    ['a GetAtt of a missing resource', select(0, ['Nope', 'SourceObjectKeys'])],
    ['a GetAtt of an inherited property name', select(0, ['constructor', 'SourceObjectKeys'])],
    ['a negative index', select(-1)],
    ['a fractional index', select(0.5)],
    ['an intrinsic index', select({ Ref: 'I' })],
    ['a Select with a literal list', { 'Fn::Select': [0, ['one.zip']] }],
  ])('returns undefined for %s', (_label, value) => {
    expect(resolveBucketDeploymentObjectKey(template({ Extract: false }), value)).toBeUndefined();
  });
});
