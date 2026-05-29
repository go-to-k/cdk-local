import { describe, it, expect } from 'vite-plus/test';
import {
  buildAlbLambdaEvent,
  translateAlbLambdaResponse,
  snapshotFromIncoming,
  type AlbHttpRequestSnapshot,
} from '../../../src/local/alb-lambda-event.js';
import type { IncomingMessage } from 'node:http';

const TG_ARN =
  'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/my-tg/6d0ecf831eec9f09';

function snap(overrides: Partial<AlbHttpRequestSnapshot> = {}): AlbHttpRequestSnapshot {
  return {
    method: 'GET',
    rawUrl: '/',
    headers: {},
    body: Buffer.alloc(0),
    ...overrides,
  };
}

describe('buildAlbLambdaEvent (request -> ALB Lambda event)', () => {
  it('builds the single-value form with requestContext.elb + path + last-wins query/headers', () => {
    const event = buildAlbLambdaEvent(
      snap({
        method: 'POST',
        rawUrl: '/items?k=v1&k=v2&other=x',
        headers: {
          'Content-Type': ['application/json'],
          Accept: ['text/html', 'application/xml'],
        },
        body: Buffer.from('{"a":1}', 'utf-8'),
      }),
      { targetGroupArn: TG_ARN, multiValueHeaders: false }
    );

    expect(event['requestContext']).toEqual({ elb: { targetGroupArn: TG_ARN } });
    expect(event['httpMethod']).toBe('POST');
    expect(event['path']).toBe('/items');
    // last value wins on dup keys in the single-value form.
    expect(event['queryStringParameters']).toEqual({ k: 'v2', other: 'x' });
    // header names lowercased; last value wins (Accept had two).
    expect(event['headers']).toEqual({
      'content-type': 'application/json',
      accept: 'application/xml',
    });
    expect(event).not.toHaveProperty('multiValueHeaders');
    expect(event).not.toHaveProperty('multiValueQueryStringParameters');
    expect(event['isBase64Encoded']).toBe(false);
    expect(event['body']).toBe('{"a":1}');
  });

  it('builds the multi-value form when the target group enables multi-value headers', () => {
    const event = buildAlbLambdaEvent(
      snap({
        rawUrl: '/x?k=v1&k=v2',
        headers: { Cookie: ['a=1', 'b=2'], Host: ['example.com'] },
      }),
      { targetGroupArn: TG_ARN, multiValueHeaders: true }
    );
    expect(event['multiValueQueryStringParameters']).toEqual({ k: ['v1', 'v2'] });
    expect(event['multiValueHeaders']).toEqual({
      cookie: ['a=1', 'b=2'],
      host: ['example.com'],
    });
    expect(event).not.toHaveProperty('headers');
    expect(event).not.toHaveProperty('queryStringParameters');
  });

  it('does NOT decode URL-encoded query parameters (ALB passes them verbatim)', () => {
    const event = buildAlbLambdaEvent(snap({ rawUrl: '/s?q=a%20b%26c' }), {
      targetGroupArn: TG_ARN,
      multiValueHeaders: false,
    });
    expect(event['queryStringParameters']).toEqual({ q: 'a%20b%26c' });
  });

  it('base64-encodes a binary body (non-textual content-type) and flags isBase64Encoded', () => {
    const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    const event = buildAlbLambdaEvent(
      snap({ method: 'POST', headers: { 'content-type': ['image/png'] }, body: bin }),
      { targetGroupArn: TG_ARN, multiValueHeaders: false }
    );
    expect(event['isBase64Encoded']).toBe(true);
    expect(event['body']).toBe(bin.toString('base64'));
  });

  it('base64-encodes whenever content-encoding is present even for a textual type', () => {
    const event = buildAlbLambdaEvent(
      snap({
        method: 'POST',
        headers: { 'content-type': ['text/plain'], 'content-encoding': ['gzip'] },
        body: Buffer.from('compressed-bytes'),
      }),
      { targetGroupArn: TG_ARN, multiValueHeaders: false }
    );
    expect(event['isBase64Encoded']).toBe(true);
  });

  it('treats an empty body as a plain (non-base64) empty string', () => {
    const event = buildAlbLambdaEvent(snap({ headers: { 'content-type': ['image/png'] } }), {
      targetGroupArn: TG_ARN,
      multiValueHeaders: false,
    });
    expect(event['isBase64Encoded']).toBe(false);
    expect(event['body']).toBe('');
  });

  it('handles a bare query flag (no =) and a query-less path', () => {
    const withFlag = buildAlbLambdaEvent(snap({ rawUrl: '/p?flag' }), {
      targetGroupArn: TG_ARN,
      multiValueHeaders: false,
    });
    expect(withFlag['queryStringParameters']).toEqual({ flag: '' });
    const noQuery = buildAlbLambdaEvent(snap({ rawUrl: '/p' }), {
      targetGroupArn: TG_ARN,
      multiValueHeaders: false,
    });
    expect(noQuery['queryStringParameters']).toEqual({});
    expect(noQuery['path']).toBe('/p');
  });
});

