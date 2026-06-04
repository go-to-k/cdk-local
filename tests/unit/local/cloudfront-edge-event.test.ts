import { describe, expect, it } from 'vite-plus/test';
import {
  applyEdgeRequestResult,
  applyEdgeResponseResult,
  buildEdgeRequestEvent,
  buildEdgeResponseEvent,
  edgeHeadersToHttp,
  edgeResponseToResult,
  httpHeadersToEdge,
  interpretEdgeRequestResult,
  type EdgeRequestInput,
} from '../../../src/local/cloudfront-edge-event.js';

const CONFIG = { distributionDomainName: 'd.cloudfront.net', distributionId: 'Dist', requestId: 'req-1' };

function input(overrides: Partial<EdgeRequestInput> = {}): EdgeRequestInput {
  return {
    clientIp: '203.0.113.1',
    method: 'GET',
    uri: '/page',
    querystring: 'a=1',
    headers: { host: ['d.cloudfront.net'], 'user-agent': ['curl/8'] },
    ...overrides,
  };
}

describe('header translation', () => {
  it('httpHeadersToEdge produces the {key,value} multi-map', () => {
    expect(httpHeadersToEdge({ Host: ['x'], 'X-A': ['1', '2'] })).toEqual({
      host: [{ key: 'Host', value: 'x' }],
      'x-a': [
        { key: 'X-A', value: '1' },
        { key: 'X-A', value: '2' },
      ],
    });
  });

  it('edgeHeadersToHttp flattens, splits set-cookie, drops read-only headers', () => {
    const { headers, setCookies } = edgeHeadersToHttp({
      'content-type': [{ key: 'Content-Type', value: 'text/html' }],
      'set-cookie': [
        { key: 'Set-Cookie', value: 'a=1' },
        { key: 'Set-Cookie', value: 'b=2' },
      ],
      'content-length': [{ key: 'Content-Length', value: '999' }],
    });
    expect(headers).toEqual({ 'content-type': 'text/html' });
    expect(setCookies).toEqual(['a=1', 'b=2']);
    expect(headers['content-length']).toBeUndefined();
  });
});

describe('buildEdgeRequestEvent', () => {
  it('builds the Records[].cf request event; includeBody base64-encodes the body', () => {
    const event = buildEdgeRequestEvent({
      eventType: 'viewer-request',
      config: CONFIG,
      request: input({ body: Buffer.from('hello') }),
      includeBody: true,
    });
    const cf = event.Records[0]!.cf;
    expect(cf.config.eventType).toBe('viewer-request');
    expect(cf.request.uri).toBe('/page');
    expect(cf.request.method).toBe('GET');
    expect(cf.request.headers['host']).toEqual([{ key: 'host', value: 'd.cloudfront.net' }]);
    expect(cf.request.body).toEqual({
      action: 'read-only',
      data: Buffer.from('hello').toString('base64'),
      encoding: 'base64',
      inputTruncated: false,
    });
  });

  it('omits the body when includeBody is false', () => {
    const event = buildEdgeRequestEvent({
      eventType: 'origin-request',
      config: CONFIG,
      request: input({ body: Buffer.from('x') }),
      includeBody: false,
    });
    expect(event.Records[0]!.cf.request.body).toBeUndefined();
  });
});

describe('buildEdgeResponseEvent', () => {
  it('carries the response with a STRING status', () => {
    const event = buildEdgeResponseEvent({
      eventType: 'origin-response',
      config: CONFIG,
      request: input(),
      response: { statusCode: 200, headers: { 'content-type': 'text/html' } },
    });
    const response = event.Records[0]!.cf.response!;
    expect(response.status).toBe('200');
    expect(response.statusDescription).toBe('OK');
    expect(response.headers['content-type']).toEqual([{ key: 'content-type', value: 'text/html' }]);
  });
});

describe('interpretEdgeRequestResult', () => {
  const fallback = {
    clientIp: '203.0.113.1',
    method: 'GET',
    uri: '/page',
    querystring: 'a=1',
    headers: { host: [{ key: 'host', value: 'd' }] },
  };

  it('classifies a return with a status as a generated response', () => {
    const out = interpretEdgeRequestResult({ status: '302', headers: {} }, fallback);
    expect(out.kind).toBe('response');
  });

  it('classifies a return without a status as a continue (modified request)', () => {
    const out = interpretEdgeRequestResult({ uri: '/rewritten' }, fallback);
    expect(out.kind).toBe('continue');
    if (out.kind === 'continue') expect(out.request.uri).toBe('/rewritten');
  });

  it('continues unchanged on a non-object return', () => {
    const out = interpretEdgeRequestResult(undefined, fallback);
    expect(out).toEqual({ kind: 'continue', request: fallback });
  });
});

describe('edgeResponseToResult', () => {
  it('parses the string status and decodes a base64 body', () => {
    const r = edgeResponseToResult({
      status: '201',
      headers: { location: [{ key: 'Location', value: '/x' }] },
      body: Buffer.from('hi').toString('base64'),
      bodyEncoding: 'base64',
    });
    expect(r.statusCode).toBe(201);
    expect(r.headers['location']).toBe('/x');
    expect(r.body.toString()).toBe('hi');
  });

  it('falls back to the origin body when the function did not set one', () => {
    const r = edgeResponseToResult({ status: '200', headers: {} }, Buffer.from('origin'));
    expect(r.body.toString()).toBe('origin');
  });
});

describe('applyEdgeRequestResult (server-facing)', () => {
  it('continue: applies uri / method / header rewrites onto the input', () => {
    const out = applyEdgeRequestResult(
      { uri: '/new', method: 'POST', headers: { 'x-add': [{ key: 'X-Add', value: 'v' }] } },
      input()
    );
    expect(out.kind).toBe('continue');
    if (out.kind === 'continue') {
      expect(out.request.uri).toBe('/new');
      expect(out.request.method).toBe('POST');
      expect(out.request.headers['x-add']).toEqual(['v']);
    }
  });

  it('replace body: a request.body.action=replace rewrites the input body', () => {
    const out = applyEdgeRequestResult(
      { body: { action: 'replace', data: 'bmV3', encoding: 'base64' } },
      input({ body: Buffer.from('old') })
    );
    if (out.kind === 'continue') expect(out.request.body?.toString()).toBe('new');
  });

  it('response: collapses a generated response to the server result', () => {
    const out = applyEdgeRequestResult(
      { status: '403', headers: { 'content-type': [{ key: 'Content-Type', value: 'text/plain' }] }, body: 'no' },
      input()
    );
    expect(out.kind).toBe('response');
    if (out.kind === 'response') {
      expect(out.response.statusCode).toBe(403);
      expect(out.response.body.toString()).toBe('no');
    }
  });
});

describe('applyEdgeResponseResult (server-facing)', () => {
  it('applies a header modification while keeping the origin status + body', () => {
    const r = applyEdgeResponseResult(
      { headers: { 'x-stamp': [{ key: 'X-Stamp', value: 'edge' }] } },
      { statusCode: 200, headers: { 'content-type': 'text/html' } },
      Buffer.from('body')
    );
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-stamp']).toBe('edge');
    expect(r.body.toString()).toBe('body');
  });

  it('honors a status override from the response stage', () => {
    const r = applyEdgeResponseResult({ status: '404' }, { statusCode: 200, headers: {} }, Buffer.alloc(0));
    expect(r.statusCode).toBe(404);
  });
});
