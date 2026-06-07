import { describe, expect, it } from 'vite-plus/test';
import {
  createLocalStartCloudFrontCommand,
  normalizeKvsFileKeys,
  parseKvsFileOverrides,
  parseOriginOverrides,
  resolveCloudFrontTarget,
} from '../../../src/cli/commands/local-start-cloudfront.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

function stack(name: string, template: CloudFormationTemplate): StackInfo {
  return {
    stackName: name,
    displayName: name,
    artifactId: name,
    template,
    dependencyNames: [],
  };
}

const distTemplate: CloudFormationTemplate = {
  Resources: {
    SiteDist: {
      Type: 'AWS::CloudFront::Distribution',
      Properties: {},
      Metadata: { 'aws:cdk:path': 'App/SiteDist/Resource' },
    },
    NotADist: { Type: 'AWS::S3::Bucket', Properties: {} },
  },
};

describe('resolveCloudFrontTarget', () => {
  it('resolves a CDK display path to the distribution logical id', () => {
    const { logicalId } = resolveCloudFrontTarget('App/SiteDist', [stack('App', distTemplate)]);
    expect(logicalId).toBe('SiteDist');
  });

  it('resolves a stack-qualified logical id', () => {
    const { logicalId } = resolveCloudFrontTarget('App:SiteDist', [stack('App', distTemplate)]);
    expect(logicalId).toBe('SiteDist');
  });

  it('throws a helpful error when the target is not a distribution', () => {
    expect(() => resolveCloudFrontTarget('App:NotADist', [stack('App', distTemplate)])).toThrow(
      /did not match a CloudFront distribution/
    );
  });

  it('requires a stack prefix in a multi-stack app', () => {
    expect(() =>
      resolveCloudFrontTarget('SiteDist', [
        stack('App', distTemplate),
        stack('Other', { Resources: {} }),
      ])
    ).toThrow(/has no stack prefix/);
  });
});

describe('parseOriginOverrides', () => {
  it('parses <id>=<dir> pairs', () => {
    const map = parseOriginOverrides(['origin1=./site', 'origin2=/abs/path']);
    expect(map.get('origin1')).toBe('./site');
    expect(map.get('origin2')).toBe('/abs/path');
  });

  it('returns an empty map for undefined', () => {
    expect(parseOriginOverrides(undefined).size).toBe(0);
  });

  it('rejects a malformed value', () => {
    expect(() => parseOriginOverrides(['nope'])).toThrow(/Expected <originId>=<dir>/);
    expect(() => parseOriginOverrides(['=dir'])).toThrow(/Expected <originId>=<dir>/);
  });
});

describe('parseKvsFileOverrides', () => {
  it('parses <kvsLogicalId>=<file> pairs', () => {
    const map = parseKvsFileOverrides(['MyKvs=./kvs.json', 'Other=/abs/x.json']);
    expect(map.get('MyKvs')).toBe('./kvs.json');
    expect(map.get('Other')).toBe('/abs/x.json');
  });

  it('returns an empty map for undefined', () => {
    expect(parseKvsFileOverrides(undefined).size).toBe(0);
  });

  it('rejects a malformed value', () => {
    expect(() => parseKvsFileOverrides(['nope'])).toThrow(/Expected <key>=<file.json>/);
    expect(() => parseKvsFileOverrides(['=x.json'])).toThrow(/Expected <key>=<file.json>/);
  });
});

