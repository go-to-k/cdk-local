import { describe, it, expect } from 'vite-plus/test';
import {
  appendEnvFlags,
  execEnvForSecrets,
  redactAwsCredentialsInArgs,
  SENSITIVE_ENV_KEYS,
} from '../../../src/local/docker-runner.js';

describe('appendEnvFlags', () => {
  it('routes sensitive keys through the value-less `-e KEY` form, others inline', () => {
    const args: string[] = [];
    const { passthrough } = appendEnvFlags(
      args,
      { AWS_SECRET_ACCESS_KEY: 'shh', TABLE_NAME: 'tbl', AWS_SESSION_TOKEN: 'tok' },
      SENSITIVE_ENV_KEYS
    );

    // Sensitive keys appear as `-e KEY` with NO value in argv.
    expect(args).toContain('-e');
    expect(args).toContain('AWS_SECRET_ACCESS_KEY');
    expect(args).toContain('AWS_SESSION_TOKEN');
    // No sensitive VALUE leaked into argv.
    expect(args.join(' ')).not.toContain('shh');
    expect(args.join(' ')).not.toContain('tok');
    // Non-sensitive keeps the inline form.
    expect(args).toContain('TABLE_NAME=tbl');
    // The passthrough map carries the sensitive values for the process env.
    expect(passthrough).toEqual({ AWS_SECRET_ACCESS_KEY: 'shh', AWS_SESSION_TOKEN: 'tok' });
  });

  it('supports an arbitrary sensitive-key set (e.g. ECS secret names)', () => {
    const args: string[] = [];
    const { passthrough } = appendEnvFlags(
      args,
      { DB_PASSWORD: 'p@ss', LOG_LEVEL: 'debug' },
      new Set(['DB_PASSWORD'])
    );
    expect(args).toEqual(['-e', 'DB_PASSWORD', '-e', 'LOG_LEVEL=debug']);
    expect(passthrough).toEqual({ DB_PASSWORD: 'p@ss' });
  });

  it('preserves multi-line values (e.g. PEM) — they never enter argv', () => {
    const pem = '-----BEGIN KEY-----\nABC\nDEF\n-----END KEY-----';
    const args: string[] = [];
    const { passthrough } = appendEnvFlags(args, { PRIVATE_KEY: pem }, new Set(['PRIVATE_KEY']));
    expect(args).toEqual(['-e', 'PRIVATE_KEY']);
    expect(passthrough['PRIVATE_KEY']).toBe(pem);
    expect(args.join(' ')).not.toContain('BEGIN KEY');
  });

  it('returns an empty map when no keys are sensitive', () => {
    const args: string[] = [];
    const { passthrough } = appendEnvFlags(args, { A: '1', B: '2' }, new Set());
    expect(args).toEqual(['-e', 'A=1', '-e', 'B=2']);
    expect(passthrough).toEqual({});
  });
});

describe('execEnvForSecrets', () => {
  it('returns no env option when there is nothing to pass through', () => {
    expect(execEnvForSecrets({})).toEqual({});
  });

  it('merges passthrough values onto the inherited process env', () => {
    const result = execEnvForSecrets({ AWS_SECRET_ACCESS_KEY: 'shh' });
    expect(result.env).toBeDefined();
    expect(result.env!['AWS_SECRET_ACCESS_KEY']).toBe('shh');
    // Inherits the parent environment so docker keeps PATH/HOME/etc.
    expect(result.env!['PATH']).toBe(process.env['PATH']);
  });
});

describe('redactAwsCredentialsInArgs', () => {
  it('redacts the inline `-e KEY=value` credential form (log defense)', () => {
    expect(
      redactAwsCredentialsInArgs(['-e', 'AWS_SECRET_ACCESS_KEY=xyz', '-e', 'FOO=bar'])
    ).toEqual(['-e', 'AWS_SECRET_ACCESS_KEY=***', '-e', 'FOO=bar']);
  });

  it('leaves the value-less `-e KEY` pass-through form untouched (already safe)', () => {
    expect(redactAwsCredentialsInArgs(['-e', 'AWS_SECRET_ACCESS_KEY', '-e', 'FOO=bar'])).toEqual([
      '-e',
      'AWS_SECRET_ACCESS_KEY',
      '-e',
      'FOO=bar',
    ]);
  });
});

