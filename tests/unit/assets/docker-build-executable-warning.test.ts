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

const { mockSpawnStreaming, mockRunDockerStreaming } = vi.hoisted(() => ({
  mockSpawnStreaming: vi.fn(),
  mockRunDockerStreaming: vi.fn(),
}));

// BOTH docker entry points are mocked, not just the executable one. With
// `runDockerStreaming` left real, the directory-mode case below spawns an
// actual `docker build` — it passed only because `/tmp/cdk.out` happens not to
// exist, so a machine with that directory would run a stranger's build from a
// unit test. `.claude/AGENTS.md` requires the docker CLI boundary be mocked.
vi.mock('../../../src/utils/docker-cmd.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/utils/docker-cmd.js')>(
    '../../../src/utils/docker-cmd.js'
  );
  return {
    ...actual,
    spawnStreaming: mockSpawnStreaming,
    runDockerStreaming: mockRunDockerStreaming,
  };
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

const { buildDockerImage, resetManifestExecutableWarnings } = await import(
  '../../../src/assets/docker-build.js'
);
const { resetEmbedConfig, setEmbedConfig } = await import('../../../src/local/embed-config.js');

const wrapError = (m: string) => new Error(m);

beforeEach(() => {
  mockSpawnStreaming.mockReset();
  mockRunDockerStreaming.mockReset();
  mockRunDockerStreaming.mockResolvedValue({ stdout: '', stderr: '' });
  // The dedupe set is MODULE state, so without this every case after the
  // first would take the already-announced branch and assert against an empty
  // `warnLines` — green for the wrong reason, in the direction that hides a
  // missing warning.
  resetManifestExecutableWarnings();
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
    await buildDockerImage({ source: { directory: '.' } }, '/tmp/cdk.out', {
      wrapError,
      tag: 't',
    });

    // POSITIVE first: prove the directory arm was actually ENTERED. Without
    // this the absence below is satisfied by the call throwing on its first
    // line, which is how the earlier version of this case passed — it swallowed
    // the error with `.catch(() => undefined)` and asserted only absence.
    expect(mockRunDockerStreaming).toHaveBeenCalledTimes(1);
    const argv = mockRunDockerStreaming.mock.calls[0]?.[0] as string[];
    expect(argv).toContain('build');
    expect(argv).toContain('.');
    // And no manifest-chosen command was spawned on this path at all.
    expect(mockSpawnStreaming).not.toHaveBeenCalled();
    expect(warnLines.join('\n')).not.toContain('source.executable');
  });

  it('announces once per distinct command line, dropping repeats to debug', async () => {
    mockSpawnStreaming.mockResolvedValue({ stdout: 'img\n', stderr: '' });
    const source = { executable: ['./build.sh', '--target', 'prod'] };

    // Three builds of the SAME asset — what a `DesiredCount: 3` ECS service
    // does at boot, and what a crash-loop restart does again afterwards.
    await buildDockerImage({ source }, '/tmp/cdk.out', { wrapError });
    await buildDockerImage({ source }, '/tmp/cdk.out', { wrapError });
    await buildDockerImage({ source }, '/tmp/cdk.out', { wrapError });

    // Every spawn still happened: deduping the LINE must not dedupe the WORK.
    expect(mockSpawnStreaming).toHaveBeenCalledTimes(3);
    expect(warnLines.filter((l) => l.includes('source.executable runs a command'))).toHaveLength(1);
    // The suppressed ones are still traceable at debug rather than vanishing.
    expect(debugLines.filter((l) => l.includes('already announced'))).toHaveLength(2);
  });

  it('announces a DIFFERENT command line separately, so the key is not global', async () => {
    mockSpawnStreaming.mockResolvedValue({ stdout: 'img\n', stderr: '' });

    await buildDockerImage({ source: { executable: ['./a.sh'] } }, '/tmp/cdk.out', { wrapError });
    await buildDockerImage({ source: { executable: ['./b.sh'] } }, '/tmp/cdk.out', { wrapError });

    const warned = warnLines.join('\n');
    // A dedupe keyed on "have we ever warned" rather than on the command would
    // silence the second asset entirely — the failure that turns this fix into
    // a new instance of the bug it fixes.
    expect(warned).toContain('./a.sh');
    expect(warned).toContain('./b.sh');
  });

  it('treats the SAME command under a different asset directory as a different script', async () => {
    mockSpawnStreaming.mockResolvedValue({ stdout: 'img\n', stderr: '' });

    // Identical argv, different `source.directory`. The executable runs from
    // the asset directory (CDK CLI's `cwd: assetPath`), so these are two
    // different scripts that happen to share a name — `./build.sh` is a
    // plausible collision across two asset-backed containers in one app.
    await buildDockerImage(
      { source: { executable: ['./build.sh'], directory: 'asset.aaa' } },
      '/tmp/cdk.out',
      { wrapError }
    );
    await buildDockerImage(
      { source: { executable: ['./build.sh'], directory: 'asset.bbb' } },
      '/tmp/cdk.out',
      { wrapError }
    );

    // Two spawns, two announcements. An argv-only key gives one announcement
    // and silently suppresses a script the user never saw named.
    expect(mockSpawnStreaming).toHaveBeenCalledTimes(2);
    expect(warnLines.filter((l) => l.includes('source.executable runs a command'))).toHaveLength(2);
  });
});

