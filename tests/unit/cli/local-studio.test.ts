import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vite-plus/test';
import {
  applyConfigPatch,
  coerceRunRequest,
  coerceStopRequest,
  coerceServeRequest,
  coerceReinvokeRequest,
  resolveServeBaseUrl,
  createLocalStudioCommand,
  parseStudioPort,
  resolveBootAssemblyDir,
  type EditableSessionBindings,
} from '../../../src/cli/commands/local-studio.js';
import type { StudioServeState } from '../../../src/local/studio-serve-manager.js';

describe('createLocalStudioCommand', () => {
  it('is named "studio"', () => {
    expect(createLocalStudioCommand().name()).toBe('studio');
  });

  it('exposes --studio-port (default 9999) and --no-open', () => {
    const cmd = createLocalStudioCommand();
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain('--studio-port');
    expect(longs).toContain('--no-open');
    const portOpt = cmd.options.find((o) => o.long === '--studio-port');
    expect(portOpt?.defaultValue).toBe('9999');
  });

  it('exposes --include-custom-resources (boolean, default false)', () => {
    const cmd = createLocalStudioCommand();
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain('--include-custom-resources');
    const opt = cmd.options.find((o) => o.long === '--include-custom-resources');
    // A bare boolean flag has no default value set => undefined (falsy).
    expect(opt?.defaultValue).toBeUndefined();
  });
});

describe('parseStudioPort', () => {
  it('accepts a valid port', () => {
    expect(parseStudioPort('9999')).toBe(9999);
  });

  it('accepts 0 (OS-assigned)', () => {
    expect(parseStudioPort('0')).toBe(0);
  });

  it('accepts the upper bound 65535', () => {
    expect(parseStudioPort('65535')).toBe(65535);
  });

  it.each(['-1', '65536', 'abc', '', '80.5'])('rejects %p', (raw) => {
    expect(() => parseStudioPort(raw)).toThrow(/--studio-port must be 0\.\.65535/);
  });
});

