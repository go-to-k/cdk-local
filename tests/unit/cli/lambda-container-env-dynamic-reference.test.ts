/**
 * Issue #784 — the shared Lambda container-env builder resolves CloudFormation
 * dynamic references for BOTH routes: a same-stack template value and a
 * cross-stack value a host state provider hands back as a redacted
 * `{{resolve:...}}` token. Resolved keys go off the `docker run` argv; an
 * `--env-vars` override skips the lookup; a failure throws.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const { smSend, smRegions, smEndpoints } = vi.hoisted(() => ({
  smSend: vi.fn(),
  smRegions: [] as Array<string | undefined>,
  smEndpoints: [] as Array<string | undefined>,
}));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    constructor(config: { region?: string; endpoint?: string }) {
      smRegions.push(config.region);
      smEndpoints.push(config.endpoint);
    }
    send = smSend;
    destroy(): void {}
  },
  GetSecretValueCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    async send(): Promise<unknown> {
      return { Account: '111111111111' };
    }
    destroy(): void {}
  },
  GetCallerIdentityCommand: class {},
  AssumeRoleCommand: class {},
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
  smEndpoints.length = 0;
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

  it("an env-agnostic stack (`unknown-region`) falls through to --region", async () => {
    await resolveLambdaContainerEnv(
      zipLambda({ DB_PASSWORD: TOKEN }, 'unknown-region'),
      { region: 'eu-west-3' },
      undefined
    );
    expect(smRegions).toEqual(['eu-west-3']);
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

  // An export is regional, so the boundary and the final pass agree on the
  // region here; the GetStackOutput case below is the one that pins the hook.
  it('resolves an imported token in the consumer region and flags the key', async () => {
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

  it('an --env-vars override skips the cross-stack lookup too', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cdkl-784-'));
    const envFile = path.join(dir, 'env.json');
    writeFileSync(envFile, JSON.stringify({ Parameters: { DB_PASSWORD: 'local' } }));
    const result = await resolveLambdaContainerEnv(
      zipLambda({
        DB_PASSWORD: {
          'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'Pw', Region: 'eu-central-1' },
        },
      }),
      { fromState: true, envVars: envFile } as never,
      undefined,
      { fromState: () => hostProvider() }
    );
    expect(result.env['DB_PASSWORD']).toBe('local');
    expect(smSend).not.toHaveBeenCalled();
  });

  it('never scans a decrypted SecureString, and flags a deployed fill built from a token', async () => {
    const provider = {
      ...hostProvider(),
      load: async () => ({
        resources: { Handler: { physicalId: 'fn-phys', resourceType: 'AWS::Lambda::Function', properties: {} } },
        outputs: {},
        region: 'ap-southeast-2',
      }),
      resolveTemplateSsmParameters: async () => ({
        values: { SecureParam: `plain-${TOKEN}` },
        secureStringLogicalIds: ['SecureParam'],
      }),
      resolveDeployedFunctionEnv: async () => ({ DB_URL: 'postgres://u:pl41n@db/x' }),
    } as unknown as LocalStateProvider;
    const result = await resolveLambdaContainerEnv(
      zipLambda({
        API_KEY: { Ref: 'SecureParam' },
        DB_URL: {
          'Fn::Join': ['', ['postgres://u:', TOKEN, '@', { 'Fn::GetAtt': ['Db', 'Endpoint.Address'] }]],
        },
      }),
      { fromState: true } as never,
      undefined,
      { fromState: () => provider }
    );
    expect(smSend).not.toHaveBeenCalled();
    expect(result.env['API_KEY']).toBe(`plain-${TOKEN}`);
    expect(result.env['DB_URL']).toBe('postgres://u:pl41n@db/x');
    expect([...result.sensitiveEnvKeys].sort()).toEqual(['API_KEY', 'DB_URL']);
  });

  it('keeps an ImportValue-backed deployed-env fill off the argv', async () => {
    const provider = {
      ...hostProvider(),
      load: async () => ({
        resources: { Handler: { physicalId: 'fn-phys', resourceType: 'AWS::Lambda::Function', properties: {} } },
        outputs: {},
        region: 'ap-southeast-2',
      }),
      // The export is not in state, so substitution leaves the key unresolved
      // and the deployed function's resolved env fills it.
      buildCrossStackResolver: async () => ({
        resolveImport: async () => undefined,
        resolveGetStackOutput: async () => undefined,
      }),
      resolveDeployedFunctionEnv: async () => ({ DB_PASSWORD: 'pl41n-from-deploy' }),
    } as unknown as LocalStateProvider;
    const result = await resolveLambdaContainerEnv(
      zipLambda({ DB_PASSWORD: { 'Fn::ImportValue': 'Producer-DbPassword' }, PLAIN: 'x' }),
      { fromState: true } as never,
      undefined,
      { fromState: () => provider }
    );
    expect(result.env['DB_PASSWORD']).toBe('pl41n-from-deploy');
    expect(result.sensitiveEnvKeys).toEqual(['DB_PASSWORD']);
    expect(smSend).not.toHaveBeenCalled();
  });

  it('marks a fill sensitive only when its template value may be a secret', async () => {
    const provider = {
      ...hostProvider(),
      load: async () => ({
        resources: { Handler: { physicalId: 'fn-phys', resourceType: 'AWS::Lambda::Function', properties: {} } },
        outputs: {},
        region: 'ap-southeast-2',
      }),
      buildCrossStackResolver: async () => ({
        resolveImport: async () => undefined,
        resolveGetStackOutput: async () => undefined,
      }),
      resolveDeployedFunctionEnv: async () => ({
        SIBLING_ARN: 'arn:aws:lambda:ap-southeast-2:1:function:s',
        DB_PASSWORD: 'pl41n-noecho',
        IMPORTED: 'pl41n-imported',
        KEY_SECRET: 'pl41n-access-key',
      }),
    } as unknown as LocalStateProvider;
    const lambda = zipLambda({
      SIBLING_ARN: { 'Fn::GetAtt': ['Sibling', 'Arn'] },
      DB_PASSWORD: { 'Fn::Sub': 'p-${DbPassword}' },
      IMPORTED: { 'Fn::Join': ['', ['x', { 'Fn::ImportValue': 'Pw' }]] },
      KEY_SECRET: { 'Fn::GetAtt': ['Key', 'SecretAccessKey'] },
    });
    (lambda.stack.template as Record<string, unknown>)['Resources'] = {
      Key: { Type: 'AWS::IAM::AccessKey' },
      Sibling: { Type: 'AWS::Lambda::Function' },
    };
    (lambda.stack.template as Record<string, unknown>)['Parameters'] = {
      DbPassword: { Type: 'String', NoEcho: true },
    };
    const result = await resolveLambdaContainerEnv(lambda, { fromState: true } as never, undefined, {
      fromState: () => provider,
    });
    expect(result.env['SIBLING_ARN']).toBe('arn:aws:lambda:ap-southeast-2:1:function:s');
    expect([...result.sensitiveEnvKeys].sort()).toEqual(['DB_PASSWORD', 'IMPORTED', 'KEY_SECRET']);
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

// go-to-k/cdk-local#902: the function is the workload. Its `{{resolve}}`
// fetches and its `--from-cfn-stack` names follow ITS `real-aws` exceptions.
const { setAwsEmulatorServiceRouting } = await import('../../../src/utils/aws-proxy.js');

describe('resolveLambdaContainerEnv — AWS Emulator mixed mode, per workload', () => {
  const EMU = 'https://127.0.0.1:9395';
  const route = (section: string): void =>
    setAwsEmulatorServiceRouting({
      realServices: [],
      override: { endpoint: EMU, credentials: { accessKeyId: 'EMU', secretAccessKey: 'e' } },
      envOverrides: { [section]: { AWS_ENDPOINT_URL_SECRETS_MANAGER: 'real-aws' } },
    });

  it("reads the secret from real AWS only when the function's own section excepts it", async () => {
    try {
      route('Consumer/Handler');
      await resolveLambdaContainerEnv(zipLambda({ DB_PASSWORD: TOKEN }), {}, undefined);
      route('OtherFn');
      await resolveLambdaContainerEnv(zipLambda({ DB_PASSWORD: TOKEN }), {}, undefined);
      expect(smEndpoints).toEqual([undefined, EMU]);
    } finally {
      setAwsEmulatorServiceRouting(undefined);
    }
  });

  it('hands a host state provider the function as the workload', async () => {
    const factory = vi.fn(() => undefined as unknown as LocalStateProvider);
    await resolveLambdaContainerEnv(zipLambda({ PLAIN: 'x' }), { fromHost: true }, undefined, {
      fromHost: factory,
    }).catch(() => undefined);
    expect(factory).toHaveBeenCalledWith(expect.anything(), {
      workload: { logicalId: 'Handler', cdkPath: 'Consumer/Handler/Resource' },
    });
  });

  it('reads a pipe-backed --env-vars the exception scan already consumed (#894)', async () => {
    const { execFileSync, spawn } = await import('node:child_process');
    const { readAwsEmulatorEnvVarsFile } = await import(
      '../../../src/local/aws-emulator-mixed-mode.js'
    );
    const { resetEnvVarsFileTextsForTest } = await import('../../../src/local/env-resolver.js');
    const dir = mkdtempSync(path.join(tmpdir(), 'fifo-invoke-'));
    const fifo = path.join(dir, 'env.fifo');
    execFileSync('mkfifo', [fifo]);
    const body = JSON.stringify({ Handler: { FROM_PIPE: 'yes' } });
    const writer = spawn('sh', ['-c', 'printf "%s" "$1" > "$2"', 'sh', body, fifo]);
    const written = new Promise((r) => writer.on('exit', r));
    // An empty second writer: a regression's second open of the FIFO reads ""
    // and fails, instead of blocking the worker forever. Unused (killed) when
    // the text is kept.
    let empty: ReturnType<typeof spawn> | undefined;
    try {
      readAwsEmulatorEnvVarsFile(fifo);
      await written;
      empty = spawn('sh', ['-c', ': > "$1"', 'sh', fifo]);
      const result = await resolveLambdaContainerEnv(zipLambda({}), { envVars: fifo }, undefined);
      expect(result.env['FROM_PIPE']).toBe('yes');
    } finally {
      writer.kill();
      rmSync(dir, { recursive: true, force: true });
      // Reap it: the suite refuses a test file that leaves a child running.
      if (empty && empty.exitCode === null && empty.signalCode === null) {
        const exited = new Promise((r) => empty!.once('exit', r));
        empty.kill();
        await exited;
      }
      resetEnvVarsFileTextsForTest();
    }
  });
});
