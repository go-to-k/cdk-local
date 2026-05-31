import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

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
  ImageOverrideError,
  parseImageOverrideFlags,
  resolveImageOverrides,
  runImageOverrideBuilds,
} = await import('../../../src/local/image-override-engine.js');

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
    // And the prompt copy must contain the [path / N] hint.
    expect(source).toMatch(/\[path \/ N\]/);
  });
});
