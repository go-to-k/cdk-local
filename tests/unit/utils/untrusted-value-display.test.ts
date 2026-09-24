/**
 * go-to-k/cdk-local#758 — a value an assembly chose must not be able to close
 * a boundary cdk-local drew around it.
 *
 * `sanitizeServiceExceptionMessage` flattens control characters but passes
 * `'`, so every refusal and warning that printed such a value between
 * cdk-local's own single quotes let `../x'. Contained and healthy. ...` write
 * a sentence of its own into the explanation. Each site now renders the value
 * through `displayUntrustedValue`: a plain value bare, anything else as ONE
 * JSON string literal.
 *
 * Two assertions per site, and the second is the one a re-pinned wording test
 * cannot make: a site that dropped the boundary altogether (`${sanitize(v)}`
 * with no quotes) prints a PLAIN value byte-identically to the fix, so only a
 * FORGING value tells the two apart. Every path these cases render sits under
 * a temp root whose own NAME carries the forge, so the resolved path, the
 * outdir and the project root all carry it too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { mockSpawnStreaming, mockRunDockerStreaming } = vi.hoisted(() => ({
  mockSpawnStreaming: vi.fn(),
  mockRunDockerStreaming: vi.fn(),
}));

// No case may spawn a real `docker build`.
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

const { warnLines } = vi.hoisted(() => ({ warnLines: [] as string[] }));

vi.mock('../../../src/utils/logger.js', () => {
  const sink = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (m: string) => warnLines.push(m),
    error: vi.fn(),
    getLevel: () => 'info',
    child: () => sink,
  };
  return { getLogger: () => sink };
});

const { displayUntrustedValue } = await import('../../../src/utils/assembly-path.js');
const { resolveAssetSourcePath, resetWholeAssemblyWarnings } = await import(
  '../../../src/assets/asset-source-path.js'
);
const { AssetManifestLoader } = await import('../../../src/assets/asset-manifest-loader.js');
const { buildDockerImage, resetManifestExecutableWarnings } = await import(
  '../../../src/assets/docker-build.js'
);
const { resetBuildKitPassthroughWarnings } = await import(
  '../../../src/assets/buildkit-passthrough-warnings.js'
);
const { assetPathDirs, materializeAssetCodeDir, resetDerivedRootWarnings, resolveAssetCodeDirectory, resolveLambdaTarget } =
  await import('../../../src/local/lambda-resolver.js');
const { resolveLambdaByLogicalId } = await import('../../../src/cli/commands/local-start-api.js');
const { serveFromStaticOrigin } = await import('../../../src/local/cloudfront-static-origin.js');
type StackInfo = import('../../../src/synthesis/assembly-reader.js').StackInfo;

/** The clause a forging value tries to add to cdk-local's own sentence. */
const CLAUSE = 'Contained and healthy';
const FORGE = `x'". ${CLAUSE}. Nothing "'y`;

/** Every JSON string literal in `text`, as `displayUntrustedValue` writes one. */
const LITERAL = /"(?:[^"\\]|\\.)*"/g;

/**
 * The value is shown (so the case is not vacuous) and only ever inside a
 * literal: with every literal cut out, nothing of the clause is left.
 */
function expectContained(message: string): void {
  expect(message).toContain(CLAUSE);
  const outside = message.replace(LITERAL, '<v>');
  expect(outside).not.toContain(CLAUSE);
  for (const lit of message.match(LITERAL) ?? []) {
    expect(typeof JSON.parse(lit)).toBe('string');
  }
}

function thrown(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected a throw');
}

const roots: string[] = [];

/** A fresh directory whose own name carries the forge. */
function forgingRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `cdkl-758-${FORGE}-`)));
  roots.push(dir);
  return dir;
}

