import { describe, expect, it } from 'vite-plus/test';
import {
  buildViewerRequestEvent,
  buildViewerResponseEvent,
  compileCloudFrontFunction,
  runViewerRequest,
  runViewerResponse,
  serializeCfQueryString,
} from '../../../src/local/cloudfront-function-runtime.js';

function compile(code: string, runtime = 'cloudfront-js-2.0') {
  return compileCloudFrontFunction('Fn', code, runtime);
}

function reqEvent(uri: string, headers: Record<string, string | string[]> = {}) {
  return buildViewerRequestEvent({
    method: 'GET',
    uri,
    querystring: '',
    headers,
    ip: '203.0.113.1',
    distributionId: 'Dist',
    domainName: 'localhost',
    requestId: 'req-1',
  });
}

describe('compileCloudFrontFunction', () => {
  it('throws on a syntax error', () => {
    expect(() => compile('function handler(event) { return ')).toThrow(/failed to compile/);
  });

  it('throws when no handler is declared', () => {
    expect(() => compile('var notHandler = 1;')).toThrow(/does not declare a 'handler'/);
  });
});

describe('runViewerRequest', () => {
  it('rewrites the uri and continues to the origin', async () => {
    const fn = compile(
      "function handler(event){var r=event.request; if(r.uri.endsWith('/')) r.uri+='index.html'; return r;}"
    );
    const out = await runViewerRequest(fn, reqEvent('/foo/'));
    expect(out.kind).toBe('continue');
    if (out.kind === 'continue') expect(out.request.uri).toBe('/foo/index.html');
  });

  it('short-circuits with a generated response when the handler returns a statusCode', async () => {
    const fn = compile(
      "function handler(event){return {statusCode:301, statusDescription:'Moved', headers:{location:{value:'https://example.com/'}}};}"
    );
    const out = await runViewerRequest(fn, reqEvent('/old'));
    expect(out.kind).toBe('response');
    if (out.kind === 'response') {
      expect(out.response.statusCode).toBe(301);
      expect(out.response.headers['location']?.value).toBe('https://example.com/');
    }
  });

  it('continues unchanged when the handler returns a non-object', async () => {
    const fn = compile('function handler(event){ return undefined; }');
    const out = await runViewerRequest(fn, reqEvent('/x'));
    expect(out.kind).toBe('continue');
    if (out.kind === 'continue') expect(out.request.uri).toBe('/x');
  });

  it('awaits an async (cloudfront-js-2.0) handler', async () => {
    const fn = compile(
      "async function handler(event){ var r = event.request; r.uri = '/async.html'; return r; }"
    );
    const out = await runViewerRequest(fn, reqEvent('/'));
    expect(out.kind).toBe('continue');
    if (out.kind === 'continue') expect(out.request.uri).toBe('/async.html');
  });

  it('wraps a handler that throws with the function logical id', async () => {
    const fn = compile("function handler(event){ throw new Error('boom'); }");
    await expect(runViewerRequest(fn, reqEvent('/'))).rejects.toThrow(/CloudFront Function 'Fn'.*boom/);
  });

  it('tolerates a handler that writes a bare-string header value', async () => {
    const fn = compile(
      "function handler(event){ var r=event.request; r.headers['x-test']='bare'; return r; }"
    );
    const out = await runViewerRequest(fn, reqEvent('/'));
    expect(out.kind).toBe('continue');
    if (out.kind === 'continue') expect(out.request.headers['x-test']?.value).toBe('bare');
  });

  it('aborts a runaway synchronous handler via the vm timeout', async () => {
    const fn = compile('function handler(event){ while (true) {} }');
    await expect(runViewerRequest(fn, reqEvent('/'))).rejects.toThrow(
      /CloudFront Function 'Fn'/
    );
  }, 15000);
});

describe('runViewerResponse', () => {
  it('mutates a response header', async () => {
    const fn = compile(
      "function handler(event){var r=event.response; r.headers['x-frame-options']={value:'DENY'}; return r;}"
    );
    const reqEv = reqEvent('/');
    const respEv = buildViewerResponseEvent(reqEv, {
      statusCode: 200,
      headers: { 'content-type': 'text/html' },
    });
    const out = await runViewerResponse(fn, respEv);
    expect(out.statusCode).toBe(200);
    expect(out.headers['x-frame-options']?.value).toBe('DENY');
    // The origin header is preserved.
    expect(out.headers['content-type']?.value).toBe('text/html');
  });
});

describe('buildViewerRequestEvent', () => {
  it('lower-cases header names and splits cookies out', () => {
    const ev = reqEvent('/p', { Host: 'localhost', Cookie: 'a=1; b=2' });
    expect(ev.request.headers['host']?.value).toBe('localhost');
    expect(ev.request.cookies['a']?.value).toBe('1');
    expect(ev.request.cookies['b']?.value).toBe('2');
    expect(ev.context.eventType).toBe('viewer-request');
  });

  it('promotes a repeated query parameter to multiValue', () => {
    const ev = buildViewerRequestEvent({
      method: 'GET',
      uri: '/p',
      querystring: 'a=1&a=2&b=3',
      headers: {},
      ip: '203.0.113.1',
      distributionId: 'D',
      domainName: 'localhost',
      requestId: 'r',
    });
    expect(ev.request.querystring['a']?.multiValue?.map((m) => m.value)).toEqual(['1', '2']);
    expect(ev.request.querystring['b']?.value).toBe('3');
  });
});

describe('serializeCfQueryString', () => {
  it('round-trips single and multi values', () => {
    expect(serializeCfQueryString({ a: { value: '1' }, b: { value: 'x', multiValue: [{ value: 'x' }, { value: 'y' }] } })).toBe(
      'a=1&b=x&b=y'
    );
  });
});
