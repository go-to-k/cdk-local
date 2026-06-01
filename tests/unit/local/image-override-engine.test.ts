import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// T1 — mock `runDockerStreaming` at module level so we can capture the
// argv `runImageOverrideBuilds` hands to docker (the canonical
// `--build-arg` / `--secret` / `--target` / `-f` shapes the spec
// promises). The mock must be installed BEFORE the engine module is
// imported; `vi.hoisted` keeps the spy a stable reference inside the
// `vi.mock` factory.
const { runDockerStreamingMock } = vi.hoisted(() => ({
  runDockerStreamingMock: vi.fn(),
}));
vi.mock('../../../src/utils/docker-cmd.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/utils/docker-cmd.js')>(
    '../../../src/utils/docker-cmd.js'
  );
  return {
    ...actual,
    runDockerStreaming: runDockerStreamingMock,
  };
});

const {
  buildImageOverrideTag,
  discoverDockerfiles,
  enforceImageOverrideOrphans,
  expandTilde,
  IMAGE_OVERRIDE_BOOT_PROMPT_INTRO,
  ImageOverrideError,
  mergeForService,
  parseImageOverrideFlags,
  resolveImageOverrides,
  runImageOverrideBuilds,
} = await import('../../../src/local/image-override-engine.js');
const { LocalStartServiceError } = await import('../../../src/utils/error-handler.js');

/**
 * Issue #238 — engine-level coverage. The picker / boot-prompt branches
 * are TTY-gated via `isInteractive()` and a real `@clack/prompts`
 * `multiselect` / `text` would require a live terminal — exercised at
 * the binding-test level (TTY=false short-circuit) here. The parser +
 * Stage-1 explicit resolution + tag derivation are fully unit-tested.
 */

function makeTmpDockerfile(name = 'Dockerfile'): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cdkl-override-engine-'));
  const file = path.join(dir, name);
  writeFileSync(file, 'FROM scratch\n');
  return file;
}

describe('parseImageOverrideFlags (issue #238)', () => {
  it('parses explicit <svc>=<dockerfile> form into the explicit map', () => {
    const out = parseImageOverrideFlags({
      imageOverride: ['AppService=./services/app/Dockerfile'],
    });
    expect(out.explicit.size).toBe(1);
    expect(out.explicit.get('AppService')).toBe('./services/app/Dockerfile');
    expect(out.pickerPaths).toEqual([]);
  });

  it('parses picker-form bare <dockerfile> into pickerPaths in CLI order', () => {
    const out = parseImageOverrideFlags({
      imageOverride: ['./a/Dockerfile', './b/Dockerfile'],
    });
    expect(out.explicit.size).toBe(0);
    expect(out.pickerPaths).toEqual(['./a/Dockerfile', './b/Dockerfile']);
  });

  it('supports mixed explicit + picker-form in one invocation', () => {
    const out = parseImageOverrideFlags({
      imageOverride: ['Svc=./a/Dockerfile', './b/Dockerfile'],
    });
    expect(out.explicit.get('Svc')).toBe('./a/Dockerfile');
    expect(out.pickerPaths).toEqual(['./b/Dockerfile']);
  });

  it('rejects an empty bare value', () => {
    expect(() => parseImageOverrideFlags({ imageOverride: [''] })).toThrow(
      /empty string/
    );
  });

  it('rejects a duplicate explicit mapping for the same service', () => {
    expect(() =>
      parseImageOverrideFlags({
        imageOverride: ['Svc=./a/Dockerfile', 'Svc=./b/Dockerfile'],
      })
    ).toThrow(ImageOverrideError);
  });

  it('rejects an explicit form with empty service or empty dockerfile side', () => {
    expect(() => parseImageOverrideFlags({ imageOverride: ['=./a/Dockerfile'] })).toThrow();
    expect(() => parseImageOverrideFlags({ imageOverride: ['Svc='] })).toThrow();
  });

  it('parses --image-build-arg into globals.buildArgs preserving order', () => {
    const out = parseImageOverrideFlags({
      imageBuildArg: ['A=1', 'B=2'],
    });
    expect(Array.from(out.globals.buildArgs.entries())).toEqual([
      ['A', '1'],
      ['B', '2'],
    ]);
  });

  it('rejects malformed --image-build-arg (no =)', () => {
    expect(() => parseImageOverrideFlags({ imageBuildArg: ['BAD'] })).toThrow(/KEY=VAL/);
  });

  it('rejects --image-build-arg with empty key', () => {
    expect(() => parseImageOverrideFlags({ imageBuildArg: ['=value'] })).toThrow(/KEY=VAL/);
  });

  it('parses --image-build-secret id=src into globals.buildSecrets (src resolved to abs path)', () => {
    const out = parseImageOverrideFlags({
      imageBuildSecret: ['npmrc=./.npmrc', 'token=./token.txt'],
    });
    // M1: relative `src` is resolved against process.cwd() at parse
    // time so `docker build --secret src=...` (which is relative to
    // the build context = Dockerfile parent) doesn't misresolve when
    // the Dockerfile lives in a subdir.
    expect(out.globals.buildSecrets.get('npmrc')).toBe(path.resolve(process.cwd(), './.npmrc'));
    expect(out.globals.buildSecrets.get('token')).toBe(path.resolve(process.cwd(), './token.txt'));
  });

  it('rejects --image-build-secret with empty id or src', () => {
    expect(() => parseImageOverrideFlags({ imageBuildSecret: ['=src'] })).toThrow();
    expect(() => parseImageOverrideFlags({ imageBuildSecret: ['id='] })).toThrow();
  });

  it('parses --image-target into globals.targetStage', () => {
    const out = parseImageOverrideFlags({ imageTarget: 'builder' });
    expect(out.globals.targetStage).toBe('builder');
  });

  it('trims surrounding whitespace from a bare global --image-target (parity with per-service form trim)', () => {
    // The per-service branch (`<svc>=<stage>`) trims both halves; the
    // bare global form trims too so `--image-target ' builder '`
    // behaves the same way regardless of which form the user picked.
    const out = parseImageOverrideFlags({ imageTarget: '  builder  ' });
    expect(out.globals.targetStage).toBe('builder');
  });

  it('rejects an empty --image-target', () => {
    expect(() => parseImageOverrideFlags({ imageTarget: '' })).toThrow();
  });
});

describe('resolveImageOverrides Stage 1: explicit mappings (issue #238)', () => {
  it('binds an explicit mapping to a pinned target', async () => {
    const dockerfile = makeTmpDockerfile();
    const rawFlags = parseImageOverrideFlags({
      imageOverride: [`AppService=${dockerfile}`],
    });
    const overrides = await resolveImageOverrides({
      rawFlags,
      pinnedTargets: ['AppService'],
    });
    expect(overrides.size).toBe(1);
    const entry = overrides.get('AppService');
    expect(entry?.dockerfile).toBe(dockerfile);
    expect(entry?.contextDir).toBe(path.dirname(dockerfile));
  });

  it('drops an explicit mapping naming a non-pinned target with a warning', async () => {
    const dockerfile = makeTmpDockerfile();
    const rawFlags = parseImageOverrideFlags({
      imageOverride: [`NotPinned=${dockerfile}`],
    });
    const overrides = await resolveImageOverrides({
      rawFlags,
      pinnedTargets: ['AppService'],
    });
    expect(overrides.size).toBe(0);
  });

  it('hard-errors when the explicit Dockerfile path does not exist', async () => {
    const rawFlags = parseImageOverrideFlags({
      imageOverride: ['AppService=/nonexistent/path/Dockerfile'],
    });
    await expect(
      resolveImageOverrides({
        rawFlags,
        pinnedTargets: ['AppService'],
      })
    ).rejects.toBeInstanceOf(ImageOverrideError);
  });

  it('threads build-args / build-secrets / target-stage globals into every entry', async () => {
    const dockerfile = makeTmpDockerfile();
    const rawFlags = parseImageOverrideFlags({
      imageOverride: [`Svc=${dockerfile}`],
      imageBuildArg: ['NODE_ENV=production'],
      imageBuildSecret: ['npmrc=./.npmrc'],
      imageTarget: 'release',
    });
    const overrides = await resolveImageOverrides({
      rawFlags,
      pinnedTargets: ['Svc'],
    });
    const entry = overrides.get('Svc');
    expect(entry?.buildArgs.get('NODE_ENV')).toBe('production');
    // M1: secret src resolved to absolute path against process.cwd() at parse.
    expect(entry?.buildSecrets.get('npmrc')).toBe(path.resolve(process.cwd(), './.npmrc'));
    expect(entry?.targetStage).toBe('release');
  });
});