// Issue #772: a sensitive key whose NAME is a variable the docker CLIENT (or
// the dynamic loader / a helper it execs) reads, or a malformed name, must not
// reach the client's spawn env. It gets NO `-e` flag either: a value-less
// `-e DOCKER_HOST` the spawn env refuses to set would make docker resolve it
// against its own environment and hand the container the HOST's value.
describe('appendEnvFlags docker-client / malformed key refusal (issue #772)', () => {
  const refused: Array<[family: string, key: string]> = [
    ['process', 'PATH'],
    ['connection', 'DOCKER_HOST'],
    ['config', 'DOCKER_CONFIG'],
    ['node', 'NODE_OPTIONS'],
    ['shell', 'BASH_ENV'],
    ['proxy', 'HTTPS_PROXY'],
    ['credential helper', 'AWS_ENDPOINT_URL'],
    ['podman', 'CONTAINER_HOST'],
    ['LD_ prefix', 'LD_PRELOAD'],
    ['DYLD_ prefix', 'DYLD_INSERT_LIBRARIES'],
    ['AWS_ENDPOINT_URL_ prefix', 'AWS_ENDPOINT_URL_ECR'],
    ['CLOUDSDK_ prefix', 'CLOUDSDK_PYTHON'],
    ['BASH_FUNC_ prefix', 'BASH_FUNC_docker%%'],
    ['case-insensitive', 'docker_host'],
    ['malformed: =', 'PATH=/tmp/evil:'],
    ['malformed: empty', ''],
    ['malformed: NUL', 'A\0B'],
  ];

  for (const [family, key] of refused) {
    it(`drops a sensitive ${family} key (${JSON.stringify(key)}) from argv and passthrough`, () => {
      const args: string[] = [];
      const { passthrough, collisions } = appendEnvFlags(
        args,
        { [key]: 's3cr3t-value', DB_PASSWORD: 'pw' },
        new Set([key, 'DB_PASSWORD'])
      );
      expect(collisions).toEqual([key]);
      expect(Object.hasOwn(passthrough, key)).toBe(false);
      expect(args).not.toContain(key);
      expect(args.join(' ')).not.toContain('s3cr3t-value');
      // The ordinary secret beside it is unaffected.
      expect(args).toEqual(['-e', 'DB_PASSWORD']);
      expect(passthrough).toEqual({ DB_PASSWORD: 'pw' });
    });
  }

  it('control: ordinary and near-miss secret names are forwarded as before', () => {
    const keys = [
      'DB_PASSWORD',
      'SSH_PRIVATE_KEY',
      'NODE_AUTH_TOKEN',
      'CLOUDSDK_AUTH_ACCESS_TOKEN',
      'MY_PATH',
      'A\nB',
      '__proto__',
    ];
    const env: Record<string, string> = {};
    for (const k of keys) Object.defineProperty(env, k, { value: `v-${k}`, enumerable: true, writable: true, configurable: true });
    const args: string[] = [];
    const { passthrough, collisions } = appendEnvFlags(args, env, new Set(keys));
    expect(collisions).toEqual([]);
    expect(Object.keys(passthrough)).toEqual(keys);
    for (const k of keys) expect(args).toContain(k);
  });

  it('control: a NON-sensitive key named like a client var stays inline (container env only)', () => {
    const args: string[] = [];
    const { passthrough, collisions } = appendEnvFlags(args, { PATH: '/app/bin' }, new Set());
    expect(args).toEqual(['-e', 'PATH=/app/bin']);
    expect(passthrough).toEqual({});
    expect(collisions).toEqual([]);
  });
});

describe('execEnvForSecrets docker-client / malformed key guard (issue #772)', () => {
  it('never lets a passthrough key override a docker-client var or add a malformed one', () => {
    const passthrough: Record<string, string> = {
      PATH: '/tmp/evil',
      DOCKER_HOST: 'tcp://evil:2375',
      LD_PRELOAD: '/tmp/evil.so',
      'PATH=/tmp/evil:': 'x',
      DB_PASSWORD: 'pw',
    };
    const result = execEnvForSecrets(passthrough);
    expect(result.env).toBeDefined();
    expect(result.env!['PATH']).toBe(process.env['PATH']);
    expect(result.env!['DOCKER_HOST']).toBe(process.env['DOCKER_HOST']);
    expect(result.env!['LD_PRELOAD']).toBe(process.env['LD_PRELOAD']);
    expect(Object.hasOwn(result.env!, 'PATH=/tmp/evil:')).toBe(false);
    expect(result.env!['DB_PASSWORD']).toBe('pw');
  });

  it('control: an ordinary passthrough key is still merged', () => {
    expect(execEnvForSecrets({ API_KEY: 'k' }).env!['API_KEY']).toBe('k');
  });
});
