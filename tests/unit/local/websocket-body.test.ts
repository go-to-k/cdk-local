import { describe, expect, it } from 'vite-plus/test';
import { bufferToBody } from '../../../src/local/websocket-body.js';

// bufferToBody returns the discriminated `{body, isBase64Encoded}` shape so
// binary frames surface as base64 + the flag, and text frames surface as
// UTF-8 + flag=false. Pre-fix the function returned a bare string and the
// discriminator was hardcoded `false` downstream (cdkd Issue #526 / #537).
describe('bufferToBody', () => {
  it('returns text body + isBase64Encoded=false for text frames', () => {
    const buf = Buffer.from('hello world', 'utf-8');
    expect(bufferToBody(buf, false)).toEqual({
      body: 'hello world',
      isBase64Encoded: false,
    });
  });

  it('returns base64 body + isBase64Encoded=true for binary frames', () => {
    const buf = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80]);
    expect(bufferToBody(buf, true)).toEqual({
      body: buf.toString('base64'),
      isBase64Encoded: true,
    });
  });

  it('preserves bytes > 0x7F across binary round-trip (the original bug class)', () => {
    // 0xFE / 0xFF are NOT valid UTF-8; pre-fix decoding them as UTF-8
    // would surface as U+FFFD (replacement char), corrupting the
    // handler's `Buffer.from(event.body, 'utf8')` decode.
    const original = Buffer.from([0xff, 0xfe, 0x80, 0x7f, 0x00]);
    const { body, isBase64Encoded } = bufferToBody(original, true);
    expect(isBase64Encoded).toBe(true);
    const roundTrip = Buffer.from(body, 'base64');
    expect(roundTrip.equals(original)).toBe(true);
  });

  it('concatenates fragmented Buffer[] input before encoding', () => {
    const fragments = [Buffer.from([0x01, 0x02]), Buffer.from([0x03, 0x04])];
    const { body, isBase64Encoded } = bufferToBody(fragments, true);
    expect(isBase64Encoded).toBe(true);
    expect(Buffer.from(body, 'base64')).toEqual(Buffer.from([0x01, 0x02, 0x03, 0x04]));
  });

  it('handles ArrayBuffer input', () => {
    const ab = new ArrayBuffer(3);
    new Uint8Array(ab).set([0x41, 0x42, 0x43]); // "ABC"
    expect(bufferToBody(ab, false)).toEqual({
      body: 'ABC',
      isBase64Encoded: false,
    });
  });

  // Zero-byte binary frame should produce `{body: '', isBase64Encoded: true}`
  // (NOT throw, NOT silently coerce to text). Empty Buffers come up in
  // WebSocket protocols that use a zero-length frame as a sentinel.
  it('returns empty body + isBase64Encoded=true for zero-byte binary frames', () => {
    expect(bufferToBody(Buffer.from([]), true)).toEqual({
      body: '',
      isBase64Encoded: true,
    });
  });
  it('returns empty body + isBase64Encoded=false for zero-byte text frames', () => {
    expect(bufferToBody(Buffer.from([]), false)).toEqual({
      body: '',
      isBase64Encoded: false,
    });
  });
});
