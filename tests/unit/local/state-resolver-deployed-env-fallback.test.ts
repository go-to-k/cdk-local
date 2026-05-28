import { describe, it, expect } from 'vite-plus/test';

import { applyDeployedEnvFallback } from '../../../src/local/state-resolver.js';

describe('applyDeployedEnvFallback', () => {
  it('fills unresolved keys from the deployed env and leaves resolved keys untouched', () => {
    const resolvedEnv = { TABLE_NAME: 'tbl-1' };
    const unresolved = [{ key: 'SIBLING_ARN', reason: "Fn::GetAtt 'Fn.Arn': attribute not captured" }];
    const deployedEnv = { SIBLING_ARN: 'arn:aws:lambda:us-east-1:111:function:Fn', TABLE_NAME: 'ignored' };

    const result = applyDeployedEnvFallback(resolvedEnv, unresolved, deployedEnv);

    expect(result.env).toEqual({
      TABLE_NAME: 'tbl-1',
      SIBLING_ARN: 'arn:aws:lambda:us-east-1:111:function:Fn',
    });
    expect(result.filled).toEqual(['SIBLING_ARN']);
    expect(result.stillUnresolved).toEqual([]);
  });

  it('keeps keys absent from the deployed env unresolved (warn-and-drop path)', () => {
    const unresolved = [
      { key: 'A', reason: 'r1' },
      { key: 'B', reason: 'r2' },
    ];
    const deployedEnv = { A: 'a-value' };

    const result = applyDeployedEnvFallback({}, unresolved, deployedEnv);

    expect(result.env).toEqual({ A: 'a-value' });
    expect(result.filled).toEqual(['A']);
    expect(result.stillUnresolved).toEqual([{ key: 'B', reason: 'r2' }]);
  });

  it('returns the env unchanged and all keys unresolved when deployedEnv is undefined', () => {
    const resolvedEnv = { X: '1' };
    const unresolved = [{ key: 'Y', reason: 'r' }];

    const result = applyDeployedEnvFallback(resolvedEnv, unresolved, undefined);

    expect(result.env).toEqual({ X: '1' });
    expect(result.filled).toEqual([]);
    expect(result.stillUnresolved).toEqual([{ key: 'Y', reason: 'r' }]);
  });

  it('does not mutate the input env or unresolved array', () => {
    const resolvedEnv = { X: '1' };
    const unresolved = [{ key: 'Y', reason: 'r' }];

    const result = applyDeployedEnvFallback(resolvedEnv, unresolved, { Y: 'y-value' });

    expect(resolvedEnv).toEqual({ X: '1' });
    expect(unresolved).toEqual([{ key: 'Y', reason: 'r' }]);
    expect(result.env).not.toBe(resolvedEnv);
  });

  it('treats an empty deployed env as no fill (function declares no env vars)', () => {
    const unresolved = [{ key: 'A', reason: 'r1' }];

    const result = applyDeployedEnvFallback({}, unresolved, {});

    expect(result.env).toEqual({});
    expect(result.filled).toEqual([]);
    expect(result.stillUnresolved).toEqual([{ key: 'A', reason: 'r1' }]);
  });
});
