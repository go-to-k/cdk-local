import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vite-plus/test';
import {
  buildViewerRequestEvent,
  buildViewerResponseEvent,
  compileCloudFrontFunction,
  runViewerRequest,
  runViewerResponse,
  serializeCfQueryString,
  stripCloudFrontImport,
} from '../../../src/local/cloudfront-function-runtime.js';
import { createCloudFrontModule, type KvsDataSource } from '../../../src/local/cloudfront-kvs.js';

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

  it('exposes the Buffer global to the function — Basic-Auth (issue #410)', async () => {
    const fn = compile(
      [
        'function handler(event) {',
        '  var request = event.request;',
        "  var expected = 'Basic ' + Buffer.from('user:pass').toString('base64');",
        '  var auth = request.headers.authorization;',
        '  if (!auth || auth.value !== expected) {',
        "    return { statusCode: 401, statusDescription: 'Unauthorized', headers: { 'www-authenticate': { value: 'Basic' } } };",
        '  }',
        '  return request;',
        '}',
      ].join('\n')
    );
    // No Authorization header -> the Buffer-built expected value mismatches -> 401.
    const denied = await runViewerRequest(fn, reqEvent('/'));
    expect(denied.kind).toBe('response');
    if (denied.kind === 'response') expect(denied.response.statusCode).toBe(401);
    // The correct Basic credentials pass.
    const token = Buffer.from('user:pass').toString('base64');
    const ok = await runViewerRequest(fn, reqEvent('/', { authorization: `Basic ${token}` }));
    expect(ok.kind).toBe('continue');
  });

  it('exposes Buffer to TOP-LEVEL code (the compile-time handler probe) — issue #410', () => {
    // A function that uses Buffer at module scope must still compile (the probe
    // runs the top-level code to check for `handler`).
    expect(() =>
      compile(
        [
          "const SECRET = Buffer.from('user:pass').toString('base64');",
          'function handler(event) { event.request.headers["x-secret"] = { value: SECRET }; return event.request; }',
        ].join('\n')
      )
    ).not.toThrow();
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

describe('stripCloudFrontImport', () => {
  it('strips the import and returns the binding name', () => {
    const out = stripCloudFrontImport("import cf from 'cloudfront';\nfunction handler(e){return e}");
    expect(out.bindingName).toBe('cf');
    expect(out.code).not.toMatch(/import/);
    // The handler body survives.
    expect(out.code).toMatch(/function handler/);
  });

  it('captures a non-default binding name + double quotes', () => {
    expect(stripCloudFrontImport('import store from "cloudfront"').bindingName).toBe('store');
  });

  it('returns the code unchanged with no binding when cloudfront is not imported', () => {
    const code = 'function handler(event) { return event.request; }';
    expect(stripCloudFrontImport(code)).toEqual({ code });
  });

  it('preserves line numbering (blanks the import line)', () => {
    const out = stripCloudFrontImport("import cf from 'cloudfront';\nlet x = 1;");
    expect(out.code.split('\n')).toHaveLength(2);
  });
});

function kvsSource(map: Record<string, string>): KvsDataSource {
  return { label: 'fake', getValue: (k) => Promise.resolve(map[k]) };
}

describe('CloudFront Function KeyValueStore injection', () => {
  const KVS_FN = [
    "import cf from 'cloudfront';",
    'async function handler(event) {',
    "  event.request.uri = await cf.kvs().get(event.request.uri);",
    '  return event.request;',
    '}',
  ].join('\n');

  it('records the cloudfront binding name at compile time', () => {
    expect(compile(KVS_FN).cloudfrontBindingName).toBe('cf');
  });

  it('injects the resolved cf module so cf.kvs().get() resolves', async () => {
    const fn = compile(KVS_FN);
    fn.cloudfrontModule = createCloudFrontModule([kvsSource({ '/old': '/new' })]);
    const outcome = await runViewerRequest(fn, reqEvent('/old'));
    expect(outcome.kind).toBe('continue');
    if (outcome.kind === 'continue') expect(outcome.request.uri).toBe('/new');
  });

  it('injects an unbound module that fails the read with actionable guidance', async () => {
    const fn = compile(KVS_FN); // no cloudfrontModule set
    await expect(runViewerRequest(fn, reqEvent('/old'))).rejects.toThrow(/--from-cfn-stack/);
  });

  it('compiles a function whose top-level code calls cf.kvs(id)', () => {
    const code = [
      "import cf from 'cloudfront';",
      "const kvs = cf.kvs('some-id');",
      'function handler(event) { return event.request; }',
    ].join('\n');
    // The probe must not throw on the top-level cf.kvs(id) call.
    expect(() => compile(code)).not.toThrow();
  });
});

describe('CloudFront Functions 2.0 runtime built-ins (issue #410)', () => {
  // Run a function whose body computes a value and returns it in a response
  // header, so the test can read the result of the global / require under test.
  async function evalToHeader(expr: string): Promise<string | undefined> {
    const fn = compile(
      `function handler(event){ var v = (${expr}); return { statusCode: 200, headers: { 'x-out': { value: String(v) } } }; }`
    );
    const out = await runViewerRequest(fn, reqEvent('/'));
    return out.kind === 'response' ? out.response.headers['x-out']?.value : undefined;
  }

  it('Buffer.from(...).toString(base64)', async () => {
    expect(await evalToHeader("Buffer.from('user:pass').toString('base64')")).toBe(
      Buffer.from('user:pass').toString('base64')
    );
  });

  it('atob / btoa', async () => {
    expect(await evalToHeader("atob(btoa('hello'))")).toBe('hello');
  });

  it('TextEncoder / TextDecoder', async () => {
    expect(await evalToHeader("new TextDecoder().decode(new TextEncoder().encode('hi'))")).toBe('hi');
  });

  it("require('crypto') HMAC sha256", async () => {
    const expected = createHmac('sha256', 'key').update('msg').digest('hex');
    expect(
      await evalToHeader("require('crypto').createHmac('sha256','key').update('msg').digest('hex')")
    ).toBe(expected);
  });

  it("require('querystring').parse", async () => {
    expect(await evalToHeader("require('querystring').parse('a=1&b=2').b")).toBe('2');
  });

  it("require('buffer').Buffer", async () => {
    expect(await evalToHeader("require('buffer').Buffer.from('x').toString('hex')")).toBe('78');
  });

  it('require of an unavailable module (fs) throws, matching the deployed runtime', async () => {
    const fn = compile("function handler(event){ require('fs'); return event.request; }");
    await expect(runViewerRequest(fn, reqEvent('/'))).rejects.toThrow(/Cannot find module 'fs'/);
  });
});
