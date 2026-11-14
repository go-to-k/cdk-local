import { describe, it, expect } from 'vite-plus/test';

import {
  substituteAgainstState,
  substituteEnvVarsFromState,
  substituteEnvVarsFromStateAsync,
  type SubstitutionContext,
} from '../../../src/local/state-resolver.js';

describe('state-resolver: SubstitutionContext.parameters (SSM-backed Refs)', () => {
  it("resolves a Ref to a resolved parameter when it isn't a resource", () => {
    const context: SubstitutionContext = {
      resources: {},
      parameters: { SsmDbHost: 'db.internal' },
    };
    expect(substituteAgainstState({ Ref: 'SsmDbHost' }, context)).toEqual({
      kind: 'literal',
      value: 'db.internal',
    });
  });

  it('prefers a resource over a same-id parameter (resources win)', () => {
    const context: SubstitutionContext = {
      resources: {
        Thing: { physicalId: 'res-1', resourceType: 'X', properties: {}, attributes: {}, dependencies: [] },
      },
      parameters: { Thing: 'param-value' },
    };
    expect(substituteAgainstState({ Ref: 'Thing' }, context)).toEqual({
      kind: 'literal',
      value: 'res-1',
    });
  });

  it('resolves a comma-joined List<String> parameter value as-is', () => {
    const context: SubstitutionContext = {
      resources: {},
      parameters: { SsmSubnets: 'subnet-a,subnet-b' },
    };
    expect(substituteAgainstState({ Ref: 'SsmSubnets' }, context)).toEqual({
      kind: 'literal',
      value: 'subnet-a,subnet-b',
    });
  });

  it('substitutes ${LogicalId} inside Fn::Sub from the parameters map', () => {
    const context: SubstitutionContext = {
      resources: {},
      parameters: { SsmDbHost: 'db.internal' },
    };
    expect(substituteAgainstState({ 'Fn::Sub': 'host=${SsmDbHost}' }, context)).toEqual({
      kind: 'literal',
      value: 'host=db.internal',
    });
  });

  it('warn-and-drops with a reworded reason that mentions CloudFormation parameters', () => {
    const result = substituteAgainstState({ Ref: 'Unknown' }, { resources: {} });
    expect(result.kind).toBe('unresolved');
    if (result.kind === 'unresolved') {
      expect(result.reason).toContain('no record in the state source');
      expect(result.reason).toContain('CloudFormation parameter');
      expect(result.reason).toContain('AWS::SSM::Parameter::Value');
    }
  });

  it('wires the parameters map through substituteEnvVarsFromState end-to-end', () => {
    const { env, audit } = substituteEnvVarsFromState(
      { DB_HOST: { Ref: 'SsmDbHost' }, OTHER: { Ref: 'NopeParam' } },
      { resources: {}, parameters: { SsmDbHost: 'db.internal' } }
    );
    expect(env).toEqual({ DB_HOST: 'db.internal' });
    expect(audit.resolvedKeys).toEqual(['DB_HOST']);
    expect(audit.unresolved.map((u) => u.key)).toEqual(['OTHER']);
    // No sensitiveParameters supplied -> no key is flagged sensitive.
    expect(audit.sensitiveKeys).toEqual([]);
  });
});

