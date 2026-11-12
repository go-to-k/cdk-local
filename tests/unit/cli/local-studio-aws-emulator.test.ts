import { homedir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

// `cdkl studio --aws-emulator` / `--ca-bundle`: studio activates the wiring
// itself (its `--from-cfn-stack` classification is an AWS call too, and an
// unreachable emulator fails once, up front) before it synthesizes anything.
const { activateMock, synthMock } = vi.hoisted(() => ({
  activateMock: vi.fn(),
  synthMock: vi.fn(),
}));

vi.mock('../../../src/local/workload-aws-wiring.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/local/workload-aws-wiring.js')>()),
  activateWorkloadAwsWiring: activateMock,
}));

vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: class {
    synthesize = synthMock;
  },
}));

const { createLocalStudioCommand, studioEndpointChildConfig } = await import(
  '../../../src/cli/commands/local-studio.js'
);
const { resolve } = await import('node:path');

afterEach(() => {
  activateMock.mockReset();
  synthMock.mockReset();
  vi.restoreAllMocks();
});

async function runStudio(args: string[]): Promise<void> {
  vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await createLocalStudioCommand()
    .exitOverride()
    .parseAsync(['--app', 'node app.js', '--no-open', ...args], { from: 'user' })
    .catch(() => undefined);
}

describe('studioEndpointChildConfig (what studio forwards to each child)', () => {
  const emulator = {
    mode: 'emulator' as const,
    emulatorEndpoint: { url: 'https://127.0.0.1:9301', hostname: '127.0.0.1', port: 9301, loopback: true },
  };

  it('forwards the resolved emulator URL and the CA bundle as an absolute path', () => {
    expect(studioEndpointChildConfig(emulator, 'ca.pem')).toEqual({
      awsEmulator: 'https://127.0.0.1:9301',
      caBundle: resolve('ca.pem'),
    });
  });

  it('expands a literal ~/ in --ca-bundle like the wiring does', () => {
    expect(studioEndpointChildConfig({ mode: 'forward' }, '~/ca.pem').caBundle).toBe(
      resolve(homedir(), 'ca.pem')
    );
  });

  it('forwards nothing in forward mode without a CA bundle', () => {
    expect(studioEndpointChildConfig({ mode: 'forward' }, undefined)).toEqual({});
  });
});

describe('cdkl studio --aws-emulator / --ca-bundle', () => {
  it('activates the wiring with both flags before synthesizing', async () => {
    activateMock.mockResolvedValue({ mode: 'forward', env: {}, mounts: [] });
    synthMock.mockRejectedValue(new Error('stop after synth'));
    await runStudio(['--aws-emulator', 'https://127.0.0.1:9301', '--ca-bundle', 'ca.pem']);
    expect(activateMock).toHaveBeenCalledTimes(1);
    expect(activateMock.mock.calls[0]![0]).toMatchObject({
      awsEmulator: 'https://127.0.0.1:9301',
      caBundle: 'ca.pem',
    });
    expect(activateMock.mock.invocationCallOrder[0]!).toBeLessThan(
      synthMock.mock.invocationCallOrder[0]!
    );
  });

  it('an unreachable emulator stops studio before it synthesizes', async () => {
    activateMock.mockRejectedValue(new Error('--aws-emulator https://127.0.0.1:9301: no AWS Emulator answers'));
    await runStudio(['--aws-emulator', 'https://127.0.0.1:9301']);
    expect(synthMock).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
