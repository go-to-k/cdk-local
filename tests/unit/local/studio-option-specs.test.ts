import { describe, it, expect } from 'vite-plus/test';
import {
  buildPerRunArgs,
  resolveEnvVars,
  OPTION_SPECS,
} from '../../../src/local/studio-option-specs.js';

describe('buildPerRunArgs', () => {
  it('returns no args for undefined / empty values', () => {
    expect(buildPerRunArgs('alb', undefined)).toEqual([]);
    expect(buildPerRunArgs('alb', {})).toEqual([]);
  });

  it('emits a boolean flag only when true', () => {
    expect(buildPerRunArgs('alb', { '--tls': true })).toEqual(['--tls']);
    expect(buildPerRunArgs('alb', { '--tls': false })).toEqual([]);
  });

  it('emits a scalar with its value, trimmed; omits blank', () => {
    expect(buildPerRunArgs('ecs', { '--max-tasks': '3' })).toEqual(['--max-tasks', '3']);
    expect(buildPerRunArgs('ecs', { '--max-tasks': '  ' })).toEqual([]);
  });

  it('drops a showWhen-gated scalar unless its gate boolean is on', () => {
    // --tls-cert is gated on --tls.
    expect(buildPerRunArgs('alb', { '--tls-cert': './c.pem' })).toEqual([]);
    expect(buildPerRunArgs('alb', { '--tls': true, '--tls-cert': './c.pem' })).toEqual([
      '--tls',
      '--tls-cert',
      './c.pem',
    ]);
  });

  it('emits one flag per non-blank repeat-pair row, joined by sep', () => {
    expect(
      buildPerRunArgs('ecs', {
        '--host-port': [
          { left: '80', right: '8080' },
          { left: '', right: '' },
          { left: '443', right: '8443' },
        ],
      })
    ).toEqual(['--host-port', '80=8080', '--host-port', '443=8443']);
  });

  it('throws on a partially-filled repeat-pair row', () => {
    expect(() => buildPerRunArgs('ecs', { '--host-port': [{ left: '80', right: '' }] })).toThrow(
      /need both sides/
    );
  });

  it('throws on an unknown flag for the kind', () => {
    expect(() => buildPerRunArgs('ecs', { '--tls': true })).toThrow(/Unknown option/);
  });

  it('builds AgentCore args: boolean flags + scalar values (env-vars materialized separately)', () => {
    expect(
      buildPerRunArgs('agentcore', {
        '--ws': true,
        '--sigv4': false,
        '--bearer-token': '  eyJabc  ',
        '--session-id': 'sess-1',
        '--env-vars': [{ left: 'K', right: 'V' }],
      })
    ).toEqual(['--ws', '--bearer-token', 'eyJabc', '--session-id', 'sess-1']);
  });

  it('emits NO direct arg for env-kv (materialized separately)', () => {
    expect(buildPerRunArgs('lambda', { '--env-vars': [{ left: 'K', right: 'V' }] })).toEqual([]);
    expect(buildPerRunArgs('lambda', { '--env-vars': '{"K":"V"}' })).toEqual([]);
    // The alb / ecs serve kinds now declare --env-vars too (issue #355); it is
    // likewise materialized into a file, not emitted as a direct arg.
    expect(buildPerRunArgs('alb', { '--env-vars': [{ left: 'K', right: 'V' }] })).toEqual([]);
    expect(buildPerRunArgs('ecs', { '--env-vars': [{ left: 'K', right: 'V' }] })).toEqual([]);
  });
});

