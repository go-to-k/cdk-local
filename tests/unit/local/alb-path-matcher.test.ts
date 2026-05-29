import { describe, it, expect } from 'vite-plus/test';
import {
  albPathPatternMatches,
  albHostPatternMatches,
  matchAlbPathRule,
  type AlbPathRule,
} from '../../../src/local/alb-path-matcher.js';

describe('albPathPatternMatches', () => {
  it('matches an exact literal path', () => {
    expect(albPathPatternMatches('/health', '/health')).toBe(true);
    expect(albPathPatternMatches('/health', '/healthz')).toBe(false);
    expect(albPathPatternMatches('/health', '/health/')).toBe(false);
  });

  it('treats * as zero-or-more characters, including slashes', () => {
    expect(albPathPatternMatches('/api/*', '/api/')).toBe(true);
    expect(albPathPatternMatches('/api/*', '/api/v1/users')).toBe(true);
    expect(albPathPatternMatches('/api/*', '/api')).toBe(false); // needs the trailing slash + 0 chars
    expect(albPathPatternMatches('/api*', '/api')).toBe(true); // 0 chars after the prefix
    expect(albPathPatternMatches('*', '/anything/at/all')).toBe(true);
  });

  it('treats ? as exactly one character', () => {
    expect(albPathPatternMatches('/img?', '/imgs')).toBe(true);
    expect(albPathPatternMatches('/img?', '/img')).toBe(false);
    expect(albPathPatternMatches('/img?', '/imgss')).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(albPathPatternMatches('/API/*', '/api/x')).toBe(false);
    expect(albPathPatternMatches('/API/*', '/API/x')).toBe(true);
  });

  it('matches the path only, ignoring the query string', () => {
    expect(albPathPatternMatches('/search', '/search?q=hello')).toBe(true);
    expect(albPathPatternMatches('/search', '/search#frag')).toBe(true);
  });

  it('escapes regex metacharacters in the literal portion', () => {
    expect(albPathPatternMatches('/a.b', '/a.b')).toBe(true);
    expect(albPathPatternMatches('/a.b', '/axb')).toBe(false); // '.' is literal, not "any char"
  });
});

describe('albHostPatternMatches', () => {
  it('matches a literal host case-insensitively', () => {
    expect(albHostPatternMatches('api.example.com', 'api.example.com')).toBe(true);
    expect(albHostPatternMatches('api.example.com', 'API.EXAMPLE.COM')).toBe(true);
    expect(albHostPatternMatches('API.example.com', 'api.example.com')).toBe(true);
    expect(albHostPatternMatches('api.example.com', 'web.example.com')).toBe(false);
  });

  it('strips the :port suffix from the request host before matching', () => {
    expect(albHostPatternMatches('api.example.com', 'api.example.com:8080')).toBe(true);
    expect(albHostPatternMatches('api.example.com', 'api.example.com:443')).toBe(true);
  });

  it('treats * / ? as wildcards (subdomain / single-char)', () => {
    expect(albHostPatternMatches('*.example.com', 'api.example.com')).toBe(true);
    expect(albHostPatternMatches('*.example.com', 'a.b.example.com')).toBe(true);
    expect(albHostPatternMatches('*.example.com', 'example.com')).toBe(false); // needs a subdomain
    expect(albHostPatternMatches('img?.example.com', 'img1.example.com')).toBe(true);
    expect(albHostPatternMatches('img?.example.com', 'img.example.com')).toBe(false);
  });

  it('escapes the literal dots (not "any char")', () => {
    expect(albHostPatternMatches('a.example.com', 'axexample.com')).toBe(false);
  });

  it('strips the port from an IPv6 literal host', () => {
    expect(albHostPatternMatches('[::1]', '[::1]:8080')).toBe(true);
  });
});

describe('matchAlbPathRule', () => {
  const rules: AlbPathRule<string>[] = [
    { priority: 20, pathPatterns: ['/api/*'], target: 'api' },
    { priority: 10, pathPatterns: ['/api/admin/*'], target: 'admin' },
    { priority: 30, pathPatterns: ['/static/*', '/assets/*'], target: 'static' },
  ];

  it('returns the highest-priority (lowest number) matching rule', () => {
    // Both /api/admin/* (priority 10) and /api/* (priority 20) match; 10 wins.
    expect(matchAlbPathRule('/api/admin/users', rules)).toBe('admin');
    expect(matchAlbPathRule('/api/orders', rules)).toBe('api');
  });

  it('evaluates priority irrespective of input order', () => {
    const shuffled = [rules[1]!, rules[2]!, rules[0]!];
    expect(matchAlbPathRule('/api/admin/x', shuffled)).toBe('admin');
  });

  it('OR-matches a rule with multiple path-pattern values', () => {
    expect(matchAlbPathRule('/static/app.js', rules)).toBe('static');
    expect(matchAlbPathRule('/assets/logo.png', rules)).toBe('static');
  });

  it('returns undefined when no rule matches (caller uses the default)', () => {
    expect(matchAlbPathRule('/', rules)).toBeUndefined();
    expect(matchAlbPathRule('/health', rules)).toBeUndefined();
  });

  it('strips the query string before matching', () => {
    expect(matchAlbPathRule('/api/orders?page=2', rules)).toBe('api');
  });

  it('accepts a bare path string (path-only form, no Host)', () => {
    expect(matchAlbPathRule('/api/orders', rules)).toBe('api');
  });
});

describe('matchAlbPathRule with host-header conditions', () => {
  const rules: AlbPathRule<string>[] = [
    // host-only rule
    { priority: 10, pathPatterns: [], hostPatterns: ['api.example.com'], target: 'api-host' },
    // host AND path rule (both must match)
    {
      priority: 5,
      pathPatterns: ['/admin/*'],
      hostPatterns: ['api.example.com'],
      target: 'api-admin',
    },
    // path-only rule
    { priority: 30, pathPatterns: ['/static/*'], target: 'static' },
  ];

  it('matches a host-only rule against the Host header', () => {
    expect(matchAlbPathRule({ path: '/anything', host: 'api.example.com' }, rules)).toBe('api-host');
  });

  it('matches the AND rule only when both host and path match (priority 5 wins)', () => {
    expect(matchAlbPathRule({ path: '/admin/users', host: 'api.example.com' }, rules)).toBe(
      'api-admin'
    );
    // Path matches the AND rule but host does not -> falls to no match (no other rule fits).
    expect(matchAlbPathRule({ path: '/admin/users', host: 'web.example.com' }, rules)).toBeUndefined();
  });

  it('does not match a host-constrained rule when no Host header is present', () => {
    expect(matchAlbPathRule({ path: '/anything' }, rules)).toBeUndefined();
    // A path-only rule still matches without a Host header.
    expect(matchAlbPathRule({ path: '/static/app.js' }, rules)).toBe('static');
  });

  it('matches the Host header case-insensitively and ignores the :port', () => {
    expect(matchAlbPathRule({ path: '/', host: 'API.EXAMPLE.COM:8080' }, rules)).toBe('api-host');
  });
});
