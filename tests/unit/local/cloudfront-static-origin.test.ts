import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
  contentTypeForKey,
  resolveErrorResponseCandidates,
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

describe('resolveErrorResponseCandidates', () => {
  it('tries 403 before 404 and strips the leading slash, defaulting the response code', () => {
    const out = resolveErrorResponseCandidates([
      { errorCode: 404, responsePagePath: '/nf.html' },
      { errorCode: 403, responsePagePath: '/spa.html', responseCode: 200 },
    ]);
    expect(out).toEqual([
      { errorKey: 'spa.html', responseCode: 200 },
      { errorKey: 'nf.html', responseCode: 404 },
    ]);
  });

  it('skips entries with no responsePagePath, and is empty when none given', () => {
    expect(resolveErrorResponseCandidates([{ errorCode: 403 }])).toEqual([]);
    expect(resolveErrorResponseCandidates()).toEqual([]);
  });
});

// go-to-k/cdk-local#745: the origin DIRECTORY is contained, but `safeJoin`
// judges only the key's text and the read follows links, so a symlinked FILE
// inside the origin used to be served from anywhere on the host.
describe('serveFromStaticOrigin — symbolic links leaving the origin (#745)', () => {
  it('does not serve a file that is a symlink to a path outside the origin', () => {
    const origin = mkdtempSync(join(tmpdir(), 'cdkl-cf-link-origin-'));
    const outside = mkdtempSync(join(tmpdir(), 'cdkl-cf-link-victim-'));
    try {
      writeFileSync(join(outside, 'credentials'), 'SECRET');
      symlinkSync(join(outside, 'credentials'), join(origin, 'index.html'));
      mkdirSync(join(origin, 'ok'));
      writeFileSync(join(outside, 'inner.txt'), 'SECRET2');
      symlinkSync(outside, join(origin, 'escdir'));
      const r = serveFromStaticOrigin({ localDirs: [origin], uri: '/index.html', containLinks: true });
      expect(r.body.toString()).not.toContain('SECRET');
      expect(r.statusCode).not.toBe(200);
      const r2 = serveFromStaticOrigin({
        localDirs: [origin],
        uri: '/escdir/inner.txt',
        containLinks: true,
      });
      // An `--origin` override (no `containLinks`) is the user's own tree and
      // serves its links as before.
      const r3 = serveFromStaticOrigin({ localDirs: [origin], uri: '/index.html' });
      expect(r3.body.toString()).toBe('SECRET');
      expect(r2.body.toString()).not.toContain('SECRET2');
    } finally {
      rmSync(origin, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('still serves a symlink that stays inside the origin', () => {
    const origin = mkdtempSync(join(tmpdir(), 'cdkl-cf-link-inside-'));
    try {
      writeFileSync(join(origin, 'real.html'), '<h1>real</h1>');
      symlinkSync(join(origin, 'real.html'), join(origin, 'alias.html'));
      const r = serveFromStaticOrigin({
        localDirs: [origin],
        uri: '/alias.html',
        containLinks: true,
      });
      expect(r.statusCode).toBe(200);
      expect(r.body.toString()).toContain('real');
    } finally {
      rmSync(origin, { recursive: true, force: true });
    }
  });
});

describe('serveFromStaticOrigin — link containment on the error-response path and the warning (#745)', () => {
  it('does not serve an escaping error page, and warns once per file', async () => {
    const { getLogger } = await import('../../../src/utils/logger.js');
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const origin = mkdtempSync(join(tmpdir(), 'cdkl-cf-err-origin-'));
    const outside = mkdtempSync(join(tmpdir(), 'cdkl-cf-err-victim-'));
    try {
      writeFileSync(join(outside, 'credentials'), 'SECRET');
      symlinkSync(join(outside, 'credentials'), join(origin, 'index.html'));
      const request = () =>
        serveFromStaticOrigin({
          localDirs: [origin],
          uri: '/missing-route',
          containLinks: true,
          customErrorResponses: [
            { errorCode: 403, responseCode: 200, responsePagePath: '/index.html' },
          ],
        });
      expect(request().body.toString()).not.toContain('SECRET');
      expect(request().body.toString()).not.toContain('SECRET');
      const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => /Not serving/.test(l));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('credentials');
    } finally {
      warn.mockRestore();
      rmSync(origin, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// go-to-k/cdk-local#745 (#757): under an ACCEPTED absolute `--no-staging`
// folder — the user's own tree — hidden entries are not served; `.well-known`
// is. A staged origin (not listed in `hideDotfilesIn`) serves them as a
// deployed bucket would.
describe('serveFromStaticOrigin — hidden entries under an accepted absolute origin (#757)', () => {
  function site(): string {
    const d = mkdtempSync(join(tmpdir(), 'cdkl-cf-hidden-'));
    writeFileSync(join(d, '.env'), 'SECRET=1');
    mkdirSync(join(d, '.git'));
    writeFileSync(join(d, '.git', 'config'), 'url=https://token@example');
    mkdirSync(join(d, '.well-known'));
    writeFileSync(join(d, '.well-known', 'x'), 'WELLKNOWN');
    writeFileSync(join(d, 'index.html'), '<h1>ok</h1>');
    symlinkSync(join(d, '.env'), join(d, 'alias.txt'));
    return d;
  }

  it('refuses /.env, /.git/config and a link to .env; serves /.well-known/x and normal files; warns once', async () => {
    const { getLogger } = await import('../../../src/utils/logger.js');
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const d = site();
    try {
      const serve = (uri: string) =>
        serveFromStaticOrigin({ localDirs: [d], uri, containLinks: true, hideDotfilesIn: [d] });
      expect(serve('/.env').body.toString()).not.toContain('SECRET');
      expect(serve('/.env').body.toString()).not.toContain('SECRET');
      expect(serve('/.git/config').body.toString()).not.toContain('token');
      expect(serve('/alias.txt').body.toString()).not.toContain('SECRET');
      expect(serve('/.well-known/x').body.toString()).toBe('WELLKNOWN');
      expect(serve('/index.html').body.toString()).toContain('ok');
      const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => /hidden entry/.test(l));
      expect(lines.filter((l) => l.includes("'.env'"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('a staged origin (not in hideDotfilesIn) still serves hidden files', () => {
    const d = site();
    try {
      const r = serveFromStaticOrigin({ localDirs: [d], uri: '/.env', containLinks: true });
      expect(r.body.toString()).toContain('SECRET');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
