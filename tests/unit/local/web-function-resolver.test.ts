import { describe, expect, it } from 'vite-plus/test';
import {
  resolveWebFunctionTarget,
  WebFunctionResolutionError,
} from '../../../src/local/web-function-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { TemplateResource } from '../../../src/types/resource.js';

function stack(name: string, resources: Record<string, TemplateResource>): StackInfo {
  return {
    stackName: name,
    displayName: name,
    artifactId: name,
    template: { Resources: resources },
    dependencyNames: [],
  } as StackInfo;
}

const fn = (name = 'my-web'): TemplateResource => ({
  Type: 'AWS::Lambda::WebFunction',
  Properties: { FunctionName: name },
  Metadata: { 'aws:cdk:path': 'App/Web/Function' },
});
const rev = (fnRef: unknown, path: string): TemplateResource => ({
  Type: 'AWS::Lambda::WebFunctionRevision',
  Properties: { FunctionName: fnRef, BuildConfig: {}, ServiceConfig: {} },
  Metadata: { 'aws:cdk:path': path },
});
const endpoint = (
  fnRef: unknown,
  weights: { rev: string; weight: number }[],
  extra: Record<string, unknown> = {}
): TemplateResource => ({
  Type: 'AWS::Lambda::WebFunctionEndpoint',
  Properties: {
    FunctionName: fnRef,
    EndpointName: 'main',
    EndpointType: 'HomeRegion',
    AuthType: 'ApplicationManaged',
    RevisionWeights: weights.map((w) => ({
      RevisionId: { 'Fn::GetAtt': [w.rev, 'RevisionId'] },
      Weight: w.weight,
    })),
    ...extra,
  },
  Metadata: { 'aws:cdk:path': 'App/Web/Endpoint' },
});

/** Function + two revisions (V1 low weight, V2 high) + one endpoint. */
function twoRevisionApp(): StackInfo {
  return stack('App', {
    WebFn: fn(),
    RevV1: rev({ Ref: 'WebFn' }, 'App/Web/V1'),
    RevV2: rev({ Ref: 'WebFn' }, 'App/Web/V2'),
    Ep: endpoint({ Ref: 'WebFn' }, [
      { rev: 'RevV1', weight: 10 },
      { rev: 'RevV2', weight: 90 },
    ]),
  });
}

describe('resolveWebFunctionTarget — revision selection', () => {
  it('serves the highest-weight revision of an endpoint target', () => {
    const r = resolveWebFunctionTarget('App:Ep', [twoRevisionApp()]);
    expect(r.revisionLogicalId).toBe('RevV2');
    expect(r.selection).toBe('endpoint-weight');
    expect(r.functionLogicalId).toBe('WebFn');
    expect(r.functionName).toBe('my-web');
    expect(r.endpoint?.logicalId).toBe('Ep');
  });

  it('picks the FIRST listed revision on a weight tie', () => {
    const s = stack('App', {
      WebFn: fn(),
      A: rev({ Ref: 'WebFn' }, 'App/Web/A'),
      B: rev({ Ref: 'WebFn' }, 'App/Web/B'),
      Ep: endpoint({ Ref: 'WebFn' }, [
        { rev: 'B', weight: 50 },
        { rev: 'A', weight: 50 },
      ]),
    });
    expect(resolveWebFunctionTarget('App:Ep', [s]).revisionLogicalId).toBe('B');
  });

  it('lets --revision override the endpoint weights', () => {
    const r = resolveWebFunctionTarget('App:Ep', [twoRevisionApp()], 'RevV1');
    expect(r.revisionLogicalId).toBe('RevV1');
    expect(r.selection).toBe('revision-flag');
    expect(r.endpoint?.logicalId).toBe('Ep');
  });

  it('refuses a --revision that is not a revision of this stack', () => {
    expect(() => resolveWebFunctionTarget('App:Ep', [twoRevisionApp()], 'Nope')).toThrow(
      /--revision Nope is not an AWS::Lambda::WebFunctionRevision.*Revisions: RevV1, RevV2/
    );
  });

  it('refuses a --revision belonging to another web function', () => {
    const s = stack('App', {
      WebFn: fn('a'),
      Other: fn('b'),
      RevA: rev({ Ref: 'WebFn' }, 'App/A'),
      RevB: rev({ Ref: 'Other' }, 'App/B'),
    });
    expect(() => resolveWebFunctionTarget('App:WebFn', [s], 'RevB')).toThrow(
      /belongs to a different web function/
    );
  });

  it("serves a function's only revision", () => {
    const s = stack('App', { WebFn: fn(), Rev: rev({ Ref: 'WebFn' }, 'App/Web/Rev') });
    const r = resolveWebFunctionTarget('App:WebFn', [s]);
    expect(r.revisionLogicalId).toBe('Rev');
    expect(r.selection).toBe('only-revision');
    expect(r.endpoint).toBeUndefined();
  });

  it("lets a multi-revision function's single endpoint decide", () => {
    const r = resolveWebFunctionTarget('App:WebFn', [twoRevisionApp()]);
    expect(r.revisionLogicalId).toBe('RevV2');
    expect(r.selection).toBe('endpoint-weight');
  });

  it('fails listing the revisions when no single endpoint disambiguates', () => {
    const s = stack('App', {
      WebFn: fn(),
      RevV1: rev({ Ref: 'WebFn' }, 'App/Web/V1'),
      RevV2: rev({ Ref: 'WebFn' }, 'App/Web/V2'),
    });
    expect(() => resolveWebFunctionTarget('App:WebFn', [s])).toThrow(WebFunctionResolutionError);
    expect(() => resolveWebFunctionTarget('App:WebFn', [s])).toThrow(
      /has 2 revisions.*--revision <logicalId>.*Revisions: RevV1, RevV2/
    );
  });

  it('serves a revision target directly and attaches the endpoint routing to it', () => {
    const r = resolveWebFunctionTarget('App:RevV1', [twoRevisionApp()]);
    expect(r.revisionLogicalId).toBe('RevV1');
    expect(r.selection).toBe('target-revision');
    expect(r.endpoint?.logicalId).toBe('Ep');
  });

  it('links a revision by a literal FunctionName equal to the function name', () => {
    const s = stack('App', { WebFn: fn('literal-name'), Rev: rev('literal-name', 'App/Rev') });
    const r = resolveWebFunctionTarget('App:WebFn', [s]);
    expect(r.revisionLogicalId).toBe('Rev');
    expect(r.functionName).toBe('literal-name');
  });

  it('fails when the function has no revision in the template', () => {
    expect(() => resolveWebFunctionTarget('App:WebFn', [stack('App', { WebFn: fn() })])).toThrow(
      /resolves to no AWS::Lambda::WebFunctionRevision/
    );
  });
});

