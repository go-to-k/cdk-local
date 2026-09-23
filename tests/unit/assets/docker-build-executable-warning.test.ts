import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// `source.executable` is a command line the ASSET MANIFEST chose, and
// `buildDockerImage` spawns it. It is run rather than refused (CDK CLI's
// `buildExternalAsset` does the same, and an assembly is trusted input), so
// the line announcing it is the whole signal — go-to-k/cdkd#3540.
//
// Two properties are fenced here, and the SECOND is the one with teeth:
//
//   1. the warning fires at all, on the one spawn point every `cdkl` command
//      reaches;
//   2. the warning does NOT contain the arguments. A build script is not
//      `docker build`, so its own `--token` / `--password` matches no argv
//      masker's flag shapes; rendering the full argv at warn level would
//      promote a credential from `--verbose`-only into every CI log. That was
//      a live defect in the host's copy of this warning (go-to-k/cdkd#3497),
//      and it is the failure a future "make the warning more helpful" edit
//      would reintroduce.

const { mockSpawnStreaming } = vi.hoisted(() => ({
  mockSpawnStreaming: vi.fn(),
}));

vi.mock('../../../src/utils/docker-cmd.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/utils/docker-cmd.js')>(
    '../../../src/utils/docker-cmd.js'
  );
  return { ...actual, spawnStreaming: mockSpawnStreaming };
});

// Capture rather than silence: the assertions below are ABOUT the lines, so a
// logger that swallows them would make every case vacuously green.
const { warnLines, debugLines } = vi.hoisted(() => ({
  warnLines: [] as string[],
  debugLines: [] as string[],
}));

vi.mock('../../../src/utils/logger.js', () => {
  const sink = {
    debug: (m: string) => debugLines.push(m),
    info: vi.fn(),
    warn: (m: string) => warnLines.push(m),
    error: vi.fn(),
    getLevel: () => 'info',
    child: () => sink,
  };
  return { getLogger: () => sink };
});

const { buildDockerImage } = await import('../../../src/assets/docker-build.js');

const wrapError = (m: string) => new Error(m);

beforeEach(() => {
  mockSpawnStreaming.mockReset();
  warnLines.length = 0;
  debugLines.length = 0;
});

describe('source.executable warning', () => {
  it('warns before spawning, naming the command and an argument COUNT', async () => {
    mockSpawnStreaming.mockResolvedValue({ stdout: 'built-image:latest\n', stderr: '' });

    const tag = await buildDockerImage(
      { source: { executable: ['./build.sh', '--target', 'prod'] } },
      '/tmp/cdk.out',
      { wrapError }
    );

    // The spawn still happened — this is warn-only, never a refusal.
    expect(tag).toBe('built-image:latest');
    expect(mockSpawnStreaming).toHaveBeenCalledTimes(1);

    const warned = warnLines.join('\n');
    expect(warned).toContain('./build.sh');
    expect(warned).toContain('2 argument(s)');
  });

  it('keeps the ARGUMENTS out of the warning, and only out of the warning', async () => {
    mockSpawnStreaming.mockResolvedValue({ stdout: 'img\n', stderr: '' });

    await buildDockerImage(
      { source: { executable: ['./build.sh', '--password', 'hunter2-PLNTXT'] } },
      '/tmp/cdk.out',
      { wrapError }
    );

    const warned = warnLines.join('\n');
    // The feared shape, asserted directly rather than via a redaction helper:
    // the secret is an ARGUMENT, and no flag-shape masker in this repo knows
    // `./build.sh`'s own flags.
    expect(warned).not.toContain('hunter2-PLNTXT');
    expect(warned).not.toContain('--password');
    // Both polarities: absence alone is satisfied by a warning that never
    // fired, so pin that the line IS there and names the command.
    expect(warned).toContain('./build.sh');

    // ...and still reachable at debug, which is where it always was. Without
    // this the first assertion is satisfied by deleting the debug line too,
    // which would be a REGRESSION dressed as a fix.
    expect(debugLines.join('\n')).toContain('hunter2-PLNTXT');
  });

  it('omits the count clause for a bare command, rather than saying "0 argument(s)"', async () => {
    mockSpawnStreaming.mockResolvedValue({ stdout: 'img\n', stderr: '' });

    await buildDockerImage({ source: { executable: ['./build.sh'] } }, '/tmp/cdk.out', {
      wrapError,
    });

    const warned = warnLines.join('\n');
    expect(warned).toContain('./build.sh');
    expect(warned).not.toContain('argument(s)');
  });

  it('sanitizes a manifest command that would otherwise forge its own log line', async () => {
    mockSpawnStreaming.mockResolvedValue({ stdout: 'img\n', stderr: '' });

    await buildDockerImage(
      { source: { executable: ['./x\n[WARN] all clear, nothing to see'] } },
      '/tmp/cdk.out',
      { wrapError }
    );

    const warned = warnLines.join('\n');
    // Positive FIRST. Without it this case is vacuous: deleting the warning
    // entirely satisfies the absence below, which is exactly what a probe
    // removing the `warnManifestExecutable` call showed.
    expect(warned).toContain('source.executable');
    expect(warned).toContain('./x');
    // The newline is what lets a manifest-chosen value append a line of its
    // own to the log; the value is rendered, but not as a second line.
    expect(warned).not.toContain('./x\n[WARN]');
  });

  it('does NOT warn in directory mode, which spawns no manifest-chosen command', async () => {
    const { runDockerStreaming } = await import('../../../src/utils/docker-cmd.js');
    vi.spyOn({ runDockerStreaming }, 'runDockerStreaming');

    // Directory mode goes through `runDockerStreaming`, not `spawnStreaming`,
    // so reaching the real one would try to run docker. Assert on the arm
    // selection instead: with `executable` absent, nothing was warned by the
    // time the directory arm is entered.
    await buildDockerImage(
      { source: { directory: '.' } },
      '/tmp/cdk.out',
      { wrapError, tag: 't' }
    ).catch(() => undefined);

    expect(warnLines.join('\n')).not.toContain('source.executable');
  });
});
