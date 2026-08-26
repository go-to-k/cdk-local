/**
 * The RIE streaming prelude parse must not echo the bytes it parsed, because
 * those bytes are not guaranteed to be protocol framing. `invokeRieStreaming`
 * scans the WHOLE response for an 8-NUL run, and the commonest handler shape
 * in the wild (`streamifyResponse` plus `setContentType` / `write`, never
 * calling `HttpResponseStream.from`) sends no framing at all -- so an 8-NUL
 * run inside binary output matches by coincidence and the "prelude" is a
 * slice of raw function OUTPUT. Reported against the cdkd host as
 * go-to-k/cdkd#2203.
 *
 * These exercise `invokeRieStreaming` end-to-end against a tiny local HTTP
 * server rather than `parseStreamingPrelude` directly: the suppression lives
 * at the CALLER, so a direct-parser test cannot see it.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { invokeRieStreaming } from '../../../src/local/rie-client.js';

const SEPARATOR = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]);

let server: Server;
let port: number;
type StreamHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
let nextStreamResponse: StreamHandler | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    const handler = nextStreamResponse;
    if (!handler) {
      res.statusCode = 200;
      res.end('{}');
      return;
    }
    Promise.resolve()
      .then(() => handler(req, res))
      .catch(() => {
        if (!res.headersSent) res.statusCode = 500;
        if (!res.writableEnded) res.end();
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

/** Send `payload` as the whole response and return the rejection message. */
async function rejectionMessage(payload: Buffer): Promise<string> {
  nextStreamResponse = (_req, res) => {
    res.writeHead(200);
    res.end(payload);
  };
  try {
    await invokeRieStreaming('127.0.0.1', port, {}, 5000);
  } catch (err) {
    return (err as Error).message;
  }
  return expect.fail('invokeRieStreaming should have rejected on an unparseable prelude');
}

describe('invokeRieStreaming prelude failure message (go-to-k/cdkd#2203)', () => {
  it('withholds the ~10-character prefix V8 quotes from a spurious NUL match in binary output', async () => {
    // A tar stream is the sharpest instance: its 512-byte member header
    // NUL-pads everything after the 100-byte name field, so the FIRST 8-NUL
    // run sits immediately after the file name. `preludeBytes` becomes that
    // name, and on Node 24.15 the parser answers
    // `Unexpected token 'c', "customer-d"... is not valid JSON`.
    const name = 'customer-database-dump.sql';
    const tarHeader = Buffer.alloc(512);
    tarHeader.write(name, 0, 'utf8');
    const message = await rejectionMessage(
      Buffer.concat([tarHeader, Buffer.from('...archive payload...')])
    );

    // The needle is the PREFIX, not the whole name: `not.toContain(name)`
    // would pass WITHOUT the fix, since V8 never emits past its window.
    expect(message).not.toContain('customer-d');

    expect(message).toContain('prelude is not valid JSON');
    expect(message).toContain('SyntaxError');
    // Anchored on both sides: a bare `26 bytes before` is a substring of
    // `126 bytes before`, so an inflated count would pass unnoticed.
    expect(message).toContain(`; ${name.length} bytes before the 8-NUL separator`);
    // Anchored to the whole remediation clause: the diagnosis sentence above
    // it also names `HttpResponseStream.from`, so a bare symbol match stays
    // green with the remediation deleted.
    expect(message).toContain('calling HttpResponseStream.from(...) frames the response explicitly');
  });

  it('withholds a SHORT prelude, which V8 quotes in FULL rather than truncating', async () => {
    // Second leak shape: V8 appends `...` only past its prefix window, so
    // `JSON.parse('not-json{')` quotes the whole string.
    const bogus = 'not-json{';
    const message = await rejectionMessage(
      Buffer.concat([Buffer.from(bogus), SEPARATOR, Buffer.from('body')])
    );

    expect(message).not.toContain(bogus);

    expect(message).toContain('prelude is not valid JSON');
    expect(message).toContain('SyntaxError');
    expect(message).toContain(`; ${bogus.length} bytes before the 8-NUL separator`);
  });

  it('counts BYTES, not UTF-16 code units, in the reported prelude size', () => {
    // Both other fixtures are pure ASCII, where the two counts coincide -- so
    // a mutation to `preludeBytes.toString('utf8').length` would survive them.
    // Four 3-byte characters are 12 bytes and 4 code units.
    const multibyte = '\u3042\u3044\u3046\u3048'; // 4 chars, 12 bytes in UTF-8
    const preludeBuf = Buffer.from(multibyte, 'utf8');
    expect(preludeBuf.length).toBe(12);
    expect(multibyte.length).toBe(4);

    return rejectionMessage(
      Buffer.concat([preludeBuf, SEPARATOR, Buffer.from('body')])
    ).then((message) => {
      expect(message).toContain('; 12 bytes before the 8-NUL separator');
      expect(message).not.toContain('; 4 bytes before the 8-NUL separator');
      expect(message).not.toContain(multibyte);
      expect(message).not.toContain('Unexpected token');
    });
  });

  // --- the three input-INDEPENDENT throws must stay legible -------------
  //
  // `parseStreamingPrelude` throws four ways and only the `JSON.parse` one
  // carries the parsed bytes. Suppressing the other three buys no privacy
  // and ships a FALSE diagnosis -- a correctly-framed handler being told its
  // valid JSON is "not valid JSON", with advice to call a function it already
  // called. These fence the `err instanceof SyntaxError` gate.

  it('keeps the non-object-prelude diagnosis verbatim (valid JSON, wrong shape)', async () => {
    const message = await rejectionMessage(
      Buffer.concat([Buffer.from('"a string"'), SEPARATOR, Buffer.from('body')])
    );

    expect(message).toContain('prelude is not a JSON object');
    // The false diagnosis this gate exists to prevent.
    expect(message).not.toContain('is not valid JSON');
    expect(message).not.toContain('HttpResponseStream.from');
  });

  it('keeps the statusCode diagnosis verbatim (valid JSON object, bad statusCode)', async () => {
    const message = await rejectionMessage(
      Buffer.concat([Buffer.from('{"foo":1}'), SEPARATOR, Buffer.from('body')])
    );

    expect(message).toContain('statusCode must be a number');
    expect(message).toContain('got undefined');
    expect(message).not.toContain('is not valid JSON');
    expect(message).not.toContain('HttpResponseStream.from');
  });

  it('keeps the empty-prelude diagnosis verbatim', async () => {
    // Whitespace-only bytes before the separator: non-empty, so the
    // synthesized-prelude path is not taken, but `trim()` empties it.
    const message = await rejectionMessage(
      Buffer.concat([Buffer.from('   '), SEPARATOR, Buffer.from('body')])
    );

    expect(message).toContain('empty prelude');
    expect(message).not.toContain('is not valid JSON');
    expect(message).not.toContain('HttpResponseStream.from');
  });
});
