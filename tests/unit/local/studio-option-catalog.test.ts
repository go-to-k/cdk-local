import { describe, it, expect, beforeEach } from 'vite-plus/test';
import {
  buildFlagCatalog,
  buildCatalogArgs,
  parseFlagPlaceholder,
  tokenizeRawArgs,
  CATALOG_EXCLUDED_FLAGS,
  CATALOG_MANAGED_FLAGS,
  __resetFlagCatalogCacheForTest,
} from '../../../src/local/studio-option-catalog.js';
import { OPTION_SPECS } from '../../../src/local/studio-option-specs.js';
import { getEmbedConfig, setEmbedConfig, resetEmbedConfig } from '../../../src/local/embed-config.js';

describe('buildFlagCatalog', () => {
  // Clear the memo before each test so a build actually instantiates the
  // factories — otherwise the embed-config snapshot/restore path (and the
  // branding-reflecting descriptions) would never run after the first call.
  beforeEach(() => __resetFlagCatalogCacheForTest());

  it('emits a catalog for every runnable kind, mapped to its headless command', () => {
    const cat = buildFlagCatalog();
    expect(cat.lambda?.command).toBe('invoke');
    expect(cat.agentcore?.command).toBe('invoke-agentcore');
    expect(cat.api?.command).toBe('start-api');
    expect(cat.alb?.command).toBe('start-alb');
    expect(cat.ecs?.command).toBe('start-service');
  });

  it('derives real flags from each command (name + description)', () => {
    const cat = buildFlagCatalog();
    const lambdaFlags = (cat.lambda?.flags ?? []).map((f) => f.flags);
    // `--event` is a real `cdkl invoke` flag with a description.
    expect(lambdaFlags.some((f) => f.includes('--event'))).toBe(true);
    const event = (cat.lambda?.flags ?? []).find((f) => f.flags.includes('--event <file>'));
    expect(event?.description).toBeTruthy();
    // start-alb exposes --tls.
    expect((cat.alb?.flags ?? []).some((f) => f.flags.includes('--tls'))).toBe(true);
  });

  it('excludes session-global flags and help/version from every kind (exact, not substring)', () => {
    const cat = buildFlagCatalog();
    for (const kind of Object.keys(cat) as (keyof typeof cat)[]) {
      // Tokenize each flags string ("-e, --event <file>") into discrete flag
      // tokens so the exclusion is matched EXACTLY — `--assume-role-auto` is a
      // distinct flag that must NOT be dropped by the `--assume-role` exclusion.
      const tokens = (cat[kind]?.flags ?? []).flatMap((f) => f.flags.split(/[\s,]+/));
      for (const excluded of CATALOG_EXCLUDED_FLAGS) {
        expect(tokens).not.toContain(excluded);
      }
    }
  });

  it('keeps a near-name flag that only shares a prefix with an excluded one', () => {
    // `--assume-role` is session-global (excluded), but `--assume-role-auto` is
    // a per-run start-api flag that must survive.
    const cat = buildFlagCatalog();
    const apiTokens = (cat.api?.flags ?? []).flatMap((f) => f.flags.split(/[\s,]+/));
    expect(apiTokens).toContain('--assume-role-auto');
  });

  it('is memoized — repeated calls return the same object', () => {
    expect(buildFlagCatalog()).toBe(buildFlagCatalog());
  });

  it('classifies each flag value type (boolean vs value, negate, variadic, placeholder)', () => {
    const cat = buildFlagCatalog();
    // --no-pull is a bare boolean (negate form): takes no value.
    const noPull = (cat.lambda?.flags ?? []).find((f) => f.long === '--no-pull');
    expect(noPull).toBeDefined();
    expect(noPull?.takesValue).toBe(false);
    expect(noPull?.negate).toBe(true);
    // --event <file> takes a value; its placeholder is parsed from <file>.
    const event = (cat.lambda?.flags ?? []).find((f) => f.long === '--event');
    expect(event?.takesValue).toBe(true);
    expect(event?.placeholder).toBe('file');
  });

  it('marks renderable=false for curated and studio-managed flags', () => {
    const cat = buildFlagCatalog();
    // --event is studio-managed (injected per run) — not auto-rendered.
    const event = (cat.lambda?.flags ?? []).find((f) => f.long === '--event');
    expect(event?.renderable).toBe(false);
    // A curated flag (in OPTION_SPECS) is not auto-rendered either: --tls is a
    // curated alb control.
    const albCurated = new Set((OPTION_SPECS.alb ?? []).map((s) => s.flag));
    expect(albCurated.has('--tls')).toBe(true);
    const tls = (cat.alb?.flags ?? []).find((f) => f.long === '--tls');
    expect(tls?.renderable).toBe(false);
    // No renderable flag is ever a managed flag.
    for (const kind of Object.keys(cat) as (keyof typeof cat)[]) {
      for (const f of cat[kind]?.flags ?? []) {
        if (f.renderable) expect(CATALOG_MANAGED_FLAGS.has(f.long)).toBe(false);
      }
    }
  });

  it('exposes at least one renderable residual flag (e.g. cloudfront --no-pull)', () => {
    const cat = buildFlagCatalog();
    const renderable = (cat.cloudfront?.flags ?? []).filter((f) => f.renderable).map((f) => f.long);
    expect(renderable).toContain('--no-pull');
  });

  it('does not wipe the active embed config and reflects host branding in descriptions', () => {
    // A host CLI installs custom branding; building the catalog instantiates
    // the command factories (each calls setEmbedConfig at construction, which
    // with no opts would reset to cdk-local defaults). The cache is cleared by
    // beforeEach, so this build genuinely runs the factories under the custom
    // config — exercising the snapshot/restore path, not a memoized result.
    try {
      setEmbedConfig({ cliName: 'cdkd local', binaryName: 'cdkd', envPrefix: 'CDKD' });
      const before = getEmbedConfig();
      const cat = buildFlagCatalog();
      const after = getEmbedConfig();
      // (a) The active branding survived the introspection.
      expect(after.cliName).toBe(before.cliName);
      expect(after.binaryName).toBe(before.binaryName);
      expect(after.envPrefix).toBe('CDKD');
      // (b) The derived descriptions reflect the host branding — `--role-arn`'s
      // help interpolates `${envPrefix}_ROLE_ARN`, so under CDKD it must read
      // CDKD_ROLE_ARN (not the cdk-local default CDKL_ROLE_ARN).
      const roleArn = (cat.lambda?.flags ?? []).find((f) => f.flags.includes('--role-arn'));
      expect(roleArn?.description).toContain('CDKD_ROLE_ARN');
      expect(roleArn?.description).not.toContain('CDKL_ROLE_ARN');
    } finally {
      resetEmbedConfig();
      __resetFlagCatalogCacheForTest();
    }
  });
});