beforeEach(() => {
  warnLines.length = 0;
  mockRunDockerStreaming.mockReset();
  mockRunDockerStreaming.mockResolvedValue({ stdout: '', stderr: '' });
  resetWholeAssemblyWarnings();
  resetManifestExecutableWarnings();
  resetBuildKitPassthroughWarnings();
  resetDerivedRootWarnings();
});

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('displayUntrustedValue', () => {
  it('renders a plain path or identifier bare', () => {
    for (const v of ['/tmp/cdk.out/asset.abc', 'MyFunction', 'C:\\app\\cdk.out', 'a-b_c.d~e+f@g:h=i']) {
      expect(displayUntrustedValue(v)).toBe(v);
    }
  });

  it('shows a non-ASCII letter as itself, bare (a Japanese directory name)', () => {
    const v = '/tmp/\u30d7\u30ed\u30b8\u30a7\u30af\u30c8/cdk.out';
    expect(displayUntrustedValue(v)).toBe(v);
  });

  it('puts a value carrying a quote inside ONE JSON literal that round-trips', () => {
    const shown = displayUntrustedValue(FORGE);
    expect(shown).toBe(JSON.stringify(FORGE));
    expect(JSON.parse(shown)).toBe(FORGE);
  });

  it('escapes a double quote and a backslash as JSON does', () => {
    expect(displayUntrustedValue('a"b\\c d')).toBe('"a\\"b\\\\c d"');
  });

  it('quotes a legitimate path with a space', () => {
    expect(displayUntrustedValue('/Users/me/My Project/cdk.out')).toBe(
      '"/Users/me/My Project/cdk.out"'
    );
  });

  it('escapes look-alike quotes and blanks that could pass for the boundary', () => {
    // U+201D right double quote, U+FF02 fullwidth quote, U+02BC modifier
    // apostrophe (a LETTER), U+3164 Hangul filler (a letter that draws blank).
    for (const [ch, esc] of [
      ['\u201d', '\\u201d'],
      ['\uff02', '\\uff02'],
      ['\u02bc', '\\u02bc'],
      ['\u3164', '\\u3164'],
    ] as const) {
      const shown = displayUntrustedValue(`a${ch}b`);
      expect(shown).toBe(`"a${esc}b"`);
      expect(shown).not.toContain(ch);
    }
  });

  it('escapes a default-ignorable combining mark even directly after a letter', () => {
    // Each draws as nothing, so bare it would make `.ss\u034fh` read as `.ssh`.
    for (const [ch, esc] of [
      ['\u034f', '\\u034f'],
      ['\u17b4', '\\u17b4'],
      ['\u180b', '\\u180b'],
      ['\ufe0f', '\\ufe0f'],
      ['\u{e0100}', '\\udb40\\udd00'],
    ] as const) {
      expect(displayUntrustedValue(`/home/me/.ss${ch}h`)).toBe(`"/home/me/.ss${esc}h"`);
    }
    // An ordinary combining mark after a letter stays bare (a decomposed e-acute).
    expect(displayUntrustedValue('/tmp/cafe\u0301')).toBe('/tmp/cafe\u0301');
  });

  it('escapes an emoji and a lone surrogate rather than showing them', () => {
    expect(displayUntrustedValue('a\u{1F600}')).toBe('"a\\ud83d\\ude00"');
    expect(displayUntrustedValue('a\ud800')).toMatch(/^"a(\\ud800| )"$/);
  });

  it('gives a value the sanitizer ALTERED the boundary, even when the rest is plain', () => {
    const shown = displayUntrustedValue('/tmp/x\n[INFO] ok');
    expect(shown).not.toMatch(/[\n\r]/);
    expect(shown).toBe('"/tmp/x [INFO] ok"');
  });

  it('renders the empty string as an empty literal, never as nothing', () => {
    expect(displayUntrustedValue('')).toBe('""');
  });
});