describe('normalizeKvsFileKeys', () => {
  const kvsTemplate: CloudFormationTemplate = {
    Resources: {
      RoutesKvs8B16D3AA: {
        Type: 'AWS::CloudFront::KeyValueStore',
        Properties: {},
        Metadata: { 'aws:cdk:path': 'App/RoutesKvs/Resource' },
      },
      OtherStoreABC123: {
        Type: 'AWS::CloudFront::KeyValueStore',
        Properties: {},
        Metadata: { 'aws:cdk:path': 'App/Nested/OtherStore/Resource' },
      },
    },
  };

  it('passes a logical-id key through unchanged', () => {
    const out = normalizeKvsFileKeys(new Map([['RoutesKvs8B16D3AA', './kvs.json']]), kvsTemplate);
    expect(out.get('RoutesKvs8B16D3AA')).toBe('./kvs.json');
  });

  it('resolves a construct path to the logical id', () => {
    const out = normalizeKvsFileKeys(new Map([['App/RoutesKvs', './kvs.json']]), kvsTemplate);
    expect(out.get('RoutesKvs8B16D3AA')).toBe('./kvs.json');
    expect(out.has('App/RoutesKvs')).toBe(false);
  });

  it('resolves the full L1 aws:cdk:path (with /Resource) to the logical id', () => {
    const out = normalizeKvsFileKeys(new Map([['App/RoutesKvs/Resource', './kvs.json']]), kvsTemplate);
    expect(out.get('RoutesKvs8B16D3AA')).toBe('./kvs.json');
  });

  it('resolves a bare construct id to the logical id', () => {
    const out = normalizeKvsFileKeys(new Map([['OtherStore', './o.json']]), kvsTemplate);
    expect(out.get('OtherStoreABC123')).toBe('./o.json');
  });

  it('returns the same empty map without scanning', () => {
    const empty = new Map<string, string>();
    expect(normalizeKvsFileKeys(empty, kvsTemplate)).toBe(empty);
  });

  it('throws with candidates when the key matches no store', () => {
    expect(() => normalizeKvsFileKeys(new Map([['Nope', './x.json']]), kvsTemplate)).toThrow(
      /matched no AWS::CloudFront::KeyValueStore.*RoutesKvs8B16D3AA \(App\/RoutesKvs\)/s
    );
  });

  it('throws on an ambiguous bare id shared by two stores', () => {
    const ambiguous: CloudFormationTemplate = {
      Resources: {
        A1: {
          Type: 'AWS::CloudFront::KeyValueStore',
          Properties: {},
          Metadata: { 'aws:cdk:path': 'App/One/Store/Resource' },
        },
        B2: {
          Type: 'AWS::CloudFront::KeyValueStore',
          Properties: {},
          Metadata: { 'aws:cdk:path': 'App/Two/Store/Resource' },
        },
      },
    };
    expect(() => normalizeKvsFileKeys(new Map([['Store', './x.json']]), ambiguous)).toThrow(
      /ambiguous.*A1, B2/s
    );
  });

  it('prefers an exact logical id over a colliding bare id', () => {
    const collide: CloudFormationTemplate = {
      Resources: {
        // A store whose logical id equals another store's bare construct id.
        Store: {
          Type: 'AWS::CloudFront::KeyValueStore',
          Properties: {},
          Metadata: { 'aws:cdk:path': 'App/Primary/Resource' },
        },
        Other: {
          Type: 'AWS::CloudFront::KeyValueStore',
          Properties: {},
          Metadata: { 'aws:cdk:path': 'App/Store/Resource' },
        },
      },
    };
    const out = normalizeKvsFileKeys(new Map([['Store', './x.json']]), collide);
    expect(out.get('Store')).toBe('./x.json');
    expect(out.has('Other')).toBe(false);
  });
});

describe('createLocalStartCloudFrontCommand — option surface', () => {
  const cmd = createLocalStartCloudFrontCommand();
  const longs = cmd.options.map((o) => o.long);

  it('carries the distribution-serving flags + the Lambda-origin --no-pull (issue #376)', () => {
    expect(longs).toContain('--port');
    expect(longs).toContain('--origin');
    expect(longs).toContain('--tls');
    expect(longs).toContain('--watch');
    // --no-pull skips the docker pull for a Lambda Function URL origin's image.
    expect(longs).toContain('--no-pull');
    // --kvs-file backs a CloudFront Function's KeyValueStore reads locally (#399).
    expect(longs).toContain('--kvs-file');
  });

  it('resolves --no-pull to pull=false (Commander negation)', () => {
    const fresh = createLocalStartCloudFrontCommand();
    fresh.action(() => {});
    const parsed = fresh.parse(['node', 'cdkl', 'My/Dist', '--no-pull'], { from: 'user' });
    expect(parsed.opts().pull).toBe(false);
  });
});