describe('resolveEnvVars', () => {
  it('returns undefined when there is no env-kv option / value', () => {
    expect(resolveEnvVars('alb', { '--tls': true })).toBeUndefined();
    expect(resolveEnvVars('lambda', {})).toBeUndefined();
    expect(resolveEnvVars('lambda', { '--env-vars': [] })).toBeUndefined();
  });

  it('wraps KV rows in { Parameters: {...} } (one-level nesting)', () => {
    expect(
      resolveEnvVars('lambda', {
        '--env-vars': [
          { left: 'LOG_LEVEL', right: 'debug' },
          { left: '', right: 'ignored' },
          { left: 'TABLE', right: 'my-table' },
        ],
      })
    ).toEqual({ Parameters: { LOG_LEVEL: 'debug', TABLE: 'my-table' } });
  });

  it('resolves env-kv for the alb / ecs serve kinds too (issue #355)', () => {
    // start-alb / start-service accept --env-vars (overlay the backing ECS
    // task container env); the serve kinds gained the env-kv spec, so the same
    // Parameters-form materialization applies — start-service / start-alb then
    // overlay Parameters onto every container.
    expect(resolveEnvVars('alb', { '--env-vars': [{ left: 'API_KEY', right: 'abc' }] })).toEqual({
      Parameters: { API_KEY: 'abc' },
    });
    expect(resolveEnvVars('ecs', { '--env-vars': [{ left: 'STAGE', right: 'local' }] })).toEqual({
      Parameters: { STAGE: 'local' },
    });
    expect(resolveEnvVars('ecs', { '--env-vars': '{ "Parameters": { "X": "1" } }' })).toEqual({
      Parameters: { X: '1' },
    });
  });

  it('wraps a flat JSON object in Parameters', () => {
    expect(resolveEnvVars('lambda', { '--env-vars': '{ "A": "1", "B": "2" }' })).toEqual({
      Parameters: { A: '1', B: '2' },
    });
  });

  it('uses a full SAM-shape JSON object as-is (has Parameters)', () => {
    const sam = '{ "Parameters": { "A": "1" }, "MyFn": { "B": "2" } }';
    expect(resolveEnvVars('lambda', { '--env-vars': sam })).toEqual({
      Parameters: { A: '1' },
      MyFn: { B: '2' },
    });
  });

  it('uses a JSON object with a nested per-logical-id map as-is', () => {
    const sam = '{ "MyFn": { "B": "2" } }';
    expect(resolveEnvVars('lambda', { '--env-vars': sam })).toEqual({ MyFn: { B: '2' } });
  });

  it('throws on malformed JSON / a non-object', () => {
    expect(() => resolveEnvVars('lambda', { '--env-vars': '{not json' })).toThrow(/not valid JSON/);
    expect(() => resolveEnvVars('lambda', { '--env-vars': '"a string"' })).toThrow(/must be a JSON object/);
    expect(() => resolveEnvVars('lambda', { '--env-vars': '[1,2]' })).toThrow(/must be a JSON object/);
  });

  it('treats an all-blank-keys KV array as no env vars', () => {
    expect(resolveEnvVars('lambda', { '--env-vars': [{ left: '', right: 'v' }] })).toBeUndefined();
  });

  it('materializes AgentCore env-vars the same way (KV rows -> Parameters)', () => {
    expect(
      resolveEnvVars('agentcore', { '--env-vars': [{ left: 'MODEL', right: 'claude' }] })
    ).toEqual({ Parameters: { MODEL: 'claude' } });
  });
});

describe('OPTION_SPECS table', () => {
  it('declares per-target options for the runnable kinds', () => {
    expect(OPTION_SPECS.lambda?.map((s) => s.flag)).toEqual(['--env-vars']);
    expect(OPTION_SPECS.alb?.map((s) => s.flag)).toContain('--tls');
    // alb + ecs gained an --env-vars env-kv option (issue #355).
    expect(OPTION_SPECS.alb?.map((s) => s.flag)).toContain('--env-vars');
    expect(OPTION_SPECS.ecs?.map((s) => s.flag)).toEqual(['--max-tasks', '--host-port', '--env-vars']);
    expect(OPTION_SPECS.agentcore?.map((s) => s.flag)).toEqual([
      '--ws',
      '--sigv4',
      '--bearer-token',
      '--session-id',
      '--env-vars',
    ]);
  });
});
