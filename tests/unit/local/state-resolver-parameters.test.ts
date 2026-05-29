import { describe, it, expect } from 'vite-plus/test';

import {
  substituteAgainstState,
  substituteEnvVarsFromState,
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
