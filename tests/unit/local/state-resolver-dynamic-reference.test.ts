/**
 * Issue #784 — a cross-stack value that is a `{{resolve:...}}` token (a host
 * persisting a secret-bearing output redacted back to its token) resolves at
 * the `Fn::ImportValue` / `Fn::GetStackOutput` boundary, against the
 * PRODUCER's region, and the consuming key is flagged sensitive.
 */
import { describe, expect, it, vi } from 'vite-plus/test';
import {
  substituteEnvVarsFromStateAsync,
  type CrossStackResolver,
  type SubstitutionContext,
} from '../../../src/local/state-resolver.js';

const TOKEN = '{{resolve:secretsmanager:db-secret:SecretString:password}}';

function crossStack(value: string): CrossStackResolver {
  return {
    resolveImport: vi.fn(async () => value),
    resolveGetStackOutput: vi.fn(async () => value),
  };
}

function ctx(extra: Partial<SubstitutionContext>): SubstitutionContext {
  return { resources: {}, consumerRegion: 'us-east-1', ...extra };
}

describe('cross-stack dynamic references (#784)', () => {
  it('Fn::ImportValue: resolved against the consumer region (an export is regional), key flagged sensitive', async () => {
    const hook = vi.fn(async () => 'plain');
    const { env, audit } = await substituteEnvVarsFromStateAsync(
      { DB_PASSWORD: { 'Fn::ImportValue': 'Producer-DbPassword' }, OTHER: 'x' },
      ctx({ crossStackResolver: crossStack(TOKEN), resolveDynamicReferences: hook })
    );
    expect(hook).toHaveBeenCalledWith(TOKEN, 'us-east-1');
    expect(env['DB_PASSWORD']).toBe('plain');
    expect(audit.sensitiveKeys).toEqual(['DB_PASSWORD']);
  });

  it('Fn::GetStackOutput with an explicit Region: resolved against the PRODUCER region', async () => {
    const hook = vi.fn(async () => 'plain');
    const { env, audit } = await substituteEnvVarsFromStateAsync(
      {
        DB_PASSWORD: {
          'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'Pw', Region: 'eu-west-1' },
        },
      },
      ctx({ crossStackResolver: crossStack(TOKEN), resolveDynamicReferences: hook })
    );
    expect(hook).toHaveBeenCalledWith(TOKEN, 'eu-west-1');
    expect(env['DB_PASSWORD']).toBe('plain');
    expect(audit.sensitiveKeys).toEqual(['DB_PASSWORD']);
  });

  it('reports a boundary resolution through onDynamicReferenceResolved, never as a logical id', async () => {
    const onSensitive = vi.fn();
    const onResolved = vi.fn();
    const { substituteAgainstStateAsync } = await import('../../../src/local/state-resolver.js');
    const result = await substituteAgainstStateAsync(
      { 'Fn::ImportValue': 'Producer-DbPassword' },
      ctx({
        crossStackResolver: crossStack(TOKEN),
        resolveDynamicReferences: async () => 'plain',
        onSensitiveParameterConsumed: onSensitive,
        onDynamicReferenceResolved: onResolved,
      })
    );
    expect(result).toEqual({ kind: 'literal', value: 'plain' });
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(onSensitive).not.toHaveBeenCalled();
  });

  it('a non-token cross-stack value never calls the hook', async () => {
    const hook = vi.fn(async () => 'never');
    const { env, audit } = await substituteEnvVarsFromStateAsync(
      { Q: { 'Fn::ImportValue': 'QueueUrl' } },
      ctx({ crossStackResolver: crossStack('https://sqs/q'), resolveDynamicReferences: hook })
    );
    expect(hook).not.toHaveBeenCalled();
    expect(env['Q']).toBe('https://sqs/q');
    expect(audit.sensitiveKeys).toEqual([]);
  });

  it('without the hook the token flows through for the env builder to resolve', async () => {
    const { env, audit } = await substituteEnvVarsFromStateAsync(
      { DB_PASSWORD: { 'Fn::ImportValue': 'Producer-DbPassword' } },
      ctx({ crossStackResolver: crossStack(TOKEN) })
    );
    expect(env['DB_PASSWORD']).toBe(TOKEN);
    expect(audit.sensitiveKeys).toEqual([]);
  });

  it('a hook failure propagates — never a silent fallback to the token', async () => {
    const hook = vi.fn(async () => {
      throw new Error('AccessDenied for the reference');
    });
    await expect(
      substituteEnvVarsFromStateAsync(
        { DB_PASSWORD: { 'Fn::ImportValue': 'Producer-DbPassword' } },
        ctx({ crossStackResolver: crossStack(TOKEN), resolveDynamicReferences: hook })
      )
    ).rejects.toThrow(/AccessDenied for the reference/);
  });
});
