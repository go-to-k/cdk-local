import { afterEach, describe, expect, it } from 'vite-plus/test';
import { resetEmbedConfig } from '../../../src/local/embed-config.js';
import { userCacheHome } from '../../../src/utils/cache-home.js';

/**
 * `userCacheHome` (#867) places host-side caches a container later EXECUTES
 * (the Lambda RIE), so it never resolves against the cwd or the shared temp
 * root: no answer beats a plantable one.
 */
describe('userCacheHome', () => {
  afterEach(() => resetEmbedConfig());

  it('uses an absolute XDG_CACHE_HOME', () => {
    expect(userCacheHome({ XDG_CACHE_HOME: '/x/cache' }, () => '/h')).toBe('/x/cache/cdk-local');
  });

  it('ignores a relative XDG_CACHE_HOME and falls back to ~/.cache', () => {
    expect(userCacheHome({ XDG_CACHE_HOME: 'rel' }, () => '/h')).toBe('/h/.cache/cdk-local');
    expect(userCacheHome({}, () => '/h')).toBe('/h/.cache/cdk-local');
  });

  it.each([
    ['an empty HOME', () => ''],
    ['a relative HOME', () => 'rel'],
    [
      'a HOME that cannot be determined',
      () => {
        throw new Error('no home');
      },
    ],
  ])('answers undefined for %s', (_label, home) => {
    expect(userCacheHome({}, home)).toBeUndefined();
  });
});