describe('asset-source-path.ts sites', () => {
  const base = {
    field: 'source.directory' as const,
    subject: 'Docker image asset',
    action: 'build it',
    sink: 'build it',
    wrapError: (m: string) => new Error(m),
  };

  it('relative refusal: the field value and the containment tail', () => {
    const root = forgingRoot();
    const outdir = join(root, 'cdk.out');
    mkdirSync(outdir);
    const message = thrown(() =>
      resolveAssetSourcePath({
        ...base,
        manifestDir: outdir,
        value: `../${FORGE}`,
        assetOutdir: outdir,
        absolute: 'fold',
      })
    );
    expect(message).toContain(`source.directory=${JSON.stringify(`../${FORGE}`)} which resolves to "`);
    expectContained(message);
  });

  it('relative refusal through a symlink: the link target in the tail', () => {
    const root = forgingRoot();
    const outdir = join(root, 'cdk.out');
    mkdirSync(outdir);
    mkdirSync(join(root, 'victim'));
    symlinkSync(join(root, 'victim'), join(outdir, 'link'));
    const message = thrown(() =>
      resolveAssetSourcePath({
        ...base,
        manifestDir: outdir,
        value: 'link',
        assetOutdir: outdir,
        absolute: 'fold',
      })
    );
    expect(message).toContain('which leads through a symbolic link to "');
    expectContained(message);
  });

  it("'honour' absolute refusal", () => {
    const root = forgingRoot();
    const outdir = join(root, 'cdk.out');
    mkdirSync(outdir);
    const message = thrown(() =>
      resolveAssetSourcePath({
        ...base,
        manifestDir: outdir,
        value: join(root, 'victim'),
        assetOutdir: outdir,
        absolute: 'honour',
      })
    );
    expect(message).toMatch(/has an absolute source\.directory="/);
    expectContained(message);
  });

  it("'honour-warn' refusal outside the project names every root display-safe", () => {
    const root = forgingRoot();
    const repo = join(root, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'cdk.out'));
    mkdirSync(join(root, 'elsewhere'));
    const message = thrown(() =>
      resolveAssetSourcePath({
        ...base,
        manifestDir: join(repo, 'cdk.out'),
        value: join(root, 'elsewhere'),
        assetOutdir: join(repo, 'cdk.out'),
        absolute: 'honour-warn',
      })
    );
    expect(message).toMatch(/, outside your project \(/);
    expectContained(message);
  });

  it("'honour-warn' accepted: the --no-staging warning", () => {
    const root = forgingRoot();
    const repo = join(root, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'cdk.out'));
    mkdirSync(join(repo, 'site'));
    resolveAssetSourcePath({
      ...base,
      manifestDir: join(repo, 'cdk.out'),
      value: join(repo, 'site'),
      assetOutdir: join(repo, 'cdk.out'),
      absolute: 'honour-warn',
    });
    const line = warnLines.find((l) => l.includes('pointing outside the assembly'));
    expect(line).toBeDefined();
    expectContained(line!);
  });

  it("'honour-warn' accepted through a symlink: the link target too", () => {
    const root = forgingRoot();
    const repo = join(root, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'cdk.out'));
    mkdirSync(join(repo, 'site'));
    symlinkSync(join(repo, 'site'), join(repo, 'cdk.out', 'link'));
    resolveAssetSourcePath({
      ...base,
      manifestDir: join(repo, 'cdk.out'),
      value: join(repo, 'cdk.out', 'link'),
      assetOutdir: join(repo, 'cdk.out'),
      absolute: 'honour-warn',
    });
    const line = warnLines.find((l) => l.includes('through a symbolic link to "'));
    expect(line).toBeDefined();
    expectContained(line!);
  });

  it('the whole-assembly warning', () => {
    const root = forgingRoot();
    const outdir = join(root, 'cdk.out');
    mkdirSync(outdir);
    resolveAssetSourcePath({
      ...base,
      manifestDir: outdir,
      value: '.',
      assetOutdir: outdir,
      absolute: 'fold',
    });
    const line = warnLines.find((l) => l.includes("output directory ITSELF"));
    expect(line).toBeDefined();
    expectContained(line!);
  });
});

describe('asset-manifest-loader.ts', () => {
  it('the stack name in the manifest refusal', async () => {
    const root = forgingRoot();
    const outdir = join(root, 'cdk.out');
    mkdirSync(outdir);
    const message = await new AssetManifestLoader()
      .loadManifest(outdir, `../${FORGE}`)
      .then(
        () => 'resolved',
        (err: unknown) => (err instanceof Error ? err.message : String(err))
      );
    expect(message).toContain(`for stack ${JSON.stringify(`../${FORGE}`)}: it resolves to "`);
    expectContained(message);
  });
});

