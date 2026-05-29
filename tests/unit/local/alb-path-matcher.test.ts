import { describe, it, expect } from 'vite-plus/test';
import {
  albPathPatternMatches,
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
});
