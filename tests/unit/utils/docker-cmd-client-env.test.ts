import { describe, it, expect } from 'vite-plus/test';
import {
  DOCKER_CLIENT_ENV_KEYS,
  DOCKER_CLIENT_ENV_PREFIXES,
  DOCKER_CLIENT_ENV_PREFIX_EXEMPTIONS,
  isDockerClientEnvKey,
  isMalformedEnvKey,
} from '../../../src/utils/docker-cmd.js';
import { SENSITIVE_ENV_KEYS } from '../../../src/local/docker-runner.js';

// Issue #772: the key-name guard ported from cdkd's `src/utils/docker-cmd.ts`.
describe('isDockerClientEnvKey (issue #772)', () => {
  it.each([
    'PATH',
    'PATHEXT',
    'HOME',
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_CONFIG',
    'DOCKER_CERT_PATH',
    'DOCKER_TLS_VERIFY',
    'GLIBC_TUNABLES',
    'GCONV_PATH',
    'BASH_ENV',
    'SHELLOPTS',
    'PS4',
    'PYTHONPATH',
    'NODE_OPTIONS',
    'NODE_EXTRA_CA_CERTS',
    'RUBYOPT',
    'PERL5OPT',
    'OPENSSL_CONF',
    'SSH_AUTH_SOCK',
    'SSH_ASKPASS',
    'AWS_ENDPOINT_URL',
    'AWS_PROFILE',
    'AWS_ECR_CACHE_DIR',
    'CONTAINER_HOST',
    'CONTAINERS_CONF',
    'REGISTRY_AUTH_FILE',
    'XDG_RUNTIME_DIR',
    'SSH',
    'CONTAINERD_ADDRESS',
    'CNI_PATH',
    'SSL_CERT_FILE',
    'GODEBUG',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'ALL_PROXY',
  ])('refuses the exact name %s', (key) => {
    expect(isDockerClientEnvKey(key)).toBe(true);
  });

  it.each([
    ['LD_', 'LD_PRELOAD'],
    ['LD_', 'LD_LIBRARY_PATH'],
    ['LD_', 'LD_ANYTHING_NEW'],
    ['DYLD_', 'DYLD_INSERT_LIBRARIES'],
    ['DYLD_', 'DYLD_ROOT_PATH'],
    ['AWS_ENDPOINT_URL_', 'AWS_ENDPOINT_URL_ECR'],
    ['CLOUDSDK_', 'CLOUDSDK_PYTHON'],
    ['BASH_FUNC_', 'BASH_FUNC_docker%%'],
  ])('refuses the %s prefix family (%s)', (_prefix, key) => {
    expect(isDockerClientEnvKey(key)).toBe(true);
  });

  it.each(['path', 'docker_host', 'Https_Proxy', 'ld_preload', 'dyld_insert_libraries'])(
    'matches case-insensitively (%s)',
    (key) => {
      expect(isDockerClientEnvKey(key)).toBe(true);
    }
  );

  it.each([
    'DB_PASSWORD',
    'API_KEY',
    'SSH_PRIVATE_KEY',
    'NODE_AUTH_TOKEN',
    'RUBYGEMS_API_KEY',
    'CLOUDSDK_AUTH_ACCESS_TOKEN',
    'MY_PATH',
    'PATH_SUFFIX',
    'DOCKER_HOSTNAME_LABEL',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    '__proto__',
  ])('control: forwards the ordinary name %s', (key) => {
    expect(isDockerClientEnvKey(key)).toBe(false);
  });

  it('pins the prefix families and the one exemption', () => {
    expect([...DOCKER_CLIENT_ENV_PREFIXES]).toEqual([
      'LD_',
      'DYLD_',
      'AWS_ENDPOINT_URL_',
      'CLOUDSDK_',
      'BASH_FUNC_',
    ]);
    expect([...DOCKER_CLIENT_ENV_PREFIX_EXEMPTIONS]).toEqual(['CLOUDSDK_AUTH_ACCESS_TOKEN']);
  });

  it('never exempts an exact denylist member', () => {
    for (const k of DOCKER_CLIENT_ENV_PREFIX_EXEMPTIONS) {
      expect(DOCKER_CLIENT_ENV_KEYS.has(k)).toBe(false);
    }
  });

  it('keeps the AWS credential passthrough set disjoint from the denylist', () => {
    // The metadata sidecar and every container forward these three through the
    // spawn env; a future addition to either set must not silently drop them.
    for (const k of SENSITIVE_ENV_KEYS) expect(isDockerClientEnvKey(k)).toBe(false);
  });
});

describe('isMalformedEnvKey (issue #772)', () => {
  it.each([
    ['empty', ''],
    ['contains =', 'PATH=/tmp/evil:'],
    ['leading =', '=x'],
    ['contains NUL', 'A\0B'],
  ])('refuses a %s name', (_label, key) => {
    expect(isMalformedEnvKey(key)).toBe(true);
  });

  it.each(['DB_PASSWORD', 'A\nB', '__proto__', 'x'])('control: accepts %j', (key) => {
    expect(isMalformedEnvKey(key)).toBe(false);
  });
});
