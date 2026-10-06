/**
 * Issue #784 — the shared Lambda container-env builder resolves CloudFormation
 * dynamic references for BOTH routes: a same-stack template value and a
 * cross-stack value a host state provider hands back as a redacted
 * `{{resolve:...}}` token. Resolved keys go off the `docker run` argv; an
 * `--env-vars` override skips the lookup; a failure throws.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const { smSend, smRegions } = vi.hoisted(() => ({
  smSend: vi.fn(),
  smRegions: [] as Array<string | undefined>,
}));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    constructor(config: { region?: string }) {
      smRegions.push(config.region);
    }
    send = smSend;
    destroy(): void {}
  },
  GetSecretValueCommand: class {
    constructor(public input: unknown) {}
  },
}));

const { resolveLambdaContainerEnv } = await import('../../../src/cli/commands/local-invoke.js');
const { DynamicReferenceResolutionError } = await import(
  '../../../src/local/dynamic-reference-resolver.js'
);
import type { ResolvedLambda } from '../../../src/local/lambda-resolver.js';
import type { LocalStateProvider } from '../../../src/local/local-state-provider.js';

const PLAINTEXT = 'pl41n-S3CRET';
const TOKEN = '{{resolve:secretsmanager:MySecret:SecretString:password}}';

function zipLambda(envVars: Record<string, unknown>, region = 'us-west-2'): ResolvedLambda {
  return {
    kind: 'zip',
    stack: {
      stackName: 'Consumer',
      displayName: 'Consumer',
      artifactId: 'Consumer',
      template: { Resources: {} },
      dependencyNames: [],
      region,
    },
    logicalId: 'Handler',
    resource: {
      Type: 'AWS::Lambda::Function',
      Properties: { Environment: { Variables: envVars } },
      Metadata: { 'aws:cdk:path': 'Consumer/Handler/Resource' },
    },
    memoryMb: 128,
    timeoutSec: 3,
    layers: [],
    runtime: 'nodejs20.x',
    handler: 'index.handler',
    codePath: '/tmp/code',
  } as unknown as ResolvedLambda;
}

beforeEach(() => {
  smSend.mockReset();
  smRegions.length = 0;
  smSend.mockResolvedValue({ SecretString: JSON.stringify({ password: PLAINTEXT }) });
});

describe('resolveLambdaContainerEnv — same-stack dynamic reference', () => {
  it('hands the container the resolved value, off-argv, fetched in the stack region', async () => {
    const result = await resolveLambdaContainerEnv(
      zipLambda({ DB_PASSWORD: TOKEN, PLAIN: 'x' }),
      {},
      undefined
    );
    expect(result.env['DB_PASSWORD']).toBe(PLAINTEXT);
    expect(result.env['PLAIN']).toBe('x');
    expect(result.sensitiveEnvKeys).toEqual(['DB_PASSWORD']);
    expect(smRegions).toEqual(['us-west-2']);
    expect(smSend).toHaveBeenCalledTimes(1);
    expect(smSend.mock.calls[0]![0].input).toEqual({ SecretId: 'MySecret' });
  });

  it('an --env-vars override on the key skips the lookup', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cdkl-784-'));
    const envFile = path.join(dir, 'env.json');
    writeFileSync(envFile, JSON.stringify({ Handler: { DB_PASSWORD: 'local-literal' } }));
    const result = await resolveLambdaContainerEnv(
      zipLambda({ DB_PASSWORD: TOKEN }),
      { envVars: envFile },
      undefined
    );
    expect(result.env['DB_PASSWORD']).toBe('local-literal');
    expect(smSend).not.toHaveBeenCalled();
    expect(result.sensitiveEnvKeys).toEqual([]);
  });

  it('a refused lookup throws instead of handing over the token', async () => {
    const denied = Object.assign(new Error('not authorized'), {
      name: 'AccessDeniedException',
      $fault: 'client',
      $metadata: {},
    });
    smSend.mockRejectedValue(denied);
    const err = await resolveLambdaContainerEnv(zipLambda({ DB_PASSWORD: TOKEN }), {}, undefined).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(DynamicReferenceResolutionError);
    expect((err as Error).message).toContain('Lambda Handler env var DB_PASSWORD');
    expect((err as Error).message).toContain('secretsmanager:GetSecretValue');
  });
});

describe('resolveLambdaContainerEnv — cross-stack dynamic reference (host --from-state)', () => {
  function hostProvider(): LocalStateProvider {
    return {
      label: '--from-state',
      load: async () => ({ resources: {}, outputs: {}, region: 'ap-southeast-2' }),
      buildCrossStackResolver: async () => ({
        // A host persisting a secret-bearing output redacted to its token.
        resolveImport: async () => TOKEN,
        resolveGetStackOutput: async () => TOKEN,
      }),
      dispose: () => {},
    } as unknown as LocalStateProvider;
  }

  it('resolves an imported token against the producer (= consumer) region and flags the key', async () => {
    const result = await resolveLambdaContainerEnv(
      zipLambda({ DB_PASSWORD: { 'Fn::ImportValue': 'Producer-DbPassword' } }),
      { fromState: true } as never,
      undefined,
      { fromState: () => hostProvider() }
    );
    expect(result.env['DB_PASSWORD']).toBe(PLAINTEXT);
    expect(result.sensitiveEnvKeys).toEqual(['DB_PASSWORD']);
    expect(smRegions).toEqual(['ap-southeast-2']);
  });

  it('resolves a GetStackOutput token against the Region the intrinsic names', async () => {
    const result = await resolveLambdaContainerEnv(
      zipLambda({
        DB_PASSWORD: {
          'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'Pw', Region: 'eu-central-1' },
        },
      }),
      { fromState: true } as never,
      undefined,
      { fromState: () => hostProvider() }
    );
    expect(result.env['DB_PASSWORD']).toBe(PLAINTEXT);
    expect(result.sensitiveEnvKeys).toEqual(['DB_PASSWORD']);
    expect(smRegions).toEqual(['eu-central-1']);
  });
});