describe('tokenizeRawArgs', () => {
  it('returns [] for undefined / empty / whitespace', () => {
    expect(tokenizeRawArgs(undefined)).toEqual([]);
    expect(tokenizeRawArgs('')).toEqual([]);
    expect(tokenizeRawArgs('   \t\n ')).toEqual([]);
  });

  it('splits on whitespace into discrete argv elements', () => {
    expect(tokenizeRawArgs('--port 8080 --host 127.0.0.1')).toEqual([
      '--port',
      '8080',
      '--host',
      '127.0.0.1',
    ]);
  });

  it('keeps double-quoted values with spaces as one token', () => {
    expect(tokenizeRawArgs('--name "two words" --x 1')).toEqual([
      '--name',
      'two words',
      '--x',
      '1',
    ]);
  });

  it('keeps single-quoted values as one token (no escaping inside)', () => {
    expect(tokenizeRawArgs("--json '{\"a\": 1}'")).toEqual(['--json', '{"a": 1}']);
  });

  it('honors a backslash escape inside double quotes', () => {
    expect(tokenizeRawArgs('--q "a\\"b"')).toEqual(['--q', 'a"b']);
  });

  it('honors a bare backslash escape outside quotes', () => {
    expect(tokenizeRawArgs('a\\ b')).toEqual(['a b']);
  });

  it('preserves an explicit empty-string quoted arg', () => {
    expect(tokenizeRawArgs('--x ""')).toEqual(['--x', '']);
    expect(tokenizeRawArgs("--x ''")).toEqual(['--x', '']);
  });

  it('swallows a backslash escaping an ordinary char inside double quotes', () => {
    // Inside double quotes a backslash escapes the next char (shell-like), so
    // the backslash is dropped and the char kept literally.
    expect(tokenizeRawArgs('"a\\nb"')).toEqual(['anb']);
  });

  it('keeps a trailing backslash with nothing to escape as a literal', () => {
    expect(tokenizeRawArgs('a\\')).toEqual(['a\\']);
  });

  it('throws on an unterminated quote', () => {
    expect(() => tokenizeRawArgs('--name "unterminated')).toThrow(/unterminated/i);
    expect(() => tokenizeRawArgs("--x 'oops")).toThrow(/unterminated/i);
  });
});

describe('parseFlagPlaceholder', () => {
  it('extracts the value token from a flags string', () => {
    expect(parseFlagPlaceholder('-e, --event <file>')).toBe('file');
    expect(parseFlagPlaceholder('--platform <platform>')).toBe('platform');
    expect(parseFlagPlaceholder('--max-tasks [count]')).toBe('count');
  });

  it('drops a trailing variadic ellipsis', () => {
    expect(parseFlagPlaceholder('--stack <glob...>')).toBe('glob');
  });

  it('returns undefined for a boolean flag with no value token', () => {
    expect(parseFlagPlaceholder('--tls')).toBeUndefined();
    expect(parseFlagPlaceholder('--no-pull')).toBeUndefined();
  });
});

describe('buildCatalogArgs', () => {
  beforeEach(() => __resetFlagCatalogCacheForTest());

  it('returns [] for undefined values', () => {
    expect(buildCatalogArgs('lambda', undefined)).toEqual([]);
  });

  it('emits a bare flag for a checked boolean and flag+value for a string', () => {
    // cloudfront has renderable --no-pull (boolean) and --stack-region (value).
    const args = buildCatalogArgs('cloudfront', {
      '--no-pull': true,
      '--stack-region': 'us-west-2',
    });
    expect(args).toContain('--no-pull');
    expect(args.join(' ')).toContain('--stack-region us-west-2');
  });

  it('omits a false boolean and a blank value', () => {
    expect(buildCatalogArgs('cloudfront', { '--no-pull': false })).toEqual([]);
    expect(buildCatalogArgs('cloudfront', { '--stack-region': '   ' })).toEqual([]);
  });

  it('throws on an unknown / non-renderable flag (curated or managed)', () => {
    // --event is studio-managed; passing it through the catalog path is rejected.
    expect(() => buildCatalogArgs('lambda', { '--event': 'x' })).toThrow(/non-overridable|Unknown/i);
    // A made-up flag is rejected too.
    expect(() => buildCatalogArgs('lambda', { '--nope': 'x' })).toThrow(/Unknown/i);
  });

  it('throws on a type mismatch', () => {
    expect(() => buildCatalogArgs('cloudfront', { '--no-pull': 'yes' as never })).toThrow(
      /must be a boolean/i
    );
    expect(() => buildCatalogArgs('cloudfront', { '--stack-region': true as never })).toThrow(
      /must be a string/i
    );
  });
});