describe('coerceRunRequest', () => {
  it('accepts a well-formed run request', () => {
    expect(coerceRunRequest({ targetId: 'Stack/Fn', kind: 'lambda', event: { a: 1 } })).toEqual({
      targetId: 'Stack/Fn',
      kind: 'lambda',
      event: { a: 1 },
    });
  });

  it('allows an absent event (undefined)', () => {
    expect(coerceRunRequest({ targetId: 'T', kind: 'lambda' })).toEqual({
      targetId: 'T',
      kind: 'lambda',
      event: undefined,
    });
  });

  it.each([null, 42, 'str', undefined])('rejects a non-object body %p', (body) => {
    expect(() => coerceRunRequest(body)).toThrow(/must be a JSON object/);
  });

  it.each([{}, { targetId: '' }, { targetId: '  ', kind: 'lambda' }, { kind: 'lambda' }])(
    'rejects a missing/empty targetId %p',
    (body) => {
      expect(() => coerceRunRequest(body)).toThrow(/non-empty "targetId"/);
    }
  );

  it.each([{ targetId: 'T' }, { targetId: 'T', kind: 'nope' }, { targetId: 'T', kind: 5 }])(
    'rejects a missing/unknown kind %p',
    (body) => {
      expect(() => coerceRunRequest(body)).toThrow(/"kind" must be one of/);
    }
  );

  it('accepts + passes through valid per-run options', () => {
    expect(
      coerceRunRequest({
        targetId: 'T',
        kind: 'alb',
        options: { '--tls': true, '--lb-port': [{ left: '443', right: '8443' }] },
      })
    ).toEqual({
      targetId: 'T',
      kind: 'alb',
      event: undefined,
      options: { '--tls': true, '--lb-port': [{ left: '443', right: '8443' }] },
    });
  });

  it.each([null, 42, 'str', [1, 2]])('rejects non-object options %p', (options) => {
    expect(() => coerceRunRequest({ targetId: 'T', kind: 'alb', options })).toThrow(
      /"options" must be a JSON object/
    );
  });

  it('rejects an unknown option flag for the kind (clean 400 at the boundary)', () => {
    expect(() =>
      coerceRunRequest({ targetId: 'T', kind: 'ecs', options: { '--tls': true } })
    ).toThrow(/Unknown option/);
  });

  it('rejects malformed env-vars JSON at the boundary', () => {
    expect(() =>
      coerceRunRequest({ targetId: 'T', kind: 'lambda', options: { '--env-vars': '{bad' } })
    ).toThrow(/not valid JSON/);
  });

  it('threads a well-formed rawArgs string through', () => {
    expect(
      coerceRunRequest({ targetId: 'T', kind: 'api', rawArgs: '--warm --port 9000' })
    ).toEqual({ targetId: 'T', kind: 'api', event: undefined, rawArgs: '--warm --port 9000' });
  });

  it('rejects a non-string rawArgs', () => {
    expect(() =>
      coerceRunRequest({ targetId: 'T', kind: 'api', rawArgs: ['--warm'] })
    ).toThrow(/"rawArgs" must be a string/);
  });

  it('rejects rawArgs with an unterminated quote at the boundary', () => {
    expect(() =>
      coerceRunRequest({ targetId: 'T', kind: 'api', rawArgs: '--name "oops' })
    ).toThrow(/unterminated/i);
  });

  it('threads a well-formed imageOverride string through', () => {
    expect(
      coerceRunRequest({ targetId: 'Stack/Svc', kind: 'ecs', imageOverride: './Dockerfile' })
    ).toEqual({
      targetId: 'Stack/Svc',
      kind: 'ecs',
      event: undefined,
      imageOverride: './Dockerfile',
    });
  });

  it('omits a blank imageOverride', () => {
    expect(coerceRunRequest({ targetId: 'Stack/Svc', kind: 'ecs', imageOverride: '   ' })).toEqual({
      targetId: 'Stack/Svc',
      kind: 'ecs',
      event: undefined,
    });
  });

  it('rejects a non-string imageOverride', () => {
    expect(() =>
      coerceRunRequest({ targetId: 'Stack/Svc', kind: 'ecs', imageOverride: 42 })
    ).toThrow(/"imageOverride" must be a string/);
  });

  it('accepts an agentcore request with its per-run options', () => {
    expect(
      coerceRunRequest({
        targetId: 'Stack/Agent',
        kind: 'agentcore',
        event: { prompt: 'hi' },
        options: { '--ws': true, '--bearer-token': 'eyJ' },
      })
    ).toEqual({
      targetId: 'Stack/Agent',
      kind: 'agentcore',
      event: { prompt: 'hi' },
      options: { '--ws': true, '--bearer-token': 'eyJ' },
    });
  });
});

