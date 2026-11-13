/**
 * REST API (v1) response-streaming contract pieces that live in the RIE
 * streaming client (go-to-k/cdk-local#922):
 * https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode-lambda.html
 */

import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { invokeRieStreaming, parseStreamingPrelude } from '../../../src/local/rie-client.js';

const SEPARATOR = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]);

describe('parseStreamingPrelude (#922)', () => {
  it('defaults an absent statusCode to 200', () => {
    expect(parseStreamingPrelude('{"headers":{"content-type":"text/plain"}}')).toEqual({
      statusCode: 200,
      headers: { 'content-type': 'text/plain' },
    });
    expect(parseStreamingPrelude('{}').statusCode).toBe(200);
  });

  it('still throws on a present non-numeric statusCode', () => {
    expect(() => parseStreamingPrelude('{"statusCode":"abc"}')).toThrow(
      /statusCode must be a number \(got string\)/
    );
    expect(() => parseStreamingPrelude('{"statusCode":null}')).toThrow(/statusCode must be a number/);
  });

  it('parses multiValueHeaders, keeping only array values', () => {
    expect(
      parseStreamingPrelude(
        JSON.stringify({
          statusCode: 201,
          multiValueHeaders: { 'x-multi': ['a', 'b'], 'x-num': [1], 'x-bad': 'scalar' },
        })
      )
    ).toEqual({
      statusCode: 201,
      headers: {},
      multiValueHeaders: { 'x-multi': ['a', 'b'], 'x-num': ['1'] },
    });
  });
});

describe('invokeRieStreaming framing signals (#922)', () => {
  let server: Server;
  let port: number;
  let respond: (res: ServerResponse) => void = (res) => res.end();

  beforeAll(async () => {
    server = createServer((_req, res) => respond(res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    port = addr.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reports preludeSynthesized=false for a framed response', async () => {
    respond = (res) => res.end(Buffer.concat([Buffer.from('{"statusCode":200}'), SEPARATOR, Buffer.from('x')]));
    const r = await invokeRieStreaming('127.0.0.1', port, {}, 5000);
    expect(r.preludeSynthesized).toBe(false);
    r.body.resume();
  });

  it('reports preludeSynthesized=true when no delimiter is present', async () => {
    respond = (res) => res.end('{"statusCode":200,"body":"plain buffered handler"}');
    const r = await invokeRieStreaming('127.0.0.1', port, {}, 5000);
    expect(r.preludeSynthesized).toBe(true);
    r.body.resume();
  });

  it('honors preludeMaxBytes with a StreamingPreludeLimitError', async () => {
    // 20 KB of unframed output: past the 16 KB REST limit, far under the
    // 1 MiB default.
    respond = (res) => {
      res.write(Buffer.alloc(10 * 1024, 0x61));
      setTimeout(() => res.end(Buffer.alloc(10 * 1024, 0x61)), 20);
    };
    await expect(
      invokeRieStreaming('127.0.0.1', port, {}, 5000, { preludeMaxBytes: 16 * 1024 })
    ).rejects.toMatchObject({ name: 'StreamingPreludeLimitError' });
    const r = await invokeRieStreaming('127.0.0.1', port, {}, 5000);
    expect(r.preludeSynthesized).toBe(true);
    r.body.resume();
  });
});
