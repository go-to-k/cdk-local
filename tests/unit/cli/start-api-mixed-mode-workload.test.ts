/**
 * go-to-k/cdk-local#902 — `start-api` resolves each function's
 * `{{resolve:...}}` for THAT function: in AWS Emulator mixed mode the fetch
 * follows the `"real-aws"` exceptions of the function's own `--env-vars` section
 * (by logical ID or CDK path), as its runtime calls do; every other service
 * goes to the emulator.
 */
import { rmSync } from 'node:fs';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const { smEndpoints } = vi.hoisted(() => ({ smEndpoints: [] as Array<string | undefined> }));

vi.mock('@aws-sdk/client-secrets-manager', async (orig) => ({
  ...(await orig<object>()),
  SecretsManagerClient: class {
    constructor(config: { endpoint?: string }) {
      smEndpoints.push(config.endpoint);
    }
    async send(): Promise<unknown> {
      return { SecretString: 'secret-value' };
    }
    destroy(): void {}
  },
}));

const { buildContainerSpec } = await import('../../../src/cli/commands/local-start-api.js');
const { setAwsEmulatorServiceRouting } = await import('../../../src/utils/aws-proxy.js');

const EMU = 'https://127.0.0.1:9395';

describe('start-api buildContainerSpec — mixed-mode routing per function', () => {
  const inlineTmpDirs = new Set<string>();

  afterEach(() => {
    setAwsEmulatorServiceRouting(undefined);
    for (const d of inlineTmpDirs) rmSync(d, { recursive: true, force: true });
    inlineTmpDirs.clear();
    smEndpoints.length = 0;
  });

  const stack = {
    stackName: 'S',
    region: 'us-east-1',
    template: {
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            Code: { ZipFile: 'exports.handler = () => {};' },
            Environment: { Variables: { TOKEN: '{{resolve:secretsmanager:probe}}' } },
          },
          Metadata: { 'aws:cdk:path': 'S/Fn/Resource' },
        },
      },
    },
  } as unknown as StackInfo;

  const buildFor = async (section: string): Promise<Record<string, string>> => {
    setAwsEmulatorServiceRouting({
      realServices: [],
      override: { endpoint: EMU, credentials: { accessKeyId: 'EMU', secretAccessKey: 'e' } },
      envOverrides: { [section]: { AWS_ENDPOINT_URL_SECRETS_MANAGER: 'real-aws' } },
    });
    const spec = await buildContainerSpec({
      logicalId: 'Fn',
      stacks: [stack],
      overrides: undefined,
      assumeRole: undefined,
      containerHost: '127.0.0.1',
      stsRegion: undefined,
      inlineTmpDirs,
      layerTmpDirs: new Set(),
      stateByStack: new Map(),
      skipPull: true,
    });
    return spec.env;
  };

  it('reads from real AWS when the function own section (CDK path or logical ID) excepts the service', async () => {
    expect((await buildFor('S/Fn'))['TOKEN']).toBe('secret-value');
    await buildFor('Fn');
    expect(smEndpoints).toEqual([undefined, undefined]);
  });

  it('reads from the emulator when only another function excepts it', async () => {
    await buildFor('S/Other');
    expect(smEndpoints).toEqual([EMU]);
  });
});