describe('resolveImageOverrides Stage 2: picker form (non-TTY skip) (issue #238)', () => {
  it('skips picker-form Dockerfile paths when not interactive (non-TTY context)', async () => {
    // In the vitest runner, stdin / stdout are typically NOT TTYs, so the
    // picker branch falls through to its non-TTY warn-and-skip path. The
    // result: no override is produced from a picker-form path here, which
    // is the expected CI/non-TTY behaviour.
    const dockerfile = makeTmpDockerfile();
    const rawFlags = parseImageOverrideFlags({
      imageOverride: [dockerfile],
    });
    const overrides = await resolveImageOverrides({
      rawFlags,
      pinnedTargets: ['AppService'],
      noInteractive: true,
    });
    expect(overrides.size).toBe(0);
  });
});

describe('resolveImageOverrides Stage 3: boot prompt (non-TTY skip) (issue #238)', () => {
  it('skips the boot prompt when noInteractive=true', async () => {
    const rawFlags = parseImageOverrideFlags({});
    const overrides = await resolveImageOverrides({
      rawFlags,
      pinnedTargets: ['Pinned1', 'Pinned2'],
      interactiveBootPrompt: true,
      noInteractive: true,
    });
    expect(overrides.size).toBe(0);
  });

  it('returns an empty map when there are no flags and no prompt opt-in', async () => {
    const rawFlags = parseImageOverrideFlags({});
    const overrides = await resolveImageOverrides({
      rawFlags,
      pinnedTargets: ['Pinned1'],
    });
    expect(overrides.size).toBe(0);
  });
});

