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
  });
});
