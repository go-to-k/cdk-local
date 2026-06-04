import { describe, expect, it } from 'vite-plus/test';
import { serveLambdaUrlOrigin } from '../../../src/local/cloudfront-lambda-origin.js';

/** A captured event + a canned response, to assert both directions. */
function runWith(
  response: unknown,
  request: Partial<Parameters<typeof serveLambdaUrlOrigin>[0]['request']> = {}
): Promise<{ captured: Record<string, unknown>; result: Awaited<ReturnType<typeof serveLambdaUrlOrigin>> }> {
  let captured: Record<string, unknown> = {};
  const invoke = async (event: Record<string, unknown>): Promise<unknown> => {
    captured = event;
    return response;
  };
  return serveLambdaUrlOrigin({
    invoke,
    functionUrlLogicalId: 'HandlerUrl',
    functionLogicalId: 'Handler',
    request: {
      method: 'GET',
      uri: '/items/1',
      querystring: 'q=42',
      headers: { 'content-type': 'application/json', host: 'd.cloudfront.net' },
      body: Buffer.alloc(0),
      sourceIp: '203.0.113.7',
      ...request,
    },
  }).then((result) => ({ captured, result }));
}

describe('serveLambdaUrlOrigin — event construction', () => {
  it('builds a Function URL (v2.0) event from the request', async () => {
    const { captured } = await runWith({ statusCode: 200, body: 'ok' });
    expect(captured['version']).toBe('2.0');
    expect(captured['rawPath']).toBe('/items/1');
    expect(captured['rawQueryString']).toBe('q=42');
    const rc = captured['requestContext'] as Record<string, Record<string, unknown>>;
    expect(rc['http']!['method']).toBe('GET');
    expect(rc['http']!['path']).toBe('/items/1');
    expect(rc['http']!['sourceIp']).toBe('203.0.113.7');
  });

  it('forwards the request body and method', async () => {
    const { captured } = await runWith(
      { statusCode: 201, body: '' },
      { method: 'POST', body: Buffer.from('{"a":1}'), querystring: '' }
    );
    expect(captured['body']).toBe('{"a":1}');
    expect(captured['isBase64Encoded']).toBe(false);
    const rc = captured['requestContext'] as Record<string, Record<string, unknown>>;
    expect(rc['http']!['method']).toBe('POST');
  });
});

describe('serveLambdaUrlOrigin — response translation', () => {
  it('translates a shaped v2 response (status, headers, body)', async () => {
    const { result } = await runWith({
      statusCode: 201,
      headers: { 'content-type': 'text/plain', 'x-custom': 'v' },
      body: 'hello',
    });
    expect(result.statusCode).toBe(201);
    expect(result.headers['content-type']).toBe('text/plain');
    expect(result.headers['x-custom']).toBe('v');
    expect(result.body.toString('utf-8')).toBe('hello');
    expect(result.cookies).toEqual([]);
  });

  it('decodes a base64 body', async () => {
    const { result } = await runWith({
      statusCode: 200,
      body: Buffer.from('binary').toString('base64'),
      isBase64Encoded: true,
    });
    expect(result.body.toString('utf-8')).toBe('binary');
  });

  it('surfaces v2 cookies separately from headers', async () => {
    const { result } = await runWith({
      statusCode: 200,
      body: 'ok',
      cookies: ['session=abc; Path=/', 'theme=dark'],
    });
    expect(result.cookies).toEqual(['session=abc; Path=/', 'theme=dark']);
    expect(result.headers['set-cookie']).toBeUndefined();
  });

  it('wraps a bare (non-shaped) handler return as a 200 JSON body', async () => {
    const { result } = await runWith({ message: 'hi' });
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body.toString('utf-8'))).toEqual({ message: 'hi' });
  });
});
