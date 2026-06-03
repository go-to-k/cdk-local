import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  contentTypeForKey,
  safeJoin,
  serveFromStaticOrigin,
  uriToKey,
} from '../../../src/local/cloudfront-static-origin.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cdkl-cf-origin-'));
  writeFileSync(join(dir, 'index.html'), '<h1>root</h1>');
  mkdirSync(join(dir, 'foo'), { recursive: true });
  writeFileSync(join(dir, 'foo', 'index.html'), '<h1>foo</h1>');
  writeFileSync(join(dir, 'app.js'), 'console.log(1)');
  writeFileSync(join(dir, 'error.html'), '<h1>spa</h1>');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('serveFromStaticOrigin', () => {
  it('serves the default root object at /', () => {
    const r = serveFromStaticOrigin({ localDirs: [dir], uri: '/', defaultRootObject: 'index.html' });
    expect(r.statusCode).toBe(200);
    expect(r.body.toString()).toContain('root');
    expect(r.headers['content-type']).toContain('text/html');
  });

  it('serves an exact key with the right content type', () => {
    const r = serveFromStaticOrigin({ localDirs: [dir], uri: '/app.js' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('javascript');
  });

  it('serves a key the viewer-request function rewrote (/foo/index.html)', () => {
    const r = serveFromStaticOrigin({ localDirs: [dir], uri: '/foo/index.html' });
    expect(r.statusCode).toBe(200);
    expect(r.body.toString()).toContain('foo');
  });

  it('does NOT auto-index a sub-path (/foo) — CloudFront leaves that to a function', () => {
    const r = serveFromStaticOrigin({ localDirs: [dir], uri: '/foo' });
    expect(r.statusCode).toBe(404);
  });

  it('applies a 403 CustomErrorResponses page (SPA fallback) for a missing key', () => {
    const r = serveFromStaticOrigin({
      localDirs: [dir],
      uri: '/does-not-exist',
      customErrorResponses: [{ errorCode: 403, responseCode: 200, responsePagePath: '/error.html' }],
    });
    expect(r.statusCode).toBe(200);
    expect(r.body.toString()).toContain('spa');
  });

  it('returns a plain 404 with no matching custom-error page', () => {
    const r = serveFromStaticOrigin({ localDirs: [dir], uri: '/missing' });
    expect(r.statusCode).toBe(404);
    expect(r.headers['content-type']).toContain('text/plain');
  });

  it('searches multiple dirs in order (first hit wins)', () => {
    const second = mkdtempSync(join(tmpdir(), 'cdkl-cf-origin2-'));
    writeFileSync(join(second, 'only-in-second.txt'), 'second');
    try {
      const r = serveFromStaticOrigin({ localDirs: [dir, second], uri: '/only-in-second.txt' });
      expect(r.statusCode).toBe(200);
      expect(r.body.toString()).toBe('second');
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });

  it('refuses a path-traversal key', () => {
    const r = serveFromStaticOrigin({ localDirs: [dir], uri: '/../../etc/passwd' });
    expect(r.statusCode).toBe(404);
  });
});

describe('uriToKey', () => {
  it('drops query and fragment, strips leading slash', () => {
    expect(uriToKey('/a/b.html?x=1#frag')).toBe('a/b.html');
  });
  it('maps root to the default root object', () => {
    expect(uriToKey('/', 'index.html')).toBe('index.html');
  });
});

describe('safeJoin', () => {
  it('rejects escapes', () => {
    expect(safeJoin('/srv/site', '../secret')).toBeUndefined();
  });
  it('accepts an in-tree key', () => {
    expect(safeJoin('/srv/site', 'a/b.html')).toBe('/srv/site/a/b.html');
  });
});

describe('contentTypeForKey', () => {
  it('maps known extensions', () => {
    expect(contentTypeForKey('x.css')).toContain('text/css');
    expect(contentTypeForKey('x.svg')).toBe('image/svg+xml');
  });
  it('falls back to octet-stream', () => {
    expect(contentTypeForKey('x.unknownext')).toBe('application/octet-stream');
    expect(contentTypeForKey('noext')).toBe('application/octet-stream');
  });
});