describe('assembly-path.ts renderAssemblyPathEscape', () => {
  it('the symlink-to-the-directory-itself arm names the base display-safe', async () => {
    const root = forgingRoot();
    const outdir = join(root, 'cdk.out');
    mkdirSync(outdir);
    symlinkSync(outdir, join(outdir, 'Stk.assets.json'));
    const message = await new AssetManifestLoader().loadManifest(outdir, 'Stk').then(
      () => 'resolved',
      (err: unknown) => (err instanceof Error ? err.message : String(err))
    );
    expect(message).toContain(', a symbolic link to the directory "');
    expectContained(message);
  });
});

describe('buildkit-passthrough-warnings.ts', () => {
  it('the passthrough key and the escaping host path', async () => {
    const root = forgingRoot();
    const outdir = join(root, 'cdk.out');
    mkdirSync(join(outdir, 'asset.abc'), { recursive: true });
    await buildDockerImage(
      {
        source: {
          directory: 'asset.abc',
          dockerBuildSecrets: { [FORGE]: `src=${join(root, 'victim')}` },
        },
      },
      outdir,
      { tag: 't', wrapError: (m: string) => new Error(m) }
    );
    const line = warnLines.find((l) => l.startsWith('Docker asset dockerBuildSecrets['));
    expect(line).toBeDefined();
    expect(line).toContain(`dockerBuildSecrets[${JSON.stringify(FORGE)}] names a host path`);
    expectContained(line!);
  });
});

