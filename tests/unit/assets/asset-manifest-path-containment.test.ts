/**
 * go-to-k/cdk-local#745 — asset-MANIFEST paths are contained.
 *
 * `<stack>.assets.json` is written by whoever wrote the assembly, and its
 * `source.directory` / `source.path` become directories cdk-local reads (a
 * Docker build context, a `source.executable` cwd, a CloudFront S3 origin, an
 * AgentCore code bundle, a `--watch` soft-reload `docker cp` source). Each was
 * a raw join. These cases enter through the shared resolver and through its
 * two engine-level consumers (`buildDockerImage`, `AssetManifestLoader`), on
 * REAL directories, because the symlink arm is only meaningful against a real
 * filesystem.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const { mockSpawnStreaming, mockRunDockerStreaming } = vi.hoisted(() => ({
  mockSpawnStreaming: vi.fn(),
  mockRunDockerStreaming: vi.fn(),
}));

// Both docker entry points are mocked: a directory-mode case must never spawn
// a real `docker build`.
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

const { resolveAssetSourcePath, resetWholeAssemblyWarnings } = await import(
  '../../../src/assets/asset-source-path.js'
);
const { buildDockerImage, resetManifestExecutableWarnings } = await import(
  '../../../src/assets/docker-build.js'
);
const { resetBuildKitPassthroughWarnings } = await import(
  '../../../src/assets/buildkit-passthrough-warnings.js'
);
const { AssetManifestLoader } = await import('../../../src/assets/asset-manifest-loader.js');
const { LocalInvokeBuildError } = await import('../../../src/utils/error-handler.js');

const roots: string[] = [];
function tmp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cdkl-745-')));
  roots.push(dir);
  return dir;
}

/** An app outdir with one staged asset, plus a sibling "victim" outside it. */
function layout(): { root: string; outdir: string; victim: string } {
  const root = tmp();
  const outdir = join(root, 'cdk.out');
  const victim = join(root, 'victim');
  mkdirSync(join(outdir, 'asset.abc'), { recursive: true });
  mkdirSync(victim, { recursive: true });
  writeFileSync(join(victim, 'secret'), 'x');
  return { root, outdir, victim };
}

const wrapError = (m: string) => new Error(m);

function resolveIt(over: {
  manifestDir: string;
  value: string;
  assetOutdir: string;
  absolute: 'fold' | 'honour' | 'honour-warn';
}): string {
  return resolveAssetSourcePath({
    ...over,
    field: 'source.directory',
    subject: 'Docker image asset',
    action: 'build it',
    sink: 'build it',
    wrapError,
  });
}

