import { describe, expect, it } from 'vite-plus/test';
import {
  createLocalStartCloudFrontCommand,
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
  });

  it('resolves --no-pull to pull=false (Commander negation)', () => {
    const fresh = createLocalStartCloudFrontCommand();
    fresh.action(() => {});
    const parsed = fresh.parse(['node', 'cdkl', 'My/Dist', '--no-pull'], { from: 'user' });
    expect(parsed.opts().pull).toBe(false);
  });
});