describe('lambda-resolver.ts / local-start-api.ts sites', () => {
  function stackFor(outdir: string, logicalId: string, metadata: Record<string, string>): StackInfo {
    return {
      stackName: 'Stk',
      displayName: 'Stk',
      artifactId: 'Stk',
      assetManifestPath: join(outdir, 'Stk.assets.json'),
      assetOutdir: outdir,
      dependencyNames: [],
      template: {
        Resources: {
          [logicalId]: {
            Type: 'AWS::Lambda::Function',
            Properties: { Runtime: 'nodejs20.x', Handler: 'index.handler' },
            Metadata: metadata,
          },
        },
      },
    } as unknown as StackInfo;
  }

  it('relative refusal: the logical id, the aws:asset:path and the tail', () => {
    const root = forgingRoot();
    const outdir = join(root, 'cdk.out');
    mkdirSync(outdir);
    const message = thrown(() =>
      resolveAssetCodeDirectory(outdir, `../${FORGE}`, (m) => new Error(m), outdir, FORGE)
    );
    expect(message).toMatch(/^Lambda "x'/);
    expect(message).toContain(`Metadata['aws:asset:path']=${JSON.stringify(`../${FORGE}`)} which`);
    expectContained(message);
  });

  it('absolute warning: the path outside the assembly', () => {
    const root = forgingRoot();
    const outdir = join(root, 'cdk.out');
    mkdirSync(outdir);
    mkdirSync(join(root, 'src'));
    resolveAssetCodeDirectory(outdir, join(root, 'src'), (m) => new Error(m), outdir, FORGE);
    const line = warnLines.find((l) => l.includes('pointing outside the assembly'));
    expect(line).toBeDefined();
    expectContained(line!);
  });

  it('absolute warning through a symlink: the link target too', () => {
    const root = forgingRoot();
    const outdir = join(root, 'cdk.out');
    mkdirSync(outdir);
    mkdirSync(join(root, 'src'));
    symlinkSync(join(root, 'src'), join(outdir, 'link'));
    resolveAssetCodeDirectory(outdir, join(outdir, 'link'), (m) => new Error(m), outdir, 'Fn');
    const line = warnLines.find((l) => l.includes('through a symbolic link to "'));
    expect(line).toBeDefined();
    expectContained(line!);
  });

  it('the missing-asset-path refusal (invoke and start-api)', () => {
    const root = forgingRoot();
    const outdir = join(root, 'cdk.out');
    mkdirSync(outdir);
    const forged = stackFor(outdir, FORGE, {});
    expectContained(thrown(() => resolveLambdaTarget(`Stk:${FORGE}`, [forged])));
    expectContained(thrown(() => resolveLambdaByLogicalId(FORGE, [forged])));
  });

  it('the does-not-exist and not-a-directory refusals', () => {
    const root = forgingRoot();
    const outdir = join(root, 'cdk.out');
    mkdirSync(outdir);
    writeFileSync(join(outdir, 'asset.file'), 'x');
    const missing = stackFor(outdir, FORGE, { 'aws:asset:path': 'asset.missing' });
    const missingMsg = thrown(() => resolveLambdaTarget(`Stk:${FORGE}`, [missing]));
    expect(missingMsg).toMatch(/asset path ".*" does not exist\./);
    expectContained(missingMsg);
    // `resolveLambdaTarget` resolves layers with `allowZip` off, so a plain
    // FILE is the not-a-directory arm.
    const file = stackFor(outdir, FORGE, { 'aws:asset:path': 'asset.file' });
    const fileMsg = thrown(() => resolveLambdaTarget(`Stk:${FORGE}`, [file]));
    expect(fileMsg).toMatch(/asset path ".*" is not a directory/);
    expectContained(fileMsg);
  });

  it('materializeAssetCodeDir: missing, and not a ZIP', () => {
    const root = forgingRoot();
    expectContained(thrown(() => materializeAssetCodeDir(join(root, 'missing'))));
    writeFileSync(join(root, 'bundle.zip'), 'not a zip');
    expectContained(thrown(() => materializeAssetCodeDir(join(root, 'bundle.zip'))));
  });

  it('the derived-root and outside-the-named-directory warnings', () => {
    const root = forgingRoot();
    const outdir = join(root, 'cdk.out');
    const stage = join(outdir, 'assembly-MyStage');
    mkdirSync(stage, { recursive: true });
    mkdirSync(join(outdir, 'asset.abc123'));
    writeFileSync(
      join(outdir, 'manifest.json'),
      JSON.stringify({
        version: '54.0.0',
        artifacts: {
          'assembly-MyStage': {
            type: 'cdk:cloud-assembly',
            properties: { directoryName: 'assembly-MyStage' },
          },
        },
      })
    );
    const dirs = assetPathDirs({
      assetManifestPath: join(stage, 'Stk.assets.json'),
      assetOutdir: stage,
    } as unknown as StackInfo);
    resolveAssetCodeDirectory(dirs.manifestDir, '../asset.abc123', (m) => new Error(m), dirs.assetOutdir, 'Fn');
    expect(warnLines).toHaveLength(2);
    for (const line of warnLines) expectContained(line);
  });
});

describe('cloudfront-static-origin.ts', () => {
  it('the symlink-escape and hidden-entry warnings', () => {
    const root = forgingRoot();
    const site = join(root, 'site');
    mkdirSync(site);
    writeFileSync(join(root, 'outside.txt'), 'x');
    symlinkSync(join(root, 'outside.txt'), join(site, 'link.txt'));
    writeFileSync(join(site, '.env'), 'SECRET=1');
    serveFromStaticOrigin({ localDirs: [site], uri: '/link.txt', containLinks: true });
    serveFromStaticOrigin({
      localDirs: [site],
      uri: '/.env',
      containLinks: true,
      hideDotfilesIn: [site],
    });
    // A hidden entry whose own NAME carries the forge: the request key.
    const hiddenName = `.h'". ${CLAUSE}. "'k`;
    writeFileSync(join(site, hiddenName), 'x');
    serveFromStaticOrigin({
      localDirs: [site],
      uri: `/${encodeURIComponent(hiddenName)}`,
      containLinks: true,
      hideDotfilesIn: [site],
    });
    const hiddenKey = warnLines.find((l) => l.startsWith(`Not serving ${JSON.stringify(hiddenName)} from "`));
    expect(hiddenKey).toBeDefined();
    expectContained(hiddenKey!);
    const escape = warnLines.find((l) => l.includes('symbolic link to'));
    const hidden = warnLines.find((l) => l.includes('hidden entry'));
    expect(escape).toBeDefined();
    expect(hidden).toBeDefined();
    expectContained(escape!);
    expectContained(hidden!);
  });
});
