/**
 * go-to-k/cdk-local#867: the Lambda RIE registers its invoke path for every
 * method and answers only 200 / 400 / 500 / 502 / 504 there, so an HTTP 404 or
 * 405 on that path comes from some OTHER server (an image's own HTTP server on
 * `:8080`). Passing its body through would read as a successful invoke; both
 * the buffered and the streaming invoke refuse it instead.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { invokeRie, invokeRieStreaming } from '../../../src/local/rie-client.js';

let server: Server;
let port: number;
let next: { status: number; body: string } = { status: 200, body: '{}' };

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.statusCode = next.status;
      res.end(next.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  port = addr.port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

describe('invokeRie', () => {
  it.each([404, 405])('refuses an HTTP %i answer as not coming from the RIE', async (status) => {
    next = { status, body: '{"error":{"code":"not_found"}}' };
    await expect(invokeRie('127.0.0.1', port, {}, 5000)).rejects.toThrow(
      new RegExp(`HTTP ${status}, which the Lambda Runtime Interface Emulator never sends`)
    );
  });

  // The statuses the real RIE does send stay the caller's to interpret: 200
  // for a result, a handler error or a timeout; 502 (with the runtime's error
  // body) for a crashed init / invoke; 400 / 500 / 504 for its own states.
  it.each([
    [200, 'Task timed out after 3.00 seconds'],
    [502, '{"errorMessage":"exit status 1","errorType":"Runtime.ExitError"}'],
    [500, ''],
    [504, ''],
    [400, ''],
  ])('passes an RIE-shaped HTTP %i through', async (status, body) => {
    next = { status, body };
    await expect(invokeRie('127.0.0.1', port, {}, 5000)).resolves.toMatchObject({ raw: body });
  });
});

describe('invokeRieStreaming', () => {
  it.each([404, 405])('refuses an HTTP %i answer as not coming from the RIE', async (status) => {
    next = { status, body: '{"error":{"code":"not_found"}}' };
    await expect(invokeRieStreaming('127.0.0.1', port, {}, 5000)).rejects.toThrow(
      new RegExp(`HTTP ${status}, which the Lambda Runtime Interface Emulator never sends`)
    );
  });

  it('still parses a framed 200 answer', async () => {
    next = {
      status: 200,
      body: `{"statusCode":201,"headers":{}}${'\u0000'.repeat(8)}streamed`,
    };
    const result = await invokeRieStreaming('127.0.0.1', port, {}, 5000);
    expect(result.prelude.statusCode).toBe(201);
    const chunks: Buffer[] = [];
    for await (const c of result.body) chunks.push(Buffer.from(c as Buffer));
    expect(Buffer.concat(chunks).toString()).toBe('streamed');
  });
});
