import { describe, it, expect, beforeEach } from 'vite-plus/test';
import {
  buildFlagCatalog,
  tokenizeRawArgs,
  CATALOG_EXCLUDED_FLAGS,
  __resetFlagCatalogCacheForTest,
} from '../../../src/local/studio-option-catalog.js';
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