describe('applyConfigPatch', () => {
  it('sets a named from-cfn-stack + an assume-role ARN', () => {
    const cfg: EditableSessionBindings = {};
    applyConfigPatch({ fromCfnStack: 'MyStack', assumeRole: 'arn:aws:iam::1:role/r' }, cfg);
    expect(cfg).toEqual({ fromCfnStack: 'MyStack', assumeRole: 'arn:aws:iam::1:role/r' });
  });

  it('sets a bare from-cfn-stack (true)', () => {
    const cfg: EditableSessionBindings = {};
    applyConfigPatch({ fromCfnStack: true }, cfg);
    expect(cfg.fromCfnStack).toBe(true);
  });

  it('clears a binding on null / false / empty-string', () => {
    const cfg: EditableSessionBindings = { fromCfnStack: 'X', assumeRole: 'arn:...' };
    applyConfigPatch({ fromCfnStack: null, assumeRole: '' }, cfg);
    expect('fromCfnStack' in cfg).toBe(false);
    expect('assumeRole' in cfg).toBe(false);
  });

  it('only touches the keys present in the body (partial update)', () => {
    const cfg: EditableSessionBindings = { fromCfnStack: 'Keep', assumeRole: 'arn:keep' };
    applyConfigPatch({ assumeRole: 'arn:new' }, cfg);
    expect(cfg).toEqual({ fromCfnStack: 'Keep', assumeRole: 'arn:new' });
  });

  it.each([null, 42, 'str', [1]])('rejects a non-object body %p', (body) => {
    expect(() => applyConfigPatch(body, {})).toThrow(/must be a JSON object/);
  });

  it('rejects a non-string/boolean from-cfn-stack value', () => {
    expect(() => applyConfigPatch({ fromCfnStack: 42 }, {})).toThrow(/"fromCfnStack" must be/);
  });

  it('rejects a non-string assume-role value', () => {
    expect(() => applyConfigPatch({ assumeRole: 42 }, {})).toThrow(/"assumeRole" must be/);
  });

  it('sets / clears the watch mode (true sets, false|null clears)', () => {
    const cfg: EditableSessionBindings = {};
    applyConfigPatch({ watch: true }, cfg);
    expect(cfg.watch).toBe(true);
    applyConfigPatch({ watch: false }, cfg);
    expect('watch' in cfg).toBe(false);
    applyConfigPatch({ watch: true }, cfg);
    applyConfigPatch({ watch: null }, cfg);
    expect('watch' in cfg).toBe(false);
  });

  it('rejects a non-boolean watch value', () => {
    expect(() => applyConfigPatch({ watch: 'yes' }, {})).toThrow(/"watch" must be a boolean/);
  });

  it('leaves watch untouched when the key is absent from the patch', () => {
    const cfg: EditableSessionBindings = { watch: true };
    applyConfigPatch({ assumeRole: 'arn:x' }, cfg);
    expect(cfg.watch).toBe(true);
  });
});

describe('coerceStopRequest', () => {
  it('accepts a well-formed stop request', () => {
    expect(coerceStopRequest({ targetId: 'MyApi' })).toEqual({ targetId: 'MyApi' });
  });

  it.each([null, 42, 'str', undefined])('rejects a non-object body %p', (body) => {
    expect(() => coerceStopRequest(body)).toThrow(/must be a JSON object/);
  });

  it.each([{}, { targetId: '' }, { targetId: '   ' }])(
    'rejects a missing/empty targetId %p',
    (body) => {
      expect(() => coerceStopRequest(body)).toThrow(/non-empty "targetId"/);
    }
  );
});