beforeEach(() => {
  mockSpawnStreaming.mockReset();
  mockRunDockerStreaming.mockReset();
  mockRunDockerStreaming.mockResolvedValue({ stdout: '', stderr: '' });
  mockSpawnStreaming.mockResolvedValue({ stdout: 'built:tag\n', stderr: '' });
  resetManifestExecutableWarnings();
  resetBuildKitPassthroughWarnings();
  resetWholeAssemblyWarnings();
  warnLines.length = 0;
  debugLines.length = 0;
});

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('resolveAssetSourcePath — the relative arm (both sinks)', () => {
  it('accepts a staged asset and returns the RESOLVED path', () => {
    const { outdir } = layout();
    for (const absolute of ['fold', 'honour'] as const) {
      expect(
        resolveIt({ manifestDir: outdir, value: 'asset.abc', assetOutdir: outdir, absolute })
      ).toBe(join(outdir, 'asset.abc'));
    }
  });

  it('REFUSES a `..` climb out of the outdir', () => {
    const { outdir } = layout();
    expect(() =>
      resolveIt({ manifestDir: outdir, value: '../victim', assetOutdir: outdir, absolute: 'fold' })
    ).toThrow(/source\.directory='\.\.\/victim' which resolves to .*victim', outside .*cdk\.out'.*Refusing to build it\./);
  });

  it('accepts a cdk.Stage asset `../asset.<hash>` bounded by the APP outdir', () => {
    // The Stage manifest sits in `assembly-<Stage>/`; CDK stages its assets
    // one level up. Bounding at the manifest directory refuses this.
    const { outdir } = layout();
    const stageDir = join(outdir, 'assembly-S');
    mkdirSync(stageDir);
    expect(
      resolveIt({
        manifestDir: stageDir,
        value: '../asset.abc',
        assetOutdir: outdir,
        absolute: 'fold',
      })
    ).toBe(join(outdir, 'asset.abc'));
  });

  it('REFUSES the same Stage value when the bound is the manifest directory', () => {
    // The narrowing default a caller gets by DROPPING the bound — proves the
    // case above passes because of `assetOutdir`, not because nothing checks.
    const { outdir } = layout();
    const stageDir = join(outdir, 'assembly-S');
    mkdirSync(stageDir);
    expect(() =>
      resolveIt({
        manifestDir: stageDir,
        value: '../asset.abc',
        assetOutdir: stageDir,
        absolute: 'fold',
      })
    ).toThrow(/outside/);
  });

  it('REFUSES a lexically-contained value that leads through a symlink out of the outdir', () => {
    const { outdir, victim } = layout();
    symlinkSync(victim, join(outdir, 'link'));
    expect(() =>
      resolveIt({ manifestDir: outdir, value: 'link', assetOutdir: outdir, absolute: 'fold' })
    ).toThrow(/symbolic link to .*victim'/);
  });

  it('returns the NORMALIZED path for `<link>/..`, so the kernel never re-reads it', () => {
    // A raw `<outdir>/sub/link/..` handed to the OS applies `..` AFTER
    // following `link` — landing beside the victim — while the lexical model
    // reads `sub`. Returning (and opening) the normalized string removes the
    // second reading.
    const { outdir, victim } = layout();
    mkdirSync(join(outdir, 'sub'));
    mkdirSync(join(victim, 'deep'));
    symlinkSync(join(victim, 'deep'), join(outdir, 'sub', 'link'));
    const out = resolveIt({
      manifestDir: outdir,
      value: 'sub/link/..',
      assetOutdir: outdir,
      absolute: 'fold',
    });
    expect(out).toBe(join(outdir, 'sub'));
    expect(realpathSync.native(`${outdir}/sub/link/..`)).toBe(victim);
  });

  it('accepts the outdir ITSELF but WARNS that the whole assembly is the source, once', () => {
    const { outdir } = layout();
    for (let i = 0; i < 2; i++) {
      expect(
        resolveIt({ manifestDir: outdir, value: '.', assetOutdir: outdir, absolute: 'fold' })
      ).toBe(outdir);
    }
    expect(warnLines).toHaveLength(1);
    expect(warnLines[0]).toMatch(/naming the assembly's output directory ITSELF/);
    expect(debugLines.some((l) => /ITSELF/.test(l))).toBe(true);
  });

  it('treats a symlink TO the outdir as naming the outdir itself (warn, not refuse)', () => {
    // `namesTheSameDirectory`'s real-path arm: `self` is lexically inside and
    // really IS the outdir. A lexical-only equality would call it an escape.
    const { outdir } = layout();
    symlinkSync(outdir, join(outdir, 'self'));
    expect(
      resolveIt({ manifestDir: outdir, value: 'self', assetOutdir: outdir, absolute: 'fold' })
    ).toBe(join(outdir, 'self'));
    expect(warnLines.some((l) => /ITSELF/.test(l))).toBe(true);
  });

  it("accepts a Stage manifest's `..` (the outdir itself) with the whole-assembly warning", () => {
    const { outdir } = layout();
    const stageDir = join(outdir, 'assembly-S');
    mkdirSync(stageDir);
    expect(
      resolveIt({ manifestDir: stageDir, value: '..', assetOutdir: outdir, absolute: 'fold' })
    ).toBe(outdir);
    expect(warnLines.some((l) => /ITSELF/.test(l))).toBe(true);
  });

  it('renders a control character in the value flattened, not raw', () => {
    const { outdir } = layout();
    let message = '';
    try {
      resolveIt({
        manifestDir: outdir,
        value: '../victim\x1b[2K\rforged',
        assetOutdir: outdir,
        absolute: 'fold',
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/outside/);
    expect(message).not.toMatch(/[\x1b\r]/);
  });
});

describe("resolveAssetSourcePath — an ABSOLUTE value, judged as the sink joins it", () => {
  it("'fold': an absolute value lands UNDER the manifest directory (concatenation / path.join)", () => {
    const { outdir, victim } = layout();
    expect(
      resolveIt({ manifestDir: outdir, value: victim, assetOutdir: outdir, absolute: 'fold' })
    ).toBe(join(outdir, victim));
  });

  it("'fold': a leading-separator climb is still refused after the fold", () => {
    const { outdir } = layout();
    expect(() =>
      resolveIt({ manifestDir: outdir, value: '/../victim', assetOutdir: outdir, absolute: 'fold' })
    ).toThrow(/outside/);
  });

  it("'honour-warn': an absolute value outside the outdir is ACCEPTED with a --no-staging warning, once", () => {
    // Maintainer decision (#755 follow-up): `cdk synth --no-staging` writes
    // this shape, so it is accepted and the warning names it.
    const { outdir, victim } = layout();
    for (let i = 0; i < 2; i++) {
      expect(
        resolveIt({ manifestDir: outdir, value: victim, assetOutdir: outdir, absolute: 'honour-warn' })
      ).toBe(victim);
    }
    const lines = warnLines.filter((l) => /pointing outside the assembly/.test(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`'${victim}'`);
    expect(lines[0]).toMatch(/cdk synth --no-staging/);
    expect(debugLines.some((l) => /pointing outside the assembly/.test(l))).toBe(true);
  });

  it("'honour-warn': an accepted absolute value outside the outdir comes back NORMALIZED", () => {
    // The reader opens what this returns; `<victim>/sub/..` must come back as
    // `<victim>`, the path the warning named.
    const { outdir, victim } = layout();
    mkdirSync(join(victim, 'sub'));
    expect(
      resolveIt({
        manifestDir: outdir,
        value: `${victim}/sub/..`,
        assetOutdir: outdir,
        absolute: 'honour-warn',
      })
    ).toBe(victim);
  });

  it("'honour-warn': the warning flattens control characters in the path", () => {
    const { root, outdir } = layout();
    const odd = join(root, 'odd\x1b[2K\rFORGED');
    mkdirSync(odd);
    resolveIt({ manifestDir: outdir, value: odd, assetOutdir: outdir, absolute: 'honour-warn' });
    const line = warnLines.find((l) => /pointing outside the assembly/.test(l))!;
    expect(line).not.toMatch(/[\x1b\r]/);
  });

  it("'honour-warn': a RELATIVE escape is still REFUSED (only the absolute shape is accepted)", () => {
    const { outdir } = layout();
    expect(() =>
      resolveIt({ manifestDir: outdir, value: '../victim', assetOutdir: outdir, absolute: 'honour-warn' })
    ).toThrow(/outside.*Refusing to build it/);
  });

  it("'honour': an absolute value inside the outdir is used as written", () => {
    const { outdir } = layout();
    const inside = join(outdir, 'asset.abc');
    expect(
      resolveIt({ manifestDir: outdir, value: inside, assetOutdir: outdir, absolute: 'honour' })
    ).toBe(inside);
  });

  it("'honour': returns the NORMALIZED path for an absolute `<link>/..`", () => {
    // The honour arm's readers (`path.resolve` sinks) must open the judged
    // string; returning the raw value would hand the kernel `sub/link/..`,
    // which it reads as the victim.
    const { outdir, victim } = layout();
    mkdirSync(join(outdir, 'sub'));
    mkdirSync(join(victim, 'deep'));
    symlinkSync(join(victim, 'deep'), join(outdir, 'sub', 'link'));
    expect(
      resolveIt({
        manifestDir: outdir,
        value: `${outdir}/sub/link/..`,
        assetOutdir: outdir,
        absolute: 'honour',
      })
    ).toBe(join(outdir, 'sub'));
  });

  it("'honour': a second spelling of the outdir itself is accepted with the whole-assembly warning", () => {
    // `absoluteAssemblyPathEscape` exonerates `alias` (a link to the outdir)
    // as inside; only `namesTheSameDirectory`'s real-path arm sees it IS the
    // outdir.
    const { root, outdir } = layout();
    symlinkSync(outdir, join(root, 'alias'));
    expect(
      resolveIt({
        manifestDir: outdir,
        value: join(root, 'alias'),
        assetOutdir: outdir,
        absolute: 'honour',
      })
    ).toBe(join(root, 'alias'));
    expect(warnLines.some((l) => /ITSELF/.test(l))).toBe(true);
  });

  it("'honour-warn': an absolute value through a symlink out of the outdir is ACCEPTED, the warning naming the link target", () => {
    const { outdir, victim } = layout();
    symlinkSync(victim, join(outdir, 'link'));
    expect(
      resolveIt({
        manifestDir: outdir,
        value: join(outdir, 'link'),
        assetOutdir: outdir,
        absolute: 'honour-warn',
      })
    ).toBe(join(outdir, 'link'));
    const line = warnLines.find((l) => /pointing outside the assembly/.test(l))!;
    expect(line).toContain(`through a symbolic link to '${victim}'`);
    // No `--no-staging` excuse for a link: no CDK synth writes one.
    expect(line).not.toMatch(/no-staging/);
    expect(line).toMatch(/made that link yourself/);
  });

  it("'honour' (soft-reload sources): an absolute value outside the outdir is REFUSED", () => {
    // Their boot build folds an absolute value, so a real --no-staging
    // assembly never reaches a reload; only a hostile layout would.
    const { outdir, victim } = layout();
    expect(() =>
      resolveIt({ manifestDir: outdir, value: victim, assetOutdir: outdir, absolute: 'honour' })
    ).toThrow(/has an absolute source\.directory=.*outside.*Refusing to build it\./);
    symlinkSync(victim, join(outdir, 'link'));
    expect(() =>
      resolveIt({
        manifestDir: outdir,
        value: join(outdir, 'link'),
        assetOutdir: outdir,
        absolute: 'honour',
      })
    ).toThrow(/symbolic link/);
    expect(warnLines.filter((l) => /pointing outside the assembly/.test(l))).toEqual([]);
  });

  it("'honour-warn' REFUSES the filesystem root", () => {
    const { outdir } = layout();
    expect(() =>
      resolveIt({ manifestDir: outdir, value: '/', assetOutdir: outdir, absolute: 'honour-warn' })
    ).toThrow(/names the filesystem root\..*Refusing to build it/);
  });

  it("'honour-warn' REFUSES the user's home directory, but accepts a folder under it", () => {
    const { outdir } = layout();
    expect(() =>
      resolveIt({ manifestDir: outdir, value: homedir(), assetOutdir: outdir, absolute: 'honour-warn' })
    ).toThrow(/names your home directory/);
    // An ANCESTOR of home too — the outdir (under the OS temp dir) is not
    // under home, so the outdir-ancestor arm cannot catch it.
    expect(() =>
      resolveIt({
        manifestDir: outdir,
        value: dirname(homedir()),
        assetOutdir: outdir,
        absolute: 'honour-warn',
      })
    ).toThrow(/names your home directory or a directory containing it/);
    // A real --no-staging site folder lives under home; only the home ROOT is refused.
    const site = join(homedir(), 'cdkl-745-not-created', 'site');
    expect(
      resolveIt({ manifestDir: outdir, value: site, assetOutdir: outdir, absolute: 'honour-warn' })
    ).toBe(site);
  });

  it("'honour-warn' REFUSES the home directory reached through a symlink (real paths compared)", () => {
    const { root, outdir } = layout();
    symlinkSync(homedir(), join(root, 'home-alias'));
    expect(() =>
      resolveIt({
        manifestDir: outdir,
        value: join(root, 'home-alias'),
        assetOutdir: outdir,
        absolute: 'honour-warn',
      })
    ).toThrow(/names your home directory/);
  });

  it("'honour-warn' REFUSES an ancestor of the outdir (it contains the assembly)", () => {
    const { root, outdir } = layout();
    expect(() =>
      resolveIt({ manifestDir: outdir, value: root, assetOutdir: outdir, absolute: 'honour-warn' })
    ).toThrow(/names a directory containing the app's output directory/);
  });

  it("'honour-warn' ACCEPTS a sibling site folder (the --no-staging shape)", () => {
    const { outdir, victim } = layout();
    expect(
      resolveIt({ manifestDir: outdir, value: victim, assetOutdir: outdir, absolute: 'honour-warn' })
    ).toBe(victim);
  });

  it("'honour' / 'honour-warn': a RELATIVE value leaving through a symlink is still REFUSED", () => {
    const { outdir, victim } = layout();
    symlinkSync(victim, join(outdir, 'link'));
    for (const absolute of ['honour', 'honour-warn'] as const) {
      expect(() =>
        resolveIt({ manifestDir: outdir, value: 'link', assetOutdir: outdir, absolute })
      ).toThrow(/symbolic link/);
    }
  });
});

describe('buildDockerImage — the shared container-build sink', () => {
  it('REFUSES an escaping source.directory before any docker call, as LocalInvokeBuildError', async () => {
    const { outdir } = layout();
    const err = await buildDockerImage({ source: { directory: '../victim' } }, outdir, {
      tag: 't',
      wrapError,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocalInvokeBuildError);
    expect((err as Error).message).toMatch(/Refusing to build it/);
    // Not the caller's "docker build failed" wrapper: nothing was built.
    expect((err as Error).message).not.toMatch(/docker build failed/);
    expect(mockRunDockerStreaming).not.toHaveBeenCalled();
  });

  it('REFUSES the executable arm too — before the command is announced or spawned', async () => {
    const { outdir } = layout();
    await expect(
      buildDockerImage(
        { source: { directory: '../victim', executable: ['./build.sh'] } },
        outdir,
        { wrapError }
      )
    ).rejects.toThrow(/Refusing to build it/);
    expect(mockSpawnStreaming).not.toHaveBeenCalled();
    expect(warnLines.filter((l) => /source\.executable/.test(l))).toHaveLength(0);
  });

  it('builds a Stage asset when the caller passes assetOutdir, with the resolved cwd', async () => {
    const { outdir } = layout();
    const stageDir = join(outdir, 'assembly-S');
    mkdirSync(stageDir);
    await buildDockerImage({ source: { directory: '../asset.abc' } }, stageDir, {
      tag: 't',
      wrapError,
      assetOutdir: outdir,
    });
    expect(mockRunDockerStreaming).toHaveBeenCalledTimes(1);
    expect(mockRunDockerStreaming.mock.calls[0]![1].cwd).toBe(join(outdir, 'asset.abc'));
  });

  it('REFUSES the same Stage asset when assetOutdir is absent (the narrowing default)', async () => {
    const { outdir } = layout();
    const stageDir = join(outdir, 'assembly-S');
    mkdirSync(stageDir);
    await expect(
      buildDockerImage({ source: { directory: '../asset.abc' } }, stageDir, {
        tag: 't',
        wrapError,
      })
    ).rejects.toThrow(/outside/);
  });

  it('folds an absolute source.directory under cdkOutDir, as the old concatenation did', async () => {
    const { outdir, victim } = layout();
    await buildDockerImage({ source: { directory: victim } }, outdir, { tag: 't', wrapError });
    expect(mockRunDockerStreaming.mock.calls[0]![1].cwd).toBe(join(outdir, victim));
  });

  it('runs the executable from the RESOLVED directory', async () => {
    const { outdir } = layout();
    await buildDockerImage(
      { source: { directory: 'asset.abc', executable: ['./build.sh'] } },
      outdir,
      { wrapError }
    );
    expect(mockSpawnStreaming.mock.calls[0]![2]).toEqual({ cwd: join(outdir, 'asset.abc') });
  });
});

describe('buildDockerImage — BuildKit passthrough warnings (warn, never refuse)', () => {
  it('warns for a --secret src outside the assembly, and still builds', async () => {
    const { outdir, victim } = layout();
    await buildDockerImage(
      {
        source: {
          directory: 'asset.abc',
          dockerBuildSecrets: { npm: `type=file,src=${join(victim, 'secret')}` },
        },
      },
      outdir,
      { tag: 't', wrapError }
    );
    expect(mockRunDockerStreaming).toHaveBeenCalledTimes(1);
    const lines = warnLines.filter((l) => /dockerBuildSecrets/.test(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\['npm'\] names a host path outside the assembly/);
    expect(lines[0]).toMatch(/will read it during the image build/);
    expect(lines[0]).not.toMatch(/Refusing/);
  });

  it('judges the RENDERED secret, so a src smuggled into the KEY is seen', async () => {
    const { outdir, victim } = layout();
    await buildDockerImage(
      {
        source: {
          directory: 'asset.abc',
          dockerBuildSecrets: { [`x,src=${join(victim, 'secret')}`]: 'type=file' },
        },
      },
      outdir,
      { tag: 't', wrapError }
    );
    expect(warnLines.some((l) => /dockerBuildSecrets/.test(l))).toBe(true);
  });

  it('says WRITE for a dockerOutputs destination outside the assembly', async () => {
    const { outdir, victim } = layout();
    await buildDockerImage(
      { source: { directory: 'asset.abc', dockerOutputs: [`type=local,dest=${victim}`] } },
      outdir,
      { tag: 't', wrapError }
    );
    expect(warnLines.some((l) => /dockerOutputs\['0'\].*will WRITE to it/.test(l))).toBe(true);
  });

  it('warns for a --build-context and an --ssh key outside the assembly', async () => {
    const { outdir, victim } = layout();
    await buildDockerImage(
      {
        source: {
          directory: 'asset.abc',
          dockerBuildContexts: { shared: victim },
          dockerBuildSsh: `default=${join(victim, 'secret')}`,
        },
      },
      outdir,
      { tag: 't', wrapError }
    );
    expect(warnLines.some((l) => /dockerBuildContexts\['shared'\]/.test(l))).toBe(true);
    expect(warnLines.some((l) => /dockerBuildSsh\['0'\]/.test(l))).toBe(true);
  });

  it('stays silent for passthroughs inside the build context, and for non-path keys', async () => {
    const { outdir } = layout();
    writeFileSync(join(outdir, 'asset.abc', 'token'), 'x');
    await buildDockerImage(
      {
        source: {
          directory: 'asset.abc',
          dockerBuildSecrets: { t: 'type=file,src=token' },
          cacheFrom: [{ type: 'registry', params: { ref: 'ghcr.io/x/y:cache' } }],
          // An S3 cache `prefix` is a key, not a host path; a leading `/`
          // would read as an absolute escape if every key were a candidate.
          cacheTo: { type: 's3', params: { bucket: 'b', prefix: '/team/cache/' } },
          dockerOutputs: ['type=image,push=true'],
        },
      },
      outdir,
      { tag: 't', wrapError }
    );
    expect(warnLines.filter((l) => /names a host path/.test(l))).toEqual([]);
  });

  it('resolves a relative passthrough against the BUILD CONTEXT, not cdkOutDir', async () => {
    // From `asset.abc`, `../../cdk.out/ok` lands back inside the outdir; from
    // `cdkOutDir` it would climb out. `../../victim/secret` leaves either way.
    const { outdir } = layout();
    await buildDockerImage(
      {
        source: {
          directory: 'asset.abc',
          dockerBuildSecrets: { a: 'type=file,src=../../cdk.out/ok', b: 'src=../../victim/secret' },
        },
      },
      outdir,
      { tag: 't', wrapError }
    );
    const lines = warnLines.filter((l) => /dockerBuildSecrets/.test(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\['b'\]/);
  });

  it('covers dockerFile, the source= alias, cache src/dest and the bare --output form', async () => {
    const { outdir, victim } = layout();
    await buildDockerImage(
      {
        source: {
          directory: 'asset.abc',
          dockerFile: '../../victim/Dockerfile',
          dockerBuildSecrets: { s: `source=${join(victim, 'secret')}` },
          cacheFrom: [{ type: 'local', params: { src: victim } }],
          cacheTo: { type: 'local', params: { dest: victim } },
          dockerOutputs: [victim],
        },
      },
      outdir,
      { tag: 't', wrapError }
    );
    expect(warnLines.some((l) => /^Docker asset dockerFile names/.test(l))).toBe(true);
    expect(warnLines.some((l) => /dockerBuildSecrets\['s'\].*will read/.test(l))).toBe(true);
    expect(warnLines.some((l) => /cacheFrom\['0'\].*will read/.test(l))).toBe(true);
    expect(warnLines.some((l) => /cacheTo names.*will WRITE to/.test(l))).toBe(true);
    expect(warnLines.some((l) => /dockerOutputs\['0'\].*will WRITE to/.test(l))).toBe(true);
  });

  it('judges an oci-layout:// build context by the host path behind the scheme', async () => {
    const { outdir, victim } = layout();
    await buildDockerImage(
      { source: { directory: 'asset.abc', dockerBuildContexts: { base: `oci-layout://${victim}` } } },
      outdir,
      { tag: 't', wrapError }
    );
    expect(warnLines.some((l) => /dockerBuildContexts\['base'\]/.test(l))).toBe(true);
  });

  it('judges every --ssh key after the id, and none for the agent-socket form', async () => {
    const { outdir, victim } = layout();
    await buildDockerImage(
      { source: { directory: 'asset.abc', dockerBuildSsh: `k=asset-key,${join(victim, 'secret')}` } },
      outdir,
      { tag: 't', wrapError }
    );
    expect(warnLines.filter((l) => /dockerBuildSsh\['1'\]/.test(l))).toHaveLength(1);
    expect(warnLines.filter((l) => /dockerBuildSsh\['0'\]/.test(l))).toHaveLength(0);
    warnLines.length = 0;
    await buildDockerImage(
      // No `=`: the value is an agent-socket ID, not a path, even when it
      // LOOKS like an escaping one.
      { source: { directory: 'asset.abc', dockerBuildSsh: victim } },
      outdir,
      { tag: 't2', wrapError }
    );
    expect(warnLines.filter((l) => /dockerBuildSsh/.test(l))).toHaveLength(0);
  });

  it('prints a repeated line once per process (replicas rebuild the same asset)', async () => {
    const { outdir, victim } = layout();
    const asset = {
      source: { directory: 'asset.abc', dockerBuildContexts: { shared: victim } },
    };
    await buildDockerImage(asset, outdir, { tag: 't', wrapError });
    await buildDockerImage(asset, outdir, { tag: 't', wrapError });
    expect(warnLines.filter((l) => /dockerBuildContexts/.test(l))).toHaveLength(1);
    expect(mockRunDockerStreaming).toHaveBeenCalledTimes(2);
  });
});

describe('AssetManifestLoader', () => {
  it('REFUSES a stack name that carries the manifest filename out of the directory', async () => {
    const { root, outdir } = layout();
    writeFileSync(join(root, 'x.assets.json'), '{"files":{},"dockerImages":{}}');
    await expect(new AssetManifestLoader().loadManifest(outdir, '../x')).rejects.toThrow(
      /Refusing to read the asset manifest for stack '\.\.\/x'.*outside/
    );
  });

  it('REFUSES a stack manifest file that is a symlink out of the directory', async () => {
    const { root, outdir } = layout();
    writeFileSync(join(root, 'x.assets.json'), '{"files":{},"dockerImages":{}}');
    symlinkSync(join(root, 'x.assets.json'), join(outdir, 'App.assets.json'));
    await expect(new AssetManifestLoader().loadManifest(outdir, 'App')).rejects.toThrow(
      /symbolic link/
    );
  });

  it('still reads an ordinary stack manifest (and answers null for an absent one)', async () => {
    const { outdir } = layout();
    writeFileSync(join(outdir, 'App.assets.json'), '{"files":{},"dockerImages":{}}');
    const loader = new AssetManifestLoader();
    await expect(loader.loadManifest(outdir, 'App')).resolves.toEqual({
      files: {},
      dockerImages: {},
    });
    await expect(loader.loadManifest(outdir, 'Missing')).resolves.toBeNull();
  });

  it('getAssetSourcePath REFUSES an escaping file-asset source.path and folds an absolute one', () => {
    const { outdir, victim } = layout();
    const loader = new AssetManifestLoader();
    const opts = { assetOutdir: outdir, subject: 'Code bundle', wrapError };
    const asset = (p: string) =>
      ({ source: { path: p }, destinations: {} }) as unknown as Parameters<
        typeof loader.getAssetSourcePath
      >[1];
    expect(() => loader.getAssetSourcePath(outdir, asset('../victim'), opts)).toThrow(
      /Code bundle has source\.path='\.\.\/victim'.*outside/
    );
    expect(loader.getAssetSourcePath(outdir, asset('asset.abc'), opts)).toBe(
      join(outdir, 'asset.abc')
    );
    expect(loader.getAssetSourcePath(outdir, asset(victim), opts)).toBe(
      resolve(join(outdir, victim))
    );
  });
});
