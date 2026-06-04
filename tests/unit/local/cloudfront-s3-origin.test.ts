import { describe, expect, it, vi } from 'vite-plus/test';
import {
  classifyS3Error,
  createS3OriginReader,
  type S3FetchResult,
  type S3ObjectFetcher,
} from '../../../src/local/cloudfront-s3-origin.js';
import { getLogger } from '../../../src/utils/logger.js';

/** Build a fetcher backed by an in-memory key->bytes map; unknown keys are not-found. */
function mapFetcher(objects: Record<string, string>): S3ObjectFetcher {
  return async (key) =>
    key in objects
      ? ({ kind: 'found', body: Buffer.from(objects[key]!) } satisfies S3FetchResult)
      : ({ kind: 'not-found' } satisfies S3FetchResult);
}

describe('createS3OriginReader', () => {
  it('serves the default root object at / with the right content type', async () => {
    const reader = createS3OriginReader('my-bucket', {
      fetchObject: mapFetcher({ 'index.html': '<h1>root</h1>' }),
    });
    const r = await reader({ uri: '/', defaultRootObject: 'index.html' });
    expect(r.statusCode).toBe(200);
    expect(r.body.toString()).toContain('root');
    expect(r.headers['content-type']).toContain('text/html');
  });

  it('serves an exact key by extension MIME', async () => {
    const reader = createS3OriginReader('my-bucket', {
      fetchObject: mapFetcher({ 'app.js': 'console.log(1)' }),
    });
    const r = await reader({ uri: '/app.js' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('javascript');
  });

  it('does NOT auto-index a sub-path (matches CloudFront)', async () => {
    const reader = createS3OriginReader('my-bucket', {
      fetchObject: mapFetcher({ 'foo/index.html': '<h1>foo</h1>' }),
    });
    const r = await reader({ uri: '/foo', defaultRootObject: 'index.html' });
    expect(r.statusCode).toBe(404);
  });

  it('falls back to the CustomErrorResponses SPA page on a missing key', async () => {
    const reader = createS3OriginReader('my-bucket', {
      fetchObject: mapFetcher({ 'index.html': '<h1>spa</h1>' }),
    });
    const r = await reader({
      uri: '/deep/route',
      customErrorResponses: [
        { errorCode: 403, responsePagePath: '/index.html', responseCode: 200 },
      ],
    });
    expect(r.statusCode).toBe(200);
    expect(r.body.toString()).toContain('spa');
  });

  it('returns a plain 404 when no object and no usable error page', async () => {
    const reader = createS3OriginReader('my-bucket', { fetchObject: mapFetcher({}) });
    const r = await reader({ uri: '/missing.png' });
    expect(r.statusCode).toBe(404);
    expect(r.headers['content-type']).toContain('text/plain');
  });

  it('warns once with the --origin escape hatch when S3 denies the read', async () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    try {
      const reader = createS3OriginReader('locked-bucket', {
        fetchObject: async () => ({ kind: 'denied' }),
      });
      const first = await reader({ uri: '/a.html' });
      const second = await reader({ uri: '/b.html' });
      expect(first.statusCode).toBe(404);
      expect(second.statusCode).toBe(404);
      // Denial warned exactly once (deniedWarned latch), naming the bucket + --origin.
      const denialWarns = warn.mock.calls.filter((c) => String(c[0]).includes('locked-bucket'));
      expect(denialWarns).toHaveLength(1);
      expect(String(denialWarns[0]![0])).toContain('--origin');
    } finally {
      warn.mockRestore();
    }
  });

  it('serves the error page even when the primary read was denied (OAC private bucket)', async () => {
    // 403 on a missing key is the OAC-fronted-private-bucket default; the SPA
    // fallback page is still served (the error page IS readable here).
    const reader = createS3OriginReader('my-bucket', {
      fetchObject: async (key) =>
        key === 'index.html'
          ? { kind: 'found', body: Buffer.from('<h1>spa</h1>') }
          : { kind: 'denied' },
    });
    const r = await reader({
      uri: '/route',
      customErrorResponses: [{ errorCode: 403, responsePagePath: '/index.html' }],
    });
    expect(r.statusCode).toBe(403);
    expect(r.body.toString()).toContain('spa');
  });
});

describe('classifyS3Error', () => {
  it('maps NoSuchKey / 404 to not-found', () => {
    expect(classifyS3Error({ name: 'NoSuchKey' }).kind).toBe('not-found');
    expect(classifyS3Error({ $metadata: { httpStatusCode: 404 } }).kind).toBe('not-found');
  });

  it('maps AccessDenied / 403 to denied', () => {
    expect(classifyS3Error({ name: 'AccessDenied' }).kind).toBe('denied');
    expect(classifyS3Error({ $metadata: { httpStatusCode: 403 } }).kind).toBe('denied');
  });

  it('maps anything else to error with a message', () => {
    const r = classifyS3Error(new Error('connection reset'));
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain('connection reset');
  });
});

describe('createS3OriginReader — read-through cache (--cache-origin)', () => {
  it('with cache off (default), re-reads the same key on every request', async () => {
    let calls = 0;
    const reader = createS3OriginReader('b', {
      fetchObject: async (key) => {
        calls += 1;
        return key === 'index.html'
          ? { kind: 'found', body: Buffer.from('v') }
          : { kind: 'not-found' };
      },
    });
    await reader({ uri: '/index.html' });
    await reader({ uri: '/index.html' });
    expect(calls).toBe(2);
  });

  it('with cache on, serves a repeat read from memory (one fetch)', async () => {
    let calls = 0;
    const reader = createS3OriginReader('b', {
      cache: true,
      fetchObject: async (key) => {
        calls += 1;
        return key === 'index.html'
          ? { kind: 'found', body: Buffer.from('v') }
          : { kind: 'not-found' };
      },
    });
    const a = await reader({ uri: '/index.html' });
    const b = await reader({ uri: '/index.html' });
    expect(calls).toBe(1);
    expect(a.body.toString()).toBe('v');
    expect(b.body.toString()).toBe('v');
  });

  it('clearCache() forces the next read to re-fetch', async () => {
    let calls = 0;
    const reader = createS3OriginReader('b', {
      cache: true,
      fetchObject: async () => {
        calls += 1;
        return { kind: 'found', body: Buffer.from('v') };
      },
    });
    await reader({ uri: '/a.js' });
    reader.clearCache();
    await reader({ uri: '/a.js' });
    expect(calls).toBe(2);
  });

  it('does not cache a miss (a later upload is picked up)', async () => {
    const objects: Record<string, string> = {};
    const reader = createS3OriginReader('b', {
      cache: true,
      fetchObject: async (key) =>
        key in objects
          ? { kind: 'found', body: Buffer.from(objects[key]!) }
          : { kind: 'not-found' },
    });
    expect((await reader({ uri: '/late.js' })).statusCode).toBe(404);
    objects['late.js'] = 'arrived';
    expect((await reader({ uri: '/late.js' })).statusCode).toBe(200);
  });

  it('close() resolves and is a no-op for an injected fetcher', async () => {
    const reader = createS3OriginReader('b', { fetchObject: mapFetcher({}) });
    await expect(reader.close()).resolves.toBeUndefined();
  });
});

describe('createS3OriginReader — error-page read failures are logged', () => {
  it('warns when the custom-error page itself is denied (not silently swallowed)', async () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    try {
      const reader = createS3OriginReader('b', {
        fetchObject: async () => ({ kind: 'denied' }),
      });
      const r = await reader({
        uri: '/route',
        customErrorResponses: [{ errorCode: 403, responsePagePath: '/index.html' }],
      });
      expect(r.statusCode).toBe(404);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('custom-error page'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