describe('state-resolver: list-typed parameters (issue #976)', () => {
  const resources = {};
  const parameters = { SsmSubnets: ['subnet-a', 'subnet-b', 'subnet-c'], SsmHost: 'db.internal' };

  it('Fn::Select picks an element of a list parameter', () => {
    expect(
      substituteAgainstState({ 'Fn::Select': [1, { Ref: 'SsmSubnets' }] }, { resources, parameters })
    ).toEqual({ kind: 'literal', value: 'subnet-b' });
    expect(
      substituteAgainstState({ 'Fn::Select': ['2', { Ref: 'SsmSubnets' }] }, { resources, parameters })
    ).toEqual({ kind: 'literal', value: 'subnet-c' });
  });

  it('Fn::Select out of bounds over a list parameter is unresolved', () => {
    const r = substituteAgainstState({ 'Fn::Select': [3, { Ref: 'SsmSubnets' }] }, { resources, parameters });
    expect(r.kind).toBe('unresolved');
  });

  it('Fn::Join joins a list parameter given as its list argument', () => {
    expect(
      substituteAgainstState({ 'Fn::Join': [';', { Ref: 'SsmSubnets' }] }, { resources, parameters })
    ).toEqual({ kind: 'literal', value: 'subnet-a;subnet-b;subnet-c' });
  });

  it('Fn::Join accepts an Fn::Split as its list argument', () => {
    expect(
      substituteAgainstState({ 'Fn::Join': ['-', { 'Fn::Split': [',', 'a,b'] }] }, { resources, parameters })
    ).toEqual({ kind: 'literal', value: 'a-b' });
  });

  it('Fn::Join over a scalar list argument is unresolved', () => {
    const r = substituteAgainstState({ 'Fn::Join': [';', { Ref: 'SsmHost' }] }, { resources, parameters });
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') expect(r.reason).toContain('must resolve to an array');
  });

  it('a list parameter where a string is required is unresolved, never a joined string', () => {
    for (const value of [
      { Ref: 'SsmSubnets' },
      { 'Fn::Sub': 'x=${SsmSubnets}' },
      { 'Fn::Join': [',', [{ Ref: 'SsmSubnets' }]] },
    ]) {
      const r = substituteAgainstState(value, { resources, parameters });
      expect(r.kind).toBe('unresolved');
      if (r.kind === 'unresolved') expect(r.reason).toContain('the parameter is a list');
    }
  });

  it('drops an env var Ref to a list parameter and keeps a Select over it', () => {
    const { env, audit } = substituteEnvVarsFromState(
      { RAW: { Ref: 'SsmSubnets' }, FIRST: { 'Fn::Select': [0, { Ref: 'SsmSubnets' }] } },
      { resources, parameters }
    );
    expect(env).toEqual({ FIRST: 'subnet-a' });
    expect(audit.unresolved.map((u) => u.key)).toEqual(['RAW']);
  });

  it('flags a sensitive list parameter consumed through Fn::Select, not a refused bare Ref', () => {
    const consumed: string[] = [];
    const ctx: SubstitutionContext = {
      resources,
      parameters,
      sensitiveParameters: new Set(['SsmSubnets']),
      onSensitiveParameterConsumed: (id) => consumed.push(id),
    };
    expect(substituteAgainstState({ 'Fn::Select': [0, { Ref: 'SsmSubnets' }] }, ctx)).toEqual({
      kind: 'literal',
      value: 'subnet-a',
    });
    expect(consumed).toEqual(['SsmSubnets']);
    consumed.length = 0;
    expect(substituteAgainstState({ Ref: 'SsmSubnets' }, ctx).kind).toBe('unresolved');
    expect(consumed).toEqual([]);
  });

  it('a resource wins over a same-id list parameter inside Fn::Select', () => {
    const r = substituteAgainstState(
      { 'Fn::Select': [0, { Ref: 'SsmSubnets' }] },
      {
        resources: {
          SsmSubnets: { physicalId: 'res-1', resourceType: 'X', properties: {}, attributes: {}, dependencies: [] },
        },
        parameters,
      }
    );
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') expect(r.reason).toContain('must resolve to an array');
  });

});

