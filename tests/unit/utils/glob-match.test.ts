import { describe, it, expect } from 'vite-plus/test';
import { createGlobMatcher } from '../../../src/utils/glob-match.js';

describe('createGlobMatcher', () => {
  it('matches everything for `**`', () => {
    const m = createGlobMatcher(['**']);
    expect(m('a')).toBe(true);
    expect(m('a/b/c')).toBe(true);
    expect(m('')).toBe(true);
  });

  it('never matches for an empty pattern list', () => {
    const m = createGlobMatcher([]);
    expect(m('a')).toBe(false);
    expect(m('a/b')).toBe(false);
  });

  it('treats a slash-free pattern as a basename match at any depth', () => {
    const m = createGlobMatcher(['node_modules']);
    expect(m('node_modules')).toBe(true);
    expect(m('node_modules/x/y')).toBe(true);
    expect(m('a/node_modules')).toBe(true);
    expect(m('a/b/node_modules/c')).toBe(true);
  });

  it('does not match a partial segment (loop-safety for prefixed names)', () => {
    const m = createGlobMatcher(['node_modules']);
    expect(m('node_modules_foo')).toBe(false);
    expect(m('a/node_modules_foo/b')).toBe(false);
  });

  it('matches a directory pattern AND its contents', () => {
    const m = createGlobMatcher(['cdk.out']);
    expect(m('cdk.out')).toBe(true);
    expect(m('cdk.out/asset.123/index.js')).toBe(true);
    // The dot is a literal, not a regex wildcard.
    expect(m('cdkXout')).toBe(false);
  });

  it('honors `*` (single segment) without crossing slashes', () => {
    const m = createGlobMatcher(['*.test.ts']);
    expect(m('foo.test.ts')).toBe(true);
    expect(m('a/b/foo.test.ts')).toBe(true);
    expect(m('foo.ts')).toBe(false);
    expect(m('footest.ts')).toBe(false);
  });

  it('honors `**/` (zero or more leading segments)', () => {
    const m = createGlobMatcher(['**/*.d.ts']);
    expect(m('a.d.ts')).toBe(true);
    expect(m('src/types/a.d.ts')).toBe(true);
    expect(m('a.ts')).toBe(false);
  });

  it('honors `/**` (everything under a directory)', () => {
    const m = createGlobMatcher(['src/**']);
    expect(m('src/a')).toBe(true);
    expect(m('src/a/b/c')).toBe(true);
    expect(m('srcfoo/a')).toBe(false);
  });

  it('honors `?` (single character, not a slash)', () => {
    const m = createGlobMatcher(['a?c']);
    expect(m('abc')).toBe(true);
    expect(m('ac')).toBe(false);
    expect(m('a/c')).toBe(false);
  });

  it('normalizes Windows separators in both pattern and path', () => {
    const m = createGlobMatcher(['src\\lambda']);
    expect(m('src/lambda')).toBe(true);
    expect(m('src\\lambda')).toBe(true);
  });

  it('matches if ANY pattern in the list matches', () => {
    const m = createGlobMatcher(['*.md', 'cdk*.json']);
    expect(m('README.md')).toBe(true);
    expect(m('cdk.json')).toBe(true);
    expect(m('cdk.context.json')).toBe(true);
    expect(m('index.ts')).toBe(false);
  });
});