describe('snapshotFromIncoming', () => {
  it('normalizes IncomingMessage header values to string arrays + uppercases the method', () => {
    const req = {
      method: 'post',
      url: '/a?b=c',
      headers: { 'x-single': 'one', 'set-cookie': ['a=1', 'b=2'] },
    } as unknown as IncomingMessage;
    const s = snapshotFromIncoming(req, Buffer.from('body'));
    expect(s.method).toBe('POST');
    expect(s.rawUrl).toBe('/a?b=c');
    expect(s.headers['x-single']).toEqual(['one']);
    expect(s.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    expect(s.body.toString()).toBe('body');
  });
});

describe('translateAlbLambdaResponse (response -> HTTP)', () => {
  it('translates a shaped response with single-value headers + statusDescription', () => {
    const out = translateAlbLambdaResponse({
      statusCode: 201,
      statusDescription: '201 Created',
      headers: { 'Content-Type': 'application/json', 'X-Custom': 1 },
      body: '{"ok":true}',
    });
    expect(out.statusCode).toBe(201);
    expect(out.statusDescription).toBe('201 Created');
    expect(out.headers['content-type']).toEqual(['application/json']);
    expect(out.headers['x-custom']).toEqual(['1']);
    expect(out.body.toString()).toBe('{"ok":true}');
    // content-length recomputed from the actual bytes.
    expect(out.headers['content-length']).toEqual([String(out.body.length)]);
  });

  it('emits one header entry per multiValueHeaders value (e.g. multiple Set-cookie)', () => {
    const out = translateAlbLambdaResponse({
      statusCode: 200,
      multiValueHeaders: {
        'Set-cookie': ['a=1; HttpOnly', 'b=2'],
        'Content-Type': ['application/json'],
      },
      body: 'x',
    });
    expect(out.headers['set-cookie']).toEqual(['a=1; HttpOnly', 'b=2']);
    expect(out.headers['content-type']).toEqual(['application/json']);
  });

  it('decodes a base64 body when isBase64Encoded is true', () => {
    const raw = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    const out = translateAlbLambdaResponse({
      statusCode: 200,
      isBase64Encoded: true,
      body: raw.toString('base64'),
    });
    expect(Buffer.compare(out.body, raw)).toBe(0);
  });

  it('treats a missing body as an empty body', () => {
    const out = translateAlbLambdaResponse({ statusCode: 204 });
    expect(out.statusCode).toBe(204);
    expect(out.body.length).toBe(0);
  });

  it('returns 502 for a Lambda runtime error envelope', () => {
    const out = translateAlbLambdaResponse({
      errorMessage: 'boom',
      errorType: 'Error',
      stackTrace: ['at handler'],
    });
    expect(out.statusCode).toBe(502);
  });

  it('returns 502 for a malformed response (no numeric statusCode)', () => {
    expect(translateAlbLambdaResponse({ body: 'no status' }).statusCode).toBe(502);
    expect(translateAlbLambdaResponse({ statusCode: 'oops' }).statusCode).toBe(502);
    expect(translateAlbLambdaResponse('a plain string').statusCode).toBe(502);
    expect(translateAlbLambdaResponse(null).statusCode).toBe(502);
    expect(translateAlbLambdaResponse([1, 2, 3]).statusCode).toBe(502);
  });

  it('serializes a non-string JSON body', () => {
    const out = translateAlbLambdaResponse({ statusCode: 200, body: { a: 1 } });
    expect(out.body.toString()).toBe('{"a":1}');
  });
});
