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
    const passthrough = appendEnvFlags(
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
    const passthrough = appendEnvFlags(
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
    const passthrough = appendEnvFlags(args, { PRIVATE_KEY: pem }, new Set(['PRIVATE_KEY']));
    expect(args).toEqual(['-e', 'PRIVATE_KEY']);
    expect(passthrough['PRIVATE_KEY']).toBe(pem);
    expect(args.join(' ')).not.toContain('BEGIN KEY');
  });

  it('returns an empty map when no keys are sensitive', () => {
    const args: string[] = [];
    const passthrough = appendEnvFlags(args, { A: '1', B: '2' }, new Set());
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