describe('resolveWebFunctionTarget — target forms', () => {
  it('accepts a bare logical id in a single-stack app', () => {
    expect(resolveWebFunctionTarget('Ep', [twoRevisionApp()]).revisionLogicalId).toBe('RevV2');
  });

  it('prefers the endpoint when a construct path covers the whole web function', () => {
    const r = resolveWebFunctionTarget('App/Web', [twoRevisionApp()]);
    expect(r.endpoint?.logicalId).toBe('Ep');
    expect(r.revisionLogicalId).toBe('RevV2');
  });

  it('resolves a path naming one revision', () => {
    expect(resolveWebFunctionTarget('App/Web/V1', [twoRevisionApp()]).revisionLogicalId).toBe(
      'RevV1'
    );
  });

  it('requires a stack prefix in a multi-stack app', () => {
    expect(() =>
      resolveWebFunctionTarget('Ep', [twoRevisionApp(), stack('Other', {})])
    ).toThrow(/missing a stack prefix/);
  });

  it('picks the right stack in a multi-stack app', () => {
    const r = resolveWebFunctionTarget('App:Ep', [stack('Other', {}), twoRevisionApp()]);
    expect(r.stack.stackName).toBe('App');
  });

  it('refuses a resource that is not a web function', () => {
    const s = stack('App', { Bucket: { Type: 'AWS::S3::Bucket' } });
    expect(() => resolveWebFunctionTarget('App:Bucket', [s])).toThrow(
      /is AWS::S3::Bucket, not a Lambda web function/
    );
  });

  it('names the available web function resources on a miss', () => {
    expect(() => resolveWebFunctionTarget('App:Missing', [twoRevisionApp()])).toThrow(
      /not found\. Web function resources in App: Ep, WebFn, RevV1, RevV2/
    );
  });
});

describe('resolveWebFunctionTarget — edge cases', () => {
  it('prefers an endpoint over the function a path also covers (the order is load-bearing)', () => {
    // Function-first would see two endpoints and fail; endpoint-first serves EpA's pick.
    const s = stack('App', {
      WebFn: { ...fn(), Metadata: { 'aws:cdk:path': 'App/Web/Function' } },
      RevV1: rev({ Ref: 'WebFn' }, 'App/Other/V1'),
      RevV2: rev({ Ref: 'WebFn' }, 'App/Other/V2'),
      EpA: {
        ...endpoint({ Ref: 'WebFn' }, [{ rev: 'RevV1', weight: 100 }]),
        Metadata: { 'aws:cdk:path': 'App/Web/EpA' },
      },
      EpB: {
        ...endpoint({ Ref: 'WebFn' }, [{ rev: 'RevV2', weight: 100 }]),
        Metadata: { 'aws:cdk:path': 'App/Elsewhere/EpB' },
      },
    });
    expect(resolveWebFunctionTarget('App/Web', [s]).revisionLogicalId).toBe('RevV1');
    expect(() => resolveWebFunctionTarget('App:WebFn', [s])).toThrow(/has 2 revisions/);
  });

  it('refuses a path that matches two resources of the same kind', () => {
    const s = twoRevisionApp();
    expect(() => resolveWebFunctionTarget('App/Web', [{
      ...s,
      template: {
        Resources: {
          ...s.template.Resources,
          Ep2: { ...endpoint({ Ref: 'WebFn' }, []), Metadata: { 'aws:cdk:path': 'App/Web/Endpoint2' } },
        },
      },
    } as StackInfo])).toThrow(/matches 2 AWS::Lambda::WebFunctionEndpoint resources: Ep, Ep2/);
  });

  it('ignores weights whose RevisionId names no revision in this template', () => {
    const s = stack('App', {
      WebFn: fn(),
      Rev: rev({ Ref: 'WebFn' }, 'App/Web/Rev'),
      Ep: {
        Type: 'AWS::Lambda::WebFunctionEndpoint',
        Properties: {
          FunctionName: { Ref: 'WebFn' },
          RevisionWeights: [{ RevisionId: 'deployed-revision-id', Weight: 100 }],
        },
      },
    });
    const r = resolveWebFunctionTarget('App:Ep', [s]);
    expect(r.revisionLogicalId).toBe('Rev');
    expect(r.selection).toBe('only-revision');
    expect(r.endpoint?.weights).toEqual([{ revisionLogicalId: undefined, weight: 100 }]);
  });
});