describe('state-resolver: SubstitutionContext.sensitiveParameters (issue #99)', () => {
  it('fires onSensitiveParameterConsumed when a Ref resolves to a sensitive param', () => {
    const consumed: string[] = [];
    const context: SubstitutionContext = {
      resources: {},
      parameters: { Secret: 's3cr3t', Plain: 'ok' },
      sensitiveParameters: new Set(['Secret']),
      onSensitiveParameterConsumed: (id) => consumed.push(id),
    };
    expect(substituteAgainstState({ Ref: 'Secret' }, context)).toEqual({
      kind: 'literal',
      value: 's3cr3t',
    });
    expect(consumed).toEqual(['Secret']);
  });

  it('does NOT fire for a Ref to a non-sensitive param', () => {
    const consumed: string[] = [];
    const context: SubstitutionContext = {
      resources: {},
      parameters: { Secret: 's3cr3t', Plain: 'ok' },
      sensitiveParameters: new Set(['Secret']),
      onSensitiveParameterConsumed: (id) => consumed.push(id),
    };
    substituteAgainstState({ Ref: 'Plain' }, context);
    expect(consumed).toEqual([]);
  });

  it('marks only the env keys whose value consumed a sensitive param', () => {
    const { env, audit } = substituteEnvVarsFromState(
      {
        SECRET_DIRECT: { Ref: 'Secret' },
        PLAIN: { Ref: 'Plain' },
        LITERAL: 'static',
      },
      {
        resources: {},
        parameters: { Secret: 's3cr3t', Plain: 'ok' },
        sensitiveParameters: new Set(['Secret']),
      }
    );
    expect(env).toEqual({ SECRET_DIRECT: 's3cr3t', PLAIN: 'ok', LITERAL: 'static' });
    expect(audit.sensitiveKeys).toEqual(['SECRET_DIRECT']);
  });

  it('flags a key whose sensitive Ref is buried inside Fn::Join / Fn::Sub', () => {
    const { audit } = substituteEnvVarsFromState(
      {
        JOINED: { 'Fn::Join': ['', ['prefix-', { Ref: 'Secret' }]] },
        SUBBED: { 'Fn::Sub': 'url=${Secret}' },
      },
      {
        resources: {},
        parameters: { Secret: 's3cr3t' },
        sensitiveParameters: new Set(['Secret']),
      }
    );
    // Both composed values embed the decrypted secret, so both keys are
    // flagged even though the Ref is nested.
    expect(audit.sensitiveKeys.sort()).toEqual(['JOINED', 'SUBBED']);
  });
});

// Issue #769: the pre-substituted env map feeds `resolveEnvVars`, so an env
// var literally named `__proto__` must survive here as an OWN key, whether it
// is a literal, a state-substituted value, or a value that consumed a
// sensitive (SecureString) parameter.
describe('substituteEnvVarsFromState own-key writes (issue #769)', () => {
  const context: SubstitutionContext = {
    resources: {},
    parameters: { Secret: 's3cr3t', Plain: 'ok' },
    sensitiveParameters: new Set(['Secret']),
  };

  it('keeps a literal __proto__ entry as an own key (sync + async)', async () => {
    const templateEnv = JSON.parse('{"__proto__":"lit","A":"a"}') as Record<string, unknown>;
    for (const { env } of [
      substituteEnvVarsFromState(templateEnv, context),
      await substituteEnvVarsFromStateAsync(templateEnv, context),
    ]) {
      expect(Object.hasOwn(env, '__proto__')).toBe(true);
      expect(env['__proto__']).toBe('lit');
      expect(Object.getPrototypeOf(env)).toBe(Object.prototype);
    }
  });

  it('keeps a substituted __proto__ entry as an own key (sync + async)', async () => {
    const templateEnv = JSON.parse('{"__proto__":{"Ref":"Plain"}}') as Record<string, unknown>;
    for (const { env, audit } of [
      substituteEnvVarsFromState(templateEnv, context),
      await substituteEnvVarsFromStateAsync(templateEnv, context),
    ]) {
      expect(Object.hasOwn(env, '__proto__')).toBe(true);
      expect(env['__proto__']).toBe('ok');
      expect(audit.resolvedKeys).toEqual(['__proto__']);
      expect(audit.sensitiveKeys).toEqual([]);
    }
  });

  it('keeps a SecureString-backed __proto__ entry as an own key and flags it sensitive', async () => {
    const templateEnv = JSON.parse('{"__proto__":{"Ref":"Secret"}}') as Record<string, unknown>;
    for (const { env, audit } of [
      substituteEnvVarsFromState(templateEnv, context),
      await substituteEnvVarsFromStateAsync(templateEnv, context),
    ]) {
      expect(Object.hasOwn(env, '__proto__')).toBe(true);
      expect(env['__proto__']).toBe('s3cr3t');
      expect(audit.sensitiveKeys).toEqual(['__proto__']);
    }
  });

  it('negative control: ordinary keys substitute exactly as before', async () => {
    const templateEnv = { SECRET: { Ref: 'Secret' }, PLAIN: { Ref: 'Plain' }, LIT: 'x' };
    for (const { env, audit } of [
      substituteEnvVarsFromState(templateEnv, context),
      await substituteEnvVarsFromStateAsync(templateEnv, context),
    ]) {
      expect(env).toEqual({ SECRET: 's3cr3t', PLAIN: 'ok', LIT: 'x' });
      expect(audit.sensitiveKeys).toEqual(['SECRET']);
    }
  });
});
