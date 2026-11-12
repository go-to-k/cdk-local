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

const { createLocalStudioCommand } = await import('../../../src/cli/commands/local-studio.js');

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
