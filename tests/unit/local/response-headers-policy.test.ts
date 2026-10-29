import { describe, expect, it } from 'vite-plus/test';
import {
  applyResponseHeadersPolicyHeaders,
  resolveResponseHeadersPolicyHeaders,
  type HeaderWritable,
} from '../../../src/local/response-headers-policy.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

function template(config: Record<string, unknown>): CloudFormationTemplate {
  return {
    Resources: {
      Rhp: {
        Type: 'AWS::CloudFront::ResponseHeadersPolicy',
        Properties: { ResponseHeadersPolicyConfig: { Name: 'p', ...config } },
      },
    },
  } as CloudFormationTemplate;
}

describe('resolveResponseHeadersPolicyHeaders', () => {
  it('renders every security header as CloudFront sends it', () => {
    const policy = resolveResponseHeadersPolicyHeaders(
      template({
        SecurityHeadersConfig: {
          StrictTransportSecurity: {
            AccessControlMaxAgeSec: 63072000,
            IncludeSubdomains: true,
            Preload: true,
            Override: true,
          },
          ContentSecurityPolicy: { ContentSecurityPolicy: "frame-ancestors 'none'", Override: true },
          ContentTypeOptions: { Override: true },
          FrameOptions: { FrameOption: 'DENY', Override: false },
          ReferrerPolicy: { ReferrerPolicy: 'strict-origin-when-cross-origin', Override: true },
          XSSProtection: { Protection: true, ModeBlock: true, Override: true },
        },
      }),
      { Ref: 'Rhp' }
    );
    expect(policy).toEqual({
      remove: [],
      set: [
        {
          name: 'strict-transport-security',
          value: 'max-age=63072000; includeSubDomains; preload',
          override: true,
        },
        { name: 'content-security-policy', value: "frame-ancestors 'none'", override: true },
        { name: 'x-content-type-options', value: 'nosniff', override: true },
        { name: 'x-frame-options', value: 'DENY', override: false },
        { name: 'referrer-policy', value: 'strict-origin-when-cross-origin', override: true },
        { name: 'x-xss-protection', value: '1; mode=block', override: true },
      ],
    });
  });

  it('renders X-XSS-Protection with a report URI, and 0 when protection is off', () => {
    const withReport = resolveResponseHeadersPolicyHeaders(
      template({
        SecurityHeadersConfig: {
          XSSProtection: { Protection: true, ReportUri: 'https://r.example.com', Override: true },
        },
      }),
      { Ref: 'Rhp' }
    );
    expect(withReport?.set[0]?.value).toBe('1; report=https://r.example.com');
    const off = resolveResponseHeadersPolicyHeaders(
      template({ SecurityHeadersConfig: { XSSProtection: { Protection: false, Override: true } } }),
      { Ref: 'Rhp' }
    );
    expect(off?.set[0]?.value).toBe('0');
  });

  it('accepts string-typed booleans and numbers', () => {
    const policy = resolveResponseHeadersPolicyHeaders(
      template({
        SecurityHeadersConfig: {
          StrictTransportSecurity: {
            AccessControlMaxAgeSec: '600',
            IncludeSubdomains: 'true',
            Override: 'false',
          },
        },
      }),
      { Ref: 'Rhp' }
    );
    expect(policy?.set).toEqual([
      { name: 'strict-transport-security', value: 'max-age=600; includeSubDomains', override: false },
    ]);
  });

  it('resolves custom and remove headers, lower-casing the names', () => {
    const policy = resolveResponseHeadersPolicyHeaders(
      template({
        CustomHeadersConfig: {
          Items: [
            { Header: 'X-Custom', Value: 'v', Override: true },
            { Header: 'X-Empty', Override: false },
          ],
        },
        RemoveHeadersConfig: { Items: [{ Header: 'X-Powered-By' }, { Header: 'Vary' }] },
      }),
      { Ref: 'Rhp' }
    );
    expect(policy).toEqual({
      remove: ['x-powered-by', 'vary'],
      set: [
        { name: 'x-custom', value: 'v', override: true },
        { name: 'x-empty', value: '', override: false },
      ],
    });
  });

  it('returns undefined for a CORS-only policy, a managed policy id, or a non-policy resource', () => {
    const corsOnly = template({ CorsConfig: { AccessControlAllowOrigins: { Items: ['*'] } } });
    expect(resolveResponseHeadersPolicyHeaders(corsOnly, { Ref: 'Rhp' })).toBeUndefined();
    expect(
      resolveResponseHeadersPolicyHeaders(corsOnly, '67f7725c-6f97-4210-82d7-5512b31e9d03')
    ).toBeUndefined();
    expect(
      resolveResponseHeadersPolicyHeaders(
        { Resources: { Rhp: { Type: 'AWS::S3::Bucket', Properties: {} } } } as CloudFormationTemplate,
        { Ref: 'Rhp' }
      )
    ).toBeUndefined();
  });
});

describe('applyResponseHeadersPolicyHeaders', () => {
  function fakeResponse(initial: Record<string, string>): HeaderWritable & {
    headers: Map<string, string>;
  } {
    const headers = new Map(Object.entries(initial));
    return {
      headers,
      hasHeader: (n) => headers.has(n),
      setHeader: (n, v) => {
        if (n.includes(' ')) throw new TypeError('Invalid header name');
        headers.set(n, v);
      },
      removeHeader: (n) => {
        headers.delete(n);
      },
    };
  }

  it('removes first, then sets each header honoring Override, skipping an invalid one', () => {
    const res = fakeResponse({ 'x-a': 'origin', 'x-b': 'origin', 'x-gone': '1', 'x-re': 'origin' });
    const invalid: string[] = [];
    applyResponseHeadersPolicyHeaders(
      res,
      {
        remove: ['x-gone', 'x-re'],
        set: [
          { name: 'x-a', value: 'policy', override: true },
          { name: 'x-b', value: 'policy', override: false },
          { name: 'bad name', value: 'v', override: true },
          { name: 'x-re', value: 'policy', override: false },
          { name: 'x-new', value: 'policy', override: false },
        ],
      },
      (name) => invalid.push(name)
    );
    expect(Object.fromEntries(res.headers)).toEqual({
      'x-a': 'policy',
      'x-b': 'origin',
      'x-re': 'policy',
      'x-new': 'policy',
    });
    expect(invalid).toEqual(['bad name']);
  });
});