describe('resolveBootAssemblyDir (issue #324)', () => {
  it('returns the resolved --output dir for an app-command synth that wrote it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkl-studio-asm-'));
    const out = join(dir, 'cdk.out');
    mkdirSync(out);
    try {
      // app command is not a directory; the synth wrote `out`.
      expect(resolveBootAssemblyDir('node bin/app.ts', out)).toBe(out);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the --app dir when it is already a pre-synthesized assembly directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkl-studio-asm-'));
    const appDir = join(dir, 'pre-synthed');
    mkdirSync(appDir);
    try {
      // --app points at an assembly dir; --output was never written.
      expect(resolveBootAssemblyDir(appDir, join(dir, 'cdk.out'))).toBe(appDir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined when neither --app nor --output is a directory on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkl-studio-asm-'));
    try {
      expect(resolveBootAssemblyDir('node bin/app.ts', join(dir, 'missing'))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('coerceServeRequest (issue #322)', () => {
  it('accepts a well-formed request and upper-cases the method', () => {
    expect(
      coerceServeRequest({
        targetId: 'Stack/Api',
        method: 'post',
        path: '/items?q=1',
        headers: { 'content-type': 'application/json', '': 'dropped' },
        body: '{"a":1}',
      })
    ).toEqual({
      targetId: 'Stack/Api',
      method: 'POST',
      path: '/items?q=1',
      headers: { 'content-type': 'application/json' }, // blank-name header dropped
      body: '{"a":1}',
    });
  });

  it('accepts a minimal request (method + targetId only)', () => {
    expect(coerceServeRequest({ targetId: 'T', method: 'GET' })).toEqual({
      targetId: 'T',
      method: 'GET',
    });
  });

  it.each([{}, { targetId: '', method: 'GET' }])('rejects a missing targetId %p', (body) => {
    expect(() => coerceServeRequest(body)).toThrow(/non-empty "targetId"/);
  });

  it.each([{ targetId: 'T' }, { targetId: 'T', method: 'FETCH' }])(
    'rejects a missing/invalid method %p',
    (body) => {
      expect(() => coerceServeRequest(body)).toThrow(/"method" must be one of/);
    }
  );

  it('rejects a non-string path / body / header value', () => {
    expect(() => coerceServeRequest({ targetId: 'T', method: 'GET', path: 1 })).toThrow(
      /"path" must be a string/
    );
    expect(() => coerceServeRequest({ targetId: 'T', method: 'GET', body: {} })).toThrow(
      /"body" must be a string/
    );
    expect(() =>
      coerceServeRequest({ targetId: 'T', method: 'GET', headers: { x: 1 } })
    ).toThrow(/header "x" must be a string/);
  });
});

describe('coerceReinvokeRequest (issue #284)', () => {
  it('accepts a well-formed body and returns invocationId + payload', () => {
    expect(coerceReinvokeRequest({ invocationId: 'src-1', payload: { a: 2 } })).toEqual({
      invocationId: 'src-1',
      payload: { a: 2 },
    });
  });

  it('accepts a null payload (the key is present) — clearing the event', () => {
    expect(coerceReinvokeRequest({ invocationId: 'src-1', payload: null })).toEqual({
      invocationId: 'src-1',
      payload: null,
    });
  });

  it.each([null, 'x', 42])('rejects a non-object body %p', (body) => {
    expect(() => coerceReinvokeRequest(body)).toThrow(/must be a JSON object/);
  });

  it.each([{ payload: {} }, { invocationId: '', payload: {} }, { invocationId: 42, payload: {} }])(
    'rejects a missing/blank invocationId %p',
    (body) => {
      expect(() => coerceReinvokeRequest(body)).toThrow(/non-empty "invocationId"/);
    }
  );

  it('rejects when the payload key is absent (vs an explicit null)', () => {
    expect(() => coerceReinvokeRequest({ invocationId: 'src-1' })).toThrow(/must include a "payload"/);
  });
});

describe('resolveServeBaseUrl (issue #322)', () => {
  const state = (over: Partial<StudioServeState>): StudioServeState => ({
    targetId: 'T',
    kind: 'api',
    status: 'running',
    endpoints: [],
    startedAt: 0,
    ...over,
  });

  it('picks the first http(s) endpoint (the api / alb capture-proxy URL)', () => {
    expect(resolveServeBaseUrl(state({ endpoints: ['http://127.0.0.1:51234'] }))).toBe(
      'http://127.0.0.1:51234'
    );
  });

  it('skips a ws:// endpoint and falls back to the host URL', () => {
    // A WebSocket-API serve exposes a ws:// endpoint that is NOT relayable.
    expect(
      resolveServeBaseUrl(state({ endpoints: ['ws://127.0.0.1:51234'], hostUrl: 'http://h:8080' }))
    ).toBe('http://h:8080');
  });

  it('uses the ecs host URL when there is no http endpoint', () => {
    expect(resolveServeBaseUrl(state({ kind: 'ecs', hostUrl: 'http://127.0.0.1:8080' }))).toBe(
      'http://127.0.0.1:8080'
    );
  });

  it('returns undefined when there is no reachable http endpoint', () => {
    expect(resolveServeBaseUrl(state({ endpoints: ['ws://x'] }))).toBeUndefined();
    expect(resolveServeBaseUrl(state({}))).toBeUndefined();
  });
});
