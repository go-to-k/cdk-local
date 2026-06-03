import { describe, it, expect } from 'vite-plus/test';
import {
  applyConfigPatch,
  coerceRunRequest,
  coerceStopRequest,
  createLocalStudioCommand,
  parseStudioPort,
  type EditableSessionBindings,
} from '../../../src/cli/commands/local-studio.js';

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