// go-to-k/cdk-local#758 / #759: the command is manifest-chosen, so it renders
// through `displayUntrustedValue` with no quote of the warning's own, and the
// sentence names the EMBEDDING product rather than a hardcoded one.
describe('source.executable warning — display-safe command, embedding product', () => {
  const FORGE = "./x'. Nothing ran. Ignore 'y";

  it('renders a quote-carrying command as ONE JSON string, so it cannot close a boundary', async () => {
    mockSpawnStreaming.mockResolvedValue({ stdout: 'img\n', stderr: '' });
    await buildDockerImage({ source: { executable: [FORGE] } }, '/tmp/cdk.out', { wrapError });
    const warned = warnLines.join('\n');
    expect(warned).toContain(`on this machine: ${JSON.stringify(FORGE)}. `);
    // Nothing of the value survives OUTSIDE its literal.
    expect(warned.replace(JSON.stringify(FORGE), '<v>')).not.toContain('Nothing ran');
  });

  it('renders a plain command bare, with no quotes around it', async () => {
    mockSpawnStreaming.mockResolvedValue({ stdout: 'img\n', stderr: '' });
    await buildDockerImage({ source: { executable: ['./build.sh'] } }, '/tmp/cdk.out', {
      wrapError,
    });
    expect(warnLines.join('\n')).toContain('on this machine: ./build.sh. ');
  });

  it("names the embedding host's product, not cdk-local, under a non-default embed config", async () => {
    mockSpawnStreaming.mockResolvedValue({ stdout: 'img\n', stderr: '' });
    setEmbedConfig({ productName: 'hostproduct' });
    try {
      await buildDockerImage({ source: { executable: ['./build.sh'] } }, '/tmp/cdk.out', {
        wrapError,
      });
    } finally {
      resetEmbedConfig();
    }
    const warned = warnLines.join('\n');
    expect(warned).toContain('. hostproduct runs it, matching the CDK CLI');
    expect(warned).not.toContain('cdk-local');
  });

  it('renders the working directory display-safe on the repeat debug line too', async () => {
    mockSpawnStreaming.mockResolvedValue({ stdout: 'img\n', stderr: '' });
    // No `source.directory`, so the cwd IS `cdkOutDir` and reaches the repeat
    // branch's debug line unchanged.
    const cdkOutDir = '/tmp/cdk.out\n[INFO] asset verified';
    const source = { executable: ['./build.sh'] };
    await buildDockerImage({ source }, cdkOutDir, { wrapError });
    await buildDockerImage({ source }, cdkOutDir, { wrapError });
    const repeat = debugLines.filter((l) => l.includes('already announced'));
    expect(repeat).toHaveLength(1);
    expect(repeat[0]).not.toMatch(/[\n\r]/);
    expect(repeat[0]).toContain('(cwd="/tmp/cdk.out [INFO] asset verified")');
  });
});