describe('buildImageOverrideTag (issue #238)', () => {
  function makeEntry(overrides: {
    dockerfile?: string;
    body?: string;
    buildArgs?: Map<string, string>;
    buildSecrets?: Map<string, string>;
    targetStage?: string;
  } = {}) {
    // The tag function reads Dockerfile bytes (B2 fix), so the file
    // must exist. Default body is `FROM scratch`; callers override
    // when they need to test bytes-flip determinism.
    const dockerfile =
      overrides.dockerfile ?? makeTmpDockerfile('Dockerfile.tag-test');
    if (overrides.body !== undefined) {
      writeFileSync(dockerfile, overrides.body);
    }
    return {
      dockerfile,
      contextDir: path.dirname(dockerfile),
      buildArgs: overrides.buildArgs ?? new Map<string, string>(),
      buildSecrets: overrides.buildSecrets ?? new Map<string, string>(),
      ...(overrides.targetStage !== undefined && { targetStage: overrides.targetStage }),
    };
  }

  it('produces a deterministic tag for the same inputs', () => {
    const entry = makeEntry();
    const tag1 = buildImageOverrideTag('AppService', entry);
    const tag2 = buildImageOverrideTag('AppService', entry);
    expect(tag1).toBe(tag2);
  });

  it('differs by service target', () => {
    const entry = makeEntry();
    const tagA = buildImageOverrideTag('A', entry);
    const tagB = buildImageOverrideTag('B', entry);
    expect(tagA).not.toBe(tagB);
  });

  it('differs when Dockerfile path differs', () => {
    const entry1 = makeEntry();
    const entry2 = makeEntry();
    const tag1 = buildImageOverrideTag('Svc', entry1);
    const tag2 = buildImageOverrideTag('Svc', entry2);
    // Different tmp dirs => different paths => different tags.
    expect(tag1).not.toBe(tag2);
  });

  it('flips when the Dockerfile CONTENTS change (B2 fix)', () => {
    // Same path, same flags — the only diff is the Dockerfile bytes.
    // Before B2 the tag was stable across edits; after B2 the tag
    // bumps so the rebuild rolling primitive boots a new container
    // under the new tag instead of reusing the stale build.
    const dockerfile = makeTmpDockerfile('Dockerfile.bytes-flip');
    writeFileSync(dockerfile, 'FROM alpine:3.18\n');
    const tagBefore = buildImageOverrideTag('Svc', {
      dockerfile,
      contextDir: path.dirname(dockerfile),
      buildArgs: new Map(),
      buildSecrets: new Map(),
    });
    writeFileSync(dockerfile, 'FROM alpine:3.19\n');
    const tagAfter = buildImageOverrideTag('Svc', {
      dockerfile,
      contextDir: path.dirname(dockerfile),
      buildArgs: new Map(),
      buildSecrets: new Map(),
    });
    expect(tagBefore).not.toBe(tagAfter);
  });

  it('differs when build args / secrets / target-stage differ', () => {
    // All four entries point at the SAME Dockerfile so the only
    // axis under test is the flag set.
    const dockerfile = makeTmpDockerfile('Dockerfile.flag-axes');
    const base = {
      dockerfile,
      contextDir: path.dirname(dockerfile),
      buildArgs: new Map<string, string>(),
      buildSecrets: new Map<string, string>(),
    };
    const tag0 = buildImageOverrideTag('Svc', base);
    const tag1 = buildImageOverrideTag('Svc', {
      ...base,
      buildArgs: new Map([['K', 'V']]),
    });
    const tag2 = buildImageOverrideTag('Svc', {
      ...base,
      buildSecrets: new Map([['s', 'v']]),
    });
    const tag3 = buildImageOverrideTag('Svc', { ...base, targetStage: 'builder' });
    expect(new Set([tag0, tag1, tag2, tag3]).size).toBe(4);
  });

  it('emits a :local suffix so the tag never pretends to be a real registry', () => {
    const tag = buildImageOverrideTag('Svc', makeEntry());
    expect(tag.endsWith(':local')).toBe(true);
  });

  it('slugifies a CDK path with slashes into a docker-tag-safe segment', () => {
    const tag = buildImageOverrideTag('MyStack/AppService', makeEntry());
    // No `/` allowed in tag NAME segment (Docker rejects it).
    const repo = tag.split(':')[0]!;
    expect(repo).not.toMatch(/\//);
  });
});

describe('runImageOverrideBuilds argv shape (issue #238, T1)', () => {
  beforeEach(() => {
    runDockerStreamingMock.mockReset();
    runDockerStreamingMock.mockResolvedValue(undefined);
  });

  it('emits canonical `--build-arg KEY=VAL` for every build-args entry', async () => {
    const dockerfile = makeTmpDockerfile('Dockerfile.args');
    const overrides = new Map([
      [
        'AppService',
        {
          dockerfile,
          contextDir: path.dirname(dockerfile),
          buildArgs: new Map([
            ['NODE_ENV', 'production'],
            ['NPM_TOKEN', 'tok'],
          ]),
          buildSecrets: new Map<string, string>(),
        },
      ],
    ]);
    await runImageOverrideBuilds(overrides);
    expect(runDockerStreamingMock).toHaveBeenCalledTimes(1);
    const [args, opts] = runDockerStreamingMock.mock.calls[0]!;
    expect(args[0]).toBe('build');
    // --build-arg shows up as a (--build-arg, KEY=VAL) consecutive pair.
    const buildArgIdx = (args as string[]).indexOf('--build-arg');
    expect(buildArgIdx).toBeGreaterThan(-1);
    expect(args).toContain('NODE_ENV=production');
    expect(args).toContain('NPM_TOKEN=tok');
    // BUILDX_NO_DEFAULT_ATTESTATIONS=1 lives in env, not argv.
    expect(opts.env?.BUILDX_NO_DEFAULT_ATTESTATIONS).toBe('1');
  });

  it('emits canonical `--secret id=<id>,src=<src>` for every build-secrets entry', async () => {
    const dockerfile = makeTmpDockerfile('Dockerfile.secrets');
    const overrides = new Map([
      [
        'AppService',
        {
          dockerfile,
          contextDir: path.dirname(dockerfile),
          buildArgs: new Map<string, string>(),
          buildSecrets: new Map([['npmrc', '/abs/.npmrc']]),
        },
      ],
    ]);
    await runImageOverrideBuilds(overrides);
    const [args] = runDockerStreamingMock.mock.calls[0]!;
    const secretIdx = (args as string[]).indexOf('--secret');
    expect(secretIdx).toBeGreaterThan(-1);
    expect(args[secretIdx + 1]).toBe('id=npmrc,src=/abs/.npmrc');
  });

  it('emits `--target <stage>` when targetStage is set, omits it otherwise', async () => {
    const dockerfileA = makeTmpDockerfile('Dockerfile.stage-on');
    const dockerfileB = makeTmpDockerfile('Dockerfile.stage-off');
    await runImageOverrideBuilds(
      new Map([
        [
          'Svc',
          {
            dockerfile: dockerfileA,
            contextDir: path.dirname(dockerfileA),
            buildArgs: new Map<string, string>(),
            buildSecrets: new Map<string, string>(),
            targetStage: 'builder',
          },
        ],
      ])
    );
    let [args] = runDockerStreamingMock.mock.calls[0]!;
    let targetIdx = (args as string[]).indexOf('--target');
    expect(targetIdx).toBeGreaterThan(-1);
    expect(args[targetIdx + 1]).toBe('builder');

    runDockerStreamingMock.mockClear();
    await runImageOverrideBuilds(
      new Map([
        [
          'Svc',
          {
            dockerfile: dockerfileB,
            contextDir: path.dirname(dockerfileB),
            buildArgs: new Map<string, string>(),
            buildSecrets: new Map<string, string>(),
          },
        ],
      ])
    );
    [args] = runDockerStreamingMock.mock.calls[0]!;
    targetIdx = (args as string[]).indexOf('--target');
    expect(targetIdx, '--target must NOT appear when targetStage is unset').toBe(-1);
  });

  it('tags with `<resourceNamePrefix>-override-<svcSlug>-<hash>:local` + uses `-f <dockerfile>` + context dot', async () => {
    const dockerfile = makeTmpDockerfile('Dockerfile.shape');
    await runImageOverrideBuilds(
      new Map([
        [
          'AppService',
          {
            dockerfile,
            contextDir: path.dirname(dockerfile),
            buildArgs: new Map<string, string>(),
            buildSecrets: new Map<string, string>(),
          },
        ],
      ])
    );
    const [args, opts] = runDockerStreamingMock.mock.calls[0]!;
    // --tag <local-tag> directly after `build`.
    const tagIdx = (args as string[]).indexOf('--tag');
    expect(tagIdx).toBeGreaterThan(-1);
    const tag = args[tagIdx + 1] as string;
    expect(tag).toMatch(/-override-appservice-[0-9a-f]+:local$/);
    // -f <dockerfile>.
    const fIdx = (args as string[]).indexOf('--file');
    expect(fIdx).toBeGreaterThan(-1);
    expect(args[fIdx + 1]).toBe(dockerfile);
    // Build context = `.` (Dockerfile parent, via `cwd` opt).
    expect(args[args.length - 1]).toBe('.');
    expect(opts.cwd).toBe(path.dirname(dockerfile));
  });

  it('wraps a docker build failure with ImageOverrideError + stderr tail', async () => {
    const dockerfile = makeTmpDockerfile('Dockerfile.fail');
    runDockerStreamingMock.mockRejectedValueOnce(
      Object.assign(new Error('spawn failed'), {
        stderr: 'ERROR: failed to compute cache key: not found\n',
      })
    );
    await expect(
      runImageOverrideBuilds(
        new Map([
          [
            'BadSvc',
            {
              dockerfile,
              contextDir: path.dirname(dockerfile),
              buildArgs: new Map<string, string>(),
              buildSecrets: new Map<string, string>(),
            },
          ],
        ])
      )
    ).rejects.toMatchObject({
      name: 'ImageOverrideError',
      message: expect.stringMatching(/failed to compute cache key/),
    });
  });
});

describe('parseImageOverrideFlags --image-build-secret src resolution (M1)', () => {
  it('resolves a relative `src` against process.cwd()', () => {
    const out = parseImageOverrideFlags({
      imageBuildSecret: ['npmrc=./.npmrc'],
    });
    const resolved = out.globals.buildSecrets.get('npmrc');
    expect(resolved).toBe(path.resolve(process.cwd(), './.npmrc'));
    expect(path.isAbsolute(resolved!)).toBe(true);
  });

  it('passes through an already-absolute `src`', () => {
    const out = parseImageOverrideFlags({
      imageBuildSecret: ['token=/etc/secrets/token.txt'],
    });
    expect(out.globals.buildSecrets.get('token')).toBe('/etc/secrets/token.txt');
  });
});

describe('parseImageOverrideFlags --image-build-arg empty-value semantics (issue #242 / M2)', () => {
  // Issue #242 M2: `--image-build-arg KEY=` (empty VALUE) is accepted
  // and forwarded verbatim to `docker build --build-arg KEY=`, which
  // docker itself accepts (the canonical way to unset a Dockerfile
  // `ARG`'s default). Empty KEY is still rejected.
  it('accepts an empty value (`KEY=`) and surfaces it as the empty string', () => {
    const out = parseImageOverrideFlags({ imageBuildArg: ['KEY='] });
    expect(out.globals.buildArgs.get('KEY')).toBe('');
  });

  it('still rejects an empty key (`=value`)', () => {
    expect(() => parseImageOverrideFlags({ imageBuildArg: ['=value'] })).toThrow(/KEY=VAL/);
  });

  it('mixes empty-value and populated entries in one invocation', () => {
    const out = parseImageOverrideFlags({
      imageBuildArg: ['UNSET=', 'NODE_ENV=production'],
    });
    expect(Array.from(out.globals.buildArgs.entries())).toEqual([
      ['UNSET', ''],
      ['NODE_ENV', 'production'],
    ]);
  });
});

describe('makeEntryFromPath path-resolution edge cases (issue #242)', () => {
  // The `makeEntryFromPath` helper is exercised through `resolveImageOverrides`
  // (Stage 1 explicit mapping is the simplest covered call site). The next
  // three tests pin two branches the existing grid covered only on the happy
  // path: absolute paths pass through, relative paths resolve against `cwd`,
  // and a path that resolves to a DIRECTORY raises the "not a regular file"
  // ImageOverrideError up-front (before any docker build runs).

  const dirsToCleanup: string[] = [];
  afterEach(() => {
    for (const dir of dirsToCleanup.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it('passes an absolute Dockerfile path through unchanged', async () => {
    const dockerfile = makeTmpDockerfile('Dockerfile.abs');
    expect(path.isAbsolute(dockerfile)).toBe(true);
    const rawFlags = parseImageOverrideFlags({
      imageOverride: [`Svc=${dockerfile}`],
    });
    const overrides = await resolveImageOverrides({
      rawFlags,
      pinnedTargets: ['Svc'],
    });
    expect(overrides.get('Svc')?.dockerfile).toBe(dockerfile);
    expect(overrides.get('Svc')?.contextDir).toBe(path.dirname(dockerfile));
  });

  it('resolves a relative Dockerfile path against the supplied `cwd`', async () => {
    // makeTmpDockerfile gives us an absolute path under a tmp dir; we
    // re-derive a RELATIVE form (basename) and feed `cwd=<tmp>` so the
    // resolver lands at the same absolute path the helper produced.
    const dockerfile = makeTmpDockerfile('Dockerfile.rel');
    const baseDir = path.dirname(dockerfile);
    const baseName = path.basename(dockerfile);
    const rawFlags = parseImageOverrideFlags({
      imageOverride: [`Svc=${baseName}`],
    });
    const overrides = await resolveImageOverrides({
      rawFlags,
      pinnedTargets: ['Svc'],
      cwd: baseDir,
    });
    expect(overrides.get('Svc')?.dockerfile).toBe(path.resolve(baseDir, baseName));
    expect(overrides.get('Svc')?.contextDir).toBe(baseDir);
  });

  it('rejects a path that resolves to a directory with "not a regular file"', async () => {
    // mkdtempSync gives an absolute directory path; passing it where a
    // Dockerfile is expected must surface the existsSync-passes-but-
    // isFile-fails branch in `makeEntryFromPath`. The test asserts the
    // ImageOverrideError + the message names the directory anchor so a
    // future refactor that swallows the branch into a generic "missing"
    // surface is caught.
    const dirPath = mkdtempSync(path.join(tmpdir(), 'cdkl-override-dir-'));
    dirsToCleanup.push(dirPath);
    const rawFlags = parseImageOverrideFlags({
      imageOverride: [`Svc=${dirPath}`],
    });
    await expect(
      resolveImageOverrides({ rawFlags, pinnedTargets: ['Svc'] })
    ).rejects.toMatchObject({
      name: 'ImageOverrideError',
      message: expect.stringMatching(/not a regular file/),
    });
  });
});

describe('runImageOverrideBuilds partial-failure rollback (issue #242 / N3)', () => {
  // N3: when the Nth build fails, the 1..(N-1) previously built tags are
  // best-effort `docker image rm`'d before the ImageOverrideError is
  // re-thrown. Cleanup failures are swallowed at debug — the original
  // build error stays the surfaced one.

  beforeEach(() => {
    runDockerStreamingMock.mockReset();
  });

  it('runs `docker image rm <tag>` for every previously built tag on mid-run failure', async () => {
    // Three targets; the 2nd build fails. The 1st target's tag should
    // receive a `docker image rm` cleanup call; the 3rd never builds
    // (the loop throws before reaching it).
    const dockerfileA = makeTmpDockerfile('Dockerfile.rb-a');
    const dockerfileB = makeTmpDockerfile('Dockerfile.rb-b');
    const dockerfileC = makeTmpDockerfile('Dockerfile.rb-c');
    let callIdx = 0;
    runDockerStreamingMock.mockImplementation((args: string[]) => {
      callIdx += 1;
      if (args[0] === 'build' && callIdx === 2) {
        // 2nd build (target B) — fail.
        return Promise.reject(
          Object.assign(new Error('spawn failed'), {
            stderr: 'ERROR: cache key not found\n',
          })
        );
      }
      return Promise.resolve(undefined);
    });
    const overrides = new Map([
      [
        'A',
        {
          dockerfile: dockerfileA,
          contextDir: path.dirname(dockerfileA),
          buildArgs: new Map<string, string>(),
          buildSecrets: new Map<string, string>(),
        },
      ],
      [
        'B',
        {
          dockerfile: dockerfileB,
          contextDir: path.dirname(dockerfileB),
          buildArgs: new Map<string, string>(),
          buildSecrets: new Map<string, string>(),
        },
      ],
      [
        'C',
        {
          dockerfile: dockerfileC,
          contextDir: path.dirname(dockerfileC),
          buildArgs: new Map<string, string>(),
          buildSecrets: new Map<string, string>(),
        },
      ],
    ]);
    await expect(runImageOverrideBuilds(overrides)).rejects.toBeInstanceOf(ImageOverrideError);
    // Inspect the recorded calls. Expect:
    //   - build A (success)
    //   - build B (failure)
    //   - image rm <tag-A> (rollback)
    // C never builds; only A's tag is in the rollback list.
    const calls = runDockerStreamingMock.mock.calls.map(([args]) => args as string[]);
    const rmCalls = calls.filter((a) => a[0] === 'image' && a[1] === 'rm');
    expect(rmCalls.length).toBe(1);
    // Tag-A shape: derived from buildImageOverrideTag for the A entry.
    const tagA = buildImageOverrideTag('A', {
      dockerfile: dockerfileA,
      contextDir: path.dirname(dockerfileA),
      buildArgs: new Map<string, string>(),
      buildSecrets: new Map<string, string>(),
    });
    expect(rmCalls[0]![2]).toBe(tagA);
  });

  it('propagates the ORIGINAL ImageOverrideError when the cleanup step itself fails', async () => {
    // Build A succeeds, build B fails, then `image rm tag-A` ALSO fails.
    // The thrown value MUST be the build-failure ImageOverrideError (not
    // the cleanup error) so the user sees the actionable build message.
    const dockerfileA = makeTmpDockerfile('Dockerfile.rb-orig-a');
    const dockerfileB = makeTmpDockerfile('Dockerfile.rb-orig-b');
    let callIdx = 0;
    runDockerStreamingMock.mockImplementation((args: string[]) => {
      callIdx += 1;
      if (args[0] === 'build' && callIdx === 2) {
        return Promise.reject(
          Object.assign(new Error('spawn failed'), {
            stderr: 'ERROR: original build failure stderr\n',
          })
        );
      }
      if (args[0] === 'image' && args[1] === 'rm') {
        return Promise.reject(new Error('rm failed: image is in use'));
      }
      return Promise.resolve(undefined);
    });
    const overrides = new Map([
      [
        'A',
        {
          dockerfile: dockerfileA,
          contextDir: path.dirname(dockerfileA),
          buildArgs: new Map<string, string>(),
          buildSecrets: new Map<string, string>(),
        },
      ],
      [
        'B',
        {
          dockerfile: dockerfileB,
          contextDir: path.dirname(dockerfileB),
          buildArgs: new Map<string, string>(),
          buildSecrets: new Map<string, string>(),
        },
      ],
    ]);
    await expect(runImageOverrideBuilds(overrides)).rejects.toMatchObject({
      name: 'ImageOverrideError',
      // The thrown error must carry the BUILD failure stderr, not the
      // cleanup error's "rm failed" message.
      message: expect.stringMatching(/original build failure stderr/),
    });
  });

  it('does NOT call `docker image rm` when the FIRST build fails (no prior tags to clean up)', async () => {
    const dockerfile = makeTmpDockerfile('Dockerfile.rb-first');
    runDockerStreamingMock.mockImplementation((args: string[]) => {
      if (args[0] === 'build') {
        return Promise.reject(
          Object.assign(new Error('boom'), { stderr: 'first build failed\n' })
        );
      }
      return Promise.resolve(undefined);
    });
    const overrides = new Map([
      [
        'Solo',
        {
          dockerfile,
          contextDir: path.dirname(dockerfile),
          buildArgs: new Map<string, string>(),
          buildSecrets: new Map<string, string>(),
        },
      ],
    ]);
    await expect(runImageOverrideBuilds(overrides)).rejects.toBeInstanceOf(ImageOverrideError);
    const calls = runDockerStreamingMock.mock.calls.map(([args]) => args as string[]);
    const rmCalls = calls.filter((a) => a[0] === 'image' && a[1] === 'rm');
    expect(rmCalls.length).toBe(0);
  });
});

describe('resolveImageOverrides Stage 3 boot prompt skip sentinels (M3)', () => {
  // The boot prompt accepts any case variant of `n` / `no` as a skip.
  // The interactive prompt itself is TTY-gated and can't be driven in a
  // unit-test runner; the next two tests pin the SHAPE of the skip
  // sentinel set by reading the engine source (the loop body that
  // decides skip vs override). This is OK as a fallback for a
  // prompt-gated branch: behavioral coverage requires a real terminal
  // (covered at integ level), while the sentinel set itself is what
  // the user-facing UX depends on, so a regression that re-narrowed
  // it to `value.toUpperCase() === 'N'` would silently break `no` /
  // `No` / `NO` users.
  it('engine source recognizes n / no (any case) as skip sentinels', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const ENGINE_SOURCE = path.join(here, '../../../src/local/image-override-engine.ts');
    const source = readFileSync(ENGINE_SOURCE, 'utf-8');
    // The Stage-3 prompt block uses a `lower` variable to normalize
    // case + compares against both `'n'` and `'no'`. Pin both
    // expectations explicitly.
    expect(source).toMatch(/value\.toLowerCase\(\)/);
    expect(source).toMatch(/lower === 'n'/);
    expect(source).toMatch(/lower === 'no'/);
    // And the text-fallback prompt copy must contain the new
    // [Dockerfile path / N / blank=skip] hint introduced for #258.
    expect(source).toMatch(/\[Dockerfile path \/ N \/ blank=skip\]/);
  });
});

// =============================================================================
// Issue #240 — per-service variants of --image-build-arg /
// --image-build-secret / --image-target.
// =============================================================================

describe('parseImageOverrideFlags per-service form (issue #240)', () => {
  it('parses --image-build-arg <svc>:KEY=VAL into perService', () => {
    const out = parseImageOverrideFlags({
      imageBuildArg: ['AppService:NODE_ENV=production'],
    });
    expect(out.globals.buildArgs.size).toBe(0);
    expect(out.perService.size).toBe(1);
    const overlay = out.perService.get('AppService');
    expect(overlay?.buildArgs.get('NODE_ENV')).toBe('production');
  });

  it('parses --image-build-secret <svc>:id=src into perService (src resolved abs)', () => {
    const out = parseImageOverrideFlags({
      imageBuildSecret: ['AppService:npmrc=./.npmrc-private'],
    });
    expect(out.globals.buildSecrets.size).toBe(0);
    const overlay = out.perService.get('AppService');
    expect(overlay?.buildSecrets.get('npmrc')).toBe(path.resolve(process.cwd(), './.npmrc-private'));
  });

  it('parses --image-target <svc>=<stage> into perService', () => {
    const out = parseImageOverrideFlags({
      imageTarget: ['AppService=builder'],
    });
    expect(out.globals.targetStage).toBeUndefined();
    expect(out.perService.get('AppService')?.targetStage).toBe('builder');
  });

  it('mixes global + per-service for --image-build-arg in one invocation', () => {
    const out = parseImageOverrideFlags({
      imageBuildArg: ['KEY=global', 'AppService:KEY=appOnly', 'OtherSvc:OTHER=val'],
    });
    expect(out.globals.buildArgs.get('KEY')).toBe('global');
    expect(out.perService.get('AppService')?.buildArgs.get('KEY')).toBe('appOnly');
    expect(out.perService.get('OtherSvc')?.buildArgs.get('OTHER')).toBe('val');
  });

  it('accepts --image-target as an array (global + per-service mix)', () => {
    const out = parseImageOverrideFlags({
      imageTarget: ['builder', 'AppService=release', 'Reporting=runtime'],
    });
    expect(out.globals.targetStage).toBe('builder');
    expect(out.perService.get('AppService')?.targetStage).toBe('release');
    expect(out.perService.get('Reporting')?.targetStage).toBe('runtime');
  });

  it('rejects --image-build-arg <svc>:= (empty key after prefix)', () => {
    expect(() => parseImageOverrideFlags({ imageBuildArg: ['AppService:=val'] })).toThrow(
      /<service>:KEY=VAL/
    );
  });

  it('accepts --image-build-arg <svc>:KEY= (empty VALUE) per global semantics', () => {
    // Empty VALUE is canonical "unset the ARG default". Per-service form
    // mirrors that semantic.
    const out = parseImageOverrideFlags({
      imageBuildArg: ['AppService:UNSET='],
    });
    expect(out.perService.get('AppService')?.buildArgs.get('UNSET')).toBe('');
  });

  it('rejects --image-build-secret <svc>:id= or <svc>:=src (both halves required)', () => {
    expect(() =>
      parseImageOverrideFlags({ imageBuildSecret: ['AppService:id='] })
    ).toThrow(/non-empty/);
    expect(() =>
      parseImageOverrideFlags({ imageBuildSecret: ['AppService:=src'] })
    ).toThrow();
  });

  it('rejects --image-target <svc>= (empty stage)', () => {
    expect(() => parseImageOverrideFlags({ imageTarget: ['AppService='] })).toThrow(
      /right side .* is empty/
    );
  });

  it('rejects --image-target =stage (empty service)', () => {
    expect(() => parseImageOverrideFlags({ imageTarget: ['=stage'] })).toThrow(
      /left side .* is empty/
    );
  });

  it('keeps a `KEY=val:with:colons` global form un-misparsed (= before :)', () => {
    // The `:` after the `=` is part of the VALUE, not a service prefix.
    // Pin this so a future refactor of the splitter cannot silently
    // start treating `=val:bar` as a per-service form.
    const out = parseImageOverrideFlags({
      imageBuildArg: ['KEY=val:with:colons'],
    });
    expect(out.globals.buildArgs.get('KEY')).toBe('val:with:colons');
    expect(out.perService.size).toBe(0);
  });

  it('last-write-wins for repeated per-service entries on same <svc>:KEY', () => {
    const out = parseImageOverrideFlags({
      imageBuildArg: ['AppService:KEY=first', 'AppService:KEY=second'],
    });
    expect(out.perService.get('AppService')?.buildArgs.get('KEY')).toBe('second');
  });
});

describe('mergeForService precedence (issue #240)', () => {
  it('per-service buildArgs overrides global on key collision', () => {
    const merged = mergeForService(
      'AppService',
      { buildArgs: new Map([['KEY', 'global']]), buildSecrets: new Map() },
      new Map([
        [
          'AppService',
          { buildArgs: new Map([['KEY', 'perSvc']]), buildSecrets: new Map() },
        ],
      ])
    );
    expect(merged.buildArgs.get('KEY')).toBe('perSvc');
  });

  it('non-overlapping keys merge — global K1 + per-service K2 both present', () => {
    const merged = mergeForService(
      'AppService',
      { buildArgs: new Map([['K1', 'g']]), buildSecrets: new Map() },
      new Map([
        [
          'AppService',
          { buildArgs: new Map([['K2', 'p']]), buildSecrets: new Map() },
        ],
      ])
    );
    expect(merged.buildArgs.get('K1')).toBe('g');
    expect(merged.buildArgs.get('K2')).toBe('p');
  });

  it('per-service buildSecrets overrides global on id collision', () => {
    const merged = mergeForService(
      'AppService',
      {
        buildArgs: new Map(),
        buildSecrets: new Map([['npmrc', '/abs/global']]),
      },
      new Map([
        [
          'AppService',
          {
            buildArgs: new Map(),
            buildSecrets: new Map([['npmrc', '/abs/perSvc']]),
          },
        ],
      ])
    );
    expect(merged.buildSecrets.get('npmrc')).toBe('/abs/perSvc');
  });

  it('per-service targetStage overrides global', () => {
    const merged = mergeForService(
      'AppService',
      { buildArgs: new Map(), buildSecrets: new Map(), targetStage: 'builder' },
      new Map([
        [
          'AppService',
          {
            buildArgs: new Map(),
            buildSecrets: new Map(),
            targetStage: 'release',
          },
        ],
      ])
    );
    expect(merged.targetStage).toBe('release');
  });

  it('falls back to global when the per-service overlay omits targetStage', () => {
    const merged = mergeForService(
      'AppService',
      { buildArgs: new Map(), buildSecrets: new Map(), targetStage: 'builder' },
      new Map([
        [
          'AppService',
          { buildArgs: new Map([['K', 'v']]), buildSecrets: new Map() },
        ],
      ])
    );
    expect(merged.targetStage).toBe('builder');
  });

  it('returns a FRESH map (mutations do not bleed into the shared globals)', () => {
    const globals = { buildArgs: new Map([['K', 'g']]), buildSecrets: new Map() };
    const merged = mergeForService('X', globals, new Map());
    merged.buildArgs.set('K', 'mutated');
    expect(globals.buildArgs.get('K')).toBe('g');
  });

  it('global passes through unchanged when the service has no overlay', () => {
    const merged = mergeForService(
      'UnrelatedService',
      { buildArgs: new Map([['K', 'g']]), buildSecrets: new Map(), targetStage: 'builder' },
      new Map([
        [
          'AppService',
          { buildArgs: new Map([['K', 'pp']]), buildSecrets: new Map() },
        ],
      ])
    );
    expect(merged.buildArgs.get('K')).toBe('g');
    expect(merged.targetStage).toBe('builder');
  });
});

describe('resolveImageOverrides — per-service overlay threads into entry (issue #240)', () => {
  it('a per-service buildArg lands on its target only; global covers others', async () => {
    const dockerfileA = makeTmpDockerfile('Dockerfile.app');
    const dockerfileB = makeTmpDockerfile('Dockerfile.auth');
    const rawFlags = parseImageOverrideFlags({
      imageOverride: [`AppService=${dockerfileA}`, `AuthService=${dockerfileB}`],
      imageBuildArg: ['NODE_ENV=production', 'AppService:NPM_TOKEN=secret123'],
    });
    const overrides = await resolveImageOverrides({
      rawFlags,
      pinnedTargets: ['AppService', 'AuthService'],
    });
    const app = overrides.get('AppService');
    const auth = overrides.get('AuthService');
    // Both get the global NODE_ENV.
    expect(app?.buildArgs.get('NODE_ENV')).toBe('production');
    expect(auth?.buildArgs.get('NODE_ENV')).toBe('production');
    // Only AppService gets the per-service NPM_TOKEN.
    expect(app?.buildArgs.get('NPM_TOKEN')).toBe('secret123');
    expect(auth?.buildArgs.get('NPM_TOKEN')).toBeUndefined();
  });

  it('per-service value overrides global on the same key for the named target', async () => {
    const dockerfile = makeTmpDockerfile('Dockerfile.coll');
    const rawFlags = parseImageOverrideFlags({
      imageOverride: [`AppService=${dockerfile}`],
      imageBuildArg: ['KEY=global', 'AppService:KEY=appOnly'],
    });
    const overrides = await resolveImageOverrides({
      rawFlags,
      pinnedTargets: ['AppService'],
    });
    expect(overrides.get('AppService')?.buildArgs.get('KEY')).toBe('appOnly');
  });

  it('per-service targetStage overrides global on the named target', async () => {
    const dockerfileA = makeTmpDockerfile('Dockerfile.stageA');
    const dockerfileB = makeTmpDockerfile('Dockerfile.stageB');
    const rawFlags = parseImageOverrideFlags({
      imageOverride: [`AppService=${dockerfileA}`, `Reporting=${dockerfileB}`],
      imageTarget: ['builder', 'Reporting=runtime'],
    });
    const overrides = await resolveImageOverrides({
      rawFlags,
      pinnedTargets: ['AppService', 'Reporting'],
    });
    expect(overrides.get('AppService')?.targetStage).toBe('builder');
    expect(overrides.get('Reporting')?.targetStage).toBe('runtime');
  });
});

describe('runImageOverrideBuilds — per-service argv assembly (issue #240)', () => {
  beforeEach(() => {
    runDockerStreamingMock.mockReset();
    runDockerStreamingMock.mockResolvedValue(undefined);
  });

  it('emits the correct --build-arg pair per target (per-service does not bleed)', async () => {
    const dockerfileA = makeTmpDockerfile('Dockerfile.argA');
    const dockerfileB = makeTmpDockerfile('Dockerfile.argB');
    const rawFlags = parseImageOverrideFlags({
      imageOverride: [`AppService=${dockerfileA}`, `AuthService=${dockerfileB}`],
      imageBuildArg: ['NODE_ENV=production', 'AppService:NPM_TOKEN=secret'],
    });
    const overrides = await resolveImageOverrides({
      rawFlags,
      pinnedTargets: ['AppService', 'AuthService'],
    });
    await runImageOverrideBuilds(overrides);
    expect(runDockerStreamingMock).toHaveBeenCalledTimes(2);
    const calls = runDockerStreamingMock.mock.calls.map(([a]) => a as string[]);
    // Determine which build invocation was App vs Auth by `--file` value.
    const appCall = calls.find((a) => a[a.indexOf('--file') + 1] === dockerfileA)!;
    const authCall = calls.find((a) => a[a.indexOf('--file') + 1] === dockerfileB)!;
    expect(appCall).toContain('NODE_ENV=production');
    expect(appCall).toContain('NPM_TOKEN=secret');
    expect(authCall).toContain('NODE_ENV=production');
    // AuthService MUST NOT carry the per-service NPM_TOKEN.
    expect(authCall).not.toContain('NPM_TOKEN=secret');
  });

  it('emits the correct --secret pair per target (per-service overrides on id collision)', async () => {
    const dockerfileA = makeTmpDockerfile('Dockerfile.secA');
    const dockerfileB = makeTmpDockerfile('Dockerfile.secB');
    const rawFlags = parseImageOverrideFlags({
      imageOverride: [`AppService=${dockerfileA}`, `Reporting=${dockerfileB}`],
      imageBuildSecret: [
        'AppService:npmrc=/abs/.npmrc-private',
        'Reporting:npmrc=/abs/.npmrc-public',
      ],
    });
    const overrides = await resolveImageOverrides({
      rawFlags,
      pinnedTargets: ['AppService', 'Reporting'],
    });
    await runImageOverrideBuilds(overrides);
    const calls = runDockerStreamingMock.mock.calls.map(([a]) => a as string[]);
    const appCall = calls.find((a) => a[a.indexOf('--file') + 1] === dockerfileA)!;
    const repCall = calls.find((a) => a[a.indexOf('--file') + 1] === dockerfileB)!;
    expect(appCall).toContain('id=npmrc,src=/abs/.npmrc-private');
    expect(repCall).toContain('id=npmrc,src=/abs/.npmrc-public');
  });

  it('emits --target per-service when only one target carries a per-service stage', async () => {
    const dockerfileA = makeTmpDockerfile('Dockerfile.tA');
    const dockerfileB = makeTmpDockerfile('Dockerfile.tB');
    const rawFlags = parseImageOverrideFlags({
      imageOverride: [`AppService=${dockerfileA}`, `Reporting=${dockerfileB}`],
      imageTarget: ['Reporting=runtime'],
    });
    const overrides = await resolveImageOverrides({
      rawFlags,
      pinnedTargets: ['AppService', 'Reporting'],
    });
    await runImageOverrideBuilds(overrides);
    const calls = runDockerStreamingMock.mock.calls.map(([a]) => a as string[]);
    const appCall = calls.find((a) => a[a.indexOf('--file') + 1] === dockerfileA)!;
    const repCall = calls.find((a) => a[a.indexOf('--file') + 1] === dockerfileB)!;
    expect(appCall.indexOf('--target')).toBe(-1);
    const tIdx = repCall.indexOf('--target');
    expect(tIdx).toBeGreaterThan(-1);
    expect(repCall[tIdx + 1]).toBe('runtime');
  });
});

describe('enforceImageOverrideOrphans (issue #240)', () => {
  function dockerfile(): string {
    return makeTmpDockerfile('Dockerfile.orphan');
  }

  it('no-op when no per-service flag was passed', async () => {
    const rawFlags = parseImageOverrideFlags({
      imageOverride: [`AppService=${dockerfile()}`],
      imageBuildArg: ['NODE_ENV=production'],
    });
    const overrides = await resolveImageOverrides({
      rawFlags,
      pinnedTargets: ['AppService'],
    });
    expect(() => enforceImageOverrideOrphans(rawFlags, overrides)).not.toThrow();
  });

  it('throws LocalStartServiceError when a per-service build-arg names an uncovered service', async () => {
    // `--image-build-arg AppService:KEY=val` but `--image-override` only
    // covers AuthService — AppService is an orphan.
    const rawFlags = parseImageOverrideFlags({
      imageOverride: [`AuthService=${dockerfile()}`],
      imageBuildArg: ['AppService:KEY=val'],
    });
    const overrides = await resolveImageOverrides({
      rawFlags,
      pinnedTargets: ['AuthService'],
    });
    expect(() => enforceImageOverrideOrphans(rawFlags, overrides)).toThrow(
      LocalStartServiceError
    );
    try {
      enforceImageOverrideOrphans(rawFlags, overrides);
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/--image-build-arg AppService:KEY/);
      expect(msg).toMatch(/no --image-override mapping/);
    }
  });

  it('throws naming every offending flag kind for the same orphan service', async () => {
    const rawFlags = parseImageOverrideFlags({
      imageOverride: [`AuthService=${dockerfile()}`],
      imageBuildArg: ['AppService:K=v'],
      imageBuildSecret: ['AppService:npmrc=/abs/.npmrc'],
      imageTarget: ['AppService=builder'],
    });
    const overrides = await resolveImageOverrides({
      rawFlags,
      pinnedTargets: ['AuthService'],
    });
    try {
      enforceImageOverrideOrphans(rawFlags, overrides);
      expect.fail('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/--image-build-arg AppService/);
      expect(msg).toMatch(/--image-build-secret AppService/);
      expect(msg).toMatch(/--image-target AppService=builder/);
    }
  });

  it('does NOT throw when the per-service flag names a covered service', async () => {
    const rawFlags = parseImageOverrideFlags({
      imageOverride: [`AppService=${dockerfile()}`],
      imageBuildArg: ['AppService:KEY=val'],
    });
    const overrides = await resolveImageOverrides({
      rawFlags,
      pinnedTargets: ['AppService'],
    });
    expect(() => enforceImageOverrideOrphans(rawFlags, overrides)).not.toThrow();
  });

  it('lists multiple orphan services in one message', async () => {
    const rawFlags = parseImageOverrideFlags({
      imageOverride: [`Covered=${dockerfile()}`],
      imageBuildArg: ['Orphan1:K=v', 'Orphan2:K=v'],
    });
    const overrides = await resolveImageOverrides({
      rawFlags,
      pinnedTargets: ['Covered'],
    });
    try {
      enforceImageOverrideOrphans(rawFlags, overrides);
      expect.fail('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/Orphan1/);
      expect(msg).toMatch(/Orphan2/);
    }
  });
});

// =============================================================================
// Issue #260 — tilde expansion in --image-build-secret / --image-override
// =============================================================================

describe('expandTilde (issue #260)', () => {
  it('expands `~/<rest>` to `<HOME>/<rest>`', () => {
    expect(expandTilde('~/.npmrc')).toBe(path.join(homedir(), '.npmrc'));
    expect(expandTilde('~/work/foo.txt')).toBe(path.join(homedir(), 'work/foo.txt'));
  });

  it('expands bare `~` to `<HOME>`', () => {
    expect(expandTilde('~')).toBe(homedir());
  });

  it('passes `~user/foo` through unchanged (named-user form unsupported)', () => {
    // Node has no built-in to resolve an arbitrary username to a home
    // directory, so the named-user form is intentionally left as-is.
    // `docker build` will surface a clear "no such file" if the user
    // actually meant a literal `~user/...` path.
    expect(expandTilde('~root/etc/passwd')).toBe('~root/etc/passwd');
  });

  it('passes an absolute path through unchanged', () => {
    expect(expandTilde('/abs/path')).toBe('/abs/path');
  });

  it('passes a relative path with no leading tilde through unchanged', () => {
    expect(expandTilde('./relative/path')).toBe('./relative/path');
    expect(expandTilde('relative/path')).toBe('relative/path');
  });
});

describe('parseImageOverrideFlags --image-build-secret tilde expansion (issue #260)', () => {
  it('resolves `~/.npmrc` to `<HOME>/.npmrc` for the global build-secret form', () => {
    const out = parseImageOverrideFlags({
      imageBuildSecret: ['npmrc=~/.npmrc'],
    });
    // The repro command in #260 was
    // `--image-build-secret npmrc=~/.npmrc` — pin that exact shape so
    // a future refactor that drops the tilde-expansion silently breaks
    // the documented npm-secret recipe again.
    expect(out.globals.buildSecrets.get('npmrc')).toBe(path.join(homedir(), '.npmrc'));
  });

  it('resolves `~/.npmrc` to `<HOME>/.npmrc` for the per-service build-secret form', () => {
    const out = parseImageOverrideFlags({
      imageBuildSecret: ['AppService:npmrc=~/.npmrc'],
    });
    const overlay = out.perService.get('AppService');
    expect(overlay?.buildSecrets.get('npmrc')).toBe(path.join(homedir(), '.npmrc'));
  });

  it('resolves bare `~` for a build-secret src', () => {
    const out = parseImageOverrideFlags({
      imageBuildSecret: ['homedir=~'],
    });
    expect(out.globals.buildSecrets.get('homedir')).toBe(homedir());
  });
});

describe('makeEntryFromPath tilde expansion for --image-override path (issue #260)', () => {
  let tmpHomeDockerfile: string;
  let originalHome: string | undefined;
  let scratchHome: string;

  beforeEach(() => {
    // Stage a fake $HOME so the test can put a Dockerfile under it
    // without touching the real home directory, then re-route
    // `homedir()` via $HOME (Node's `os.homedir()` consults $HOME on
    // POSIX, USERPROFILE on Windows — POSIX is the CI target). The
    // re-route survives only for the duration of this describe.
    scratchHome = mkdtempSync(path.join(tmpdir(), 'cdkl-override-home-'));
    tmpHomeDockerfile = path.join(scratchHome, 'Dockerfile');
    writeFileSync(tmpHomeDockerfile, 'FROM scratch\n');
    originalHome = process.env.HOME;
    process.env.HOME = scratchHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try {
      rmSync(scratchHome, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('resolves `~/Dockerfile` to `<HOME>/Dockerfile` for the explicit form', async () => {
    const rawFlags = parseImageOverrideFlags({
      imageOverride: ['Svc=~/Dockerfile'],
    });
    const overrides = await resolveImageOverrides({
      rawFlags,
      pinnedTargets: ['Svc'],
    });
    expect(overrides.get('Svc')?.dockerfile).toBe(tmpHomeDockerfile);
    expect(overrides.get('Svc')?.contextDir).toBe(scratchHome);
  });
});

// =============================================================================
// Issue #259 — Dockerfile auto-detect picker
// =============================================================================

describe('discoverDockerfiles (issue #259)', () => {
  let scanRoot: string;

  beforeEach(() => {
    scanRoot = mkdtempSync(path.join(tmpdir(), 'cdkl-override-scan-'));
  });

  afterEach(() => {
    try {
      rmSync(scanRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  function writeFile(rel: string, body = 'FROM scratch\n'): string {
    const abs = path.join(scanRoot, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
    return abs;
  }

  it('finds top-level Dockerfile + nested Dockerfile.* and excludes ignored dirs', () => {
    writeFile('Dockerfile');
    writeFile('services/app/Dockerfile');
    writeFile('services/auth/Dockerfile.prod');
    // Excluded paths — must NOT appear in the result.
    writeFile('node_modules/pkg/Dockerfile');
    writeFile('.git/Dockerfile');
    writeFile('cdk.out/asset.abc/Dockerfile');
    writeFile('dist/Dockerfile');
    writeFile('.next/Dockerfile');
    writeFile('.cache/Dockerfile');

    const found = discoverDockerfiles(scanRoot);
    // Every returned path is relative-to-cwd with a `./` prefix.
    expect(found.every((p) => p.startsWith('./'))).toBe(true);
    expect(found).toContain('./Dockerfile');
    expect(found).toContain('./services/app/Dockerfile');
    expect(found).toContain('./services/auth/Dockerfile.prod');
    expect(found.some((p) => p.includes('node_modules'))).toBe(false);
    expect(found.some((p) => p.includes('.git/'))).toBe(false);
    expect(found.some((p) => p.includes('cdk.out'))).toBe(false);
    expect(found.some((p) => p.includes('dist/'))).toBe(false);
    expect(found.some((p) => p.includes('.next'))).toBe(false);
    expect(found.some((p) => p.includes('.cache'))).toBe(false);
  });

  it('caps the result at 10 most-recently-modified entries in a large tree', () => {
    // 15 Dockerfiles, mtime-stamped in known order. The cap is 10
    // (DOCKERFILE_SCAN_CAP) so only the 10 newest must come back.
    for (let i = 0; i < 15; i++) {
      writeFile(`svc-${i}/Dockerfile`);
    }
    const found = discoverDockerfiles(scanRoot);
    expect(found.length).toBe(10);
  });

  it('returns an empty array when no Dockerfile exists under cwd', () => {
    writeFile('package.json', '{}');
    writeFile('src/index.ts', '// noop');
    expect(discoverDockerfiles(scanRoot)).toEqual([]);
  });

  it('skips a `dockerfile` file (lowercase) — case-sensitive by design', () => {
    // Docker itself does NOT auto-pick `dockerfile` lowercase as the
    // build file; mirror that convention so the picker doesn't
    // surface a file that wouldn't behave as a Dockerfile.
    writeFile('dockerfile');
    expect(discoverDockerfiles(scanRoot)).toEqual([]);
  });
});

// =============================================================================
// Issue #258 — boot-prompt intro copy + per-target prompt picker shape
// =============================================================================

describe('IMAGE_OVERRIDE_BOOT_PROMPT_INTRO copy (issue #258)', () => {
  // The intro string is the user-visible "why is this prompt firing?"
  // copy that surfaces ONCE per session right before the first Stage 3
  // per-target prompt. Pin the load-bearing phrases so a future
  // re-word that loses one of them is caught at test time.
  it('names the deployed-image binding the user is overriding', () => {
    expect(IMAGE_OVERRIDE_BOOT_PROMPT_INTRO).toMatch(/deployed container image/);
    expect(IMAGE_OVERRIDE_BOOT_PROMPT_INTRO).toMatch(/fromEcrRepository/);
  });

  it('names what happens when the user enters a path (local docker build)', () => {
    expect(IMAGE_OVERRIDE_BOOT_PROMPT_INTRO).toMatch(/local `docker build`/);
  });

  it('names what happens when the user skips (blank / N)', () => {
    expect(IMAGE_OVERRIDE_BOOT_PROMPT_INTRO).toMatch(/leave blank or type N/);
  });

  it('names the --no-interactive-overrides opt-out for next time', () => {
    expect(IMAGE_OVERRIDE_BOOT_PROMPT_INTRO).toMatch(/--no-interactive-overrides/);
  });
});

describe('Stage 3 boot prompt source-level binding (issues #258 + #259)', () => {
  // Stage 3 is TTY-gated and can't be driven from a unit-test runner.
  // We pin the source-level wiring of the new UX so a regression that
  // drops the intro-once flag, the auto-detect call, or the
  // select-or-text branching is caught here.
  it('intro is emitted ONCE per session (introShown flag in the loop)', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const ENGINE_SOURCE = path.join(here, '../../../src/local/image-override-engine.ts');
    const source = readFileSync(ENGINE_SOURCE, 'utf-8');
    // The Stage 3 loop must:
    //   1. initialize an `introShown` flag BEFORE the loop;
    //   2. fire the intro inside the loop only when !introShown;
    //   3. flip the flag after firing.
    expect(source).toMatch(/let introShown = false/);
    expect(source).toMatch(/if \(!introShown\)/);
    expect(source).toMatch(/IMAGE_OVERRIDE_BOOT_PROMPT_INTRO/);
    expect(source).toMatch(/introShown = true/);
  });

  it('Stage 3 invokes discoverDockerfiles + promptForOverridePath', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const ENGINE_SOURCE = path.join(here, '../../../src/local/image-override-engine.ts');
    const source = readFileSync(ENGINE_SOURCE, 'utf-8');
    // Stage 3 must call `discoverDockerfiles(cwd)` once per session
    // (outside the per-target loop) AND fire the per-target prompt via
    // the `promptForOverridePath` helper. That helper internally picks
    // between `select` (auto-detected) and `text` (fallback).
    expect(source).toMatch(/discoverDockerfiles\(cwd\)/);
    expect(source).toMatch(/promptForOverridePath\(/);
    // The select branch fires when discoveredDockerfiles.length > 0;
    // the text fallback fires when it's empty. Pin the select call's
    // sentinel pair so a refactor that drops the (Enter custom path)
    // or (Skip — use ECR pin) options is caught here.
    expect(source).toMatch(/Enter custom path/);
    expect(source).toMatch(/Skip — use ECR pin/);
  });
});
