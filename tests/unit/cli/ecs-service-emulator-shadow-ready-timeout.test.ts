import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  parseShadowReadyTimeout,
  resolveShadowReadyTimeoutMs,
} from '../../../src/cli/commands/ecs-service-emulator.js';
import { resetEmbedConfig, setEmbedConfig } from '../../../src/local/embed-config.js';
import {
  DEFAULT_SHADOW_READY_TIMEOUT_MS,
  setShadowReadyTimeoutMs,
} from '../../../src/local/ecs-service-runner.js';

/**
 * Issue #265 — `--shadow-ready-timeout <ms>` flag + env-var precedence
 * for the `--watch` rolling primitive's shadow-replica TCP-ready
 * probe budget. The flag wires through `addCommonEcsServiceOptions`
 * onto both `start-service` and `start-alb`; this file pins the
 * resolution helper (default, env, flag-wins-over-env) and the
 * boot-path setter independently of the full emulator harness.
 */

describe('shadow-ready-timeout resolution (issue #265)', () => {
  beforeEach(() => {
    resetEmbedConfig();
  });
  afterEach(() => {
    resetEmbedConfig();
  });

  describe('parseShadowReadyTimeout (--shadow-ready-timeout argParser)', () => {
    it('accepts a positive integer milliseconds value', () => {
      expect(parseShadowReadyTimeout('45000')).toBe(45000);
      expect(parseShadowReadyTimeout('1')).toBe(1);
      expect(parseShadowReadyTimeout('120000')).toBe(120000);
      // Scientific notation expands to an integer — accepted (so a
      // user who genuinely types `1e6` gets 1,000,000ms, not a silent
      // truncation to 1 like `parseInt` would produce).
      expect(parseShadowReadyTimeout('1e6')).toBe(1_000_000);
    });

    it('rejects 0 / negative / non-numeric / trailing-garbage / decimal input', () => {
      expect(() => parseShadowReadyTimeout('0')).toThrow();
      expect(() => parseShadowReadyTimeout('-1')).toThrow();
      expect(() => parseShadowReadyTimeout('abc')).toThrow();
      expect(() => parseShadowReadyTimeout('')).toThrow();
      // Reviewer-flagged foot-guns previously silently accepted via
      // `parseInt`'s lenient parsing — now strict.
      expect(() => parseShadowReadyTimeout('1.5')).toThrow();
      expect(() => parseShadowReadyTimeout('45000abc')).toThrow();
    });
  });

  describe('resolveShadowReadyTimeoutMs precedence', () => {
    it('returns the 60s default when no flag and no env var are set', () => {
      const resolved = resolveShadowReadyTimeoutMs({}, 'CDKL', {});
      expect(resolved).toBe(60_000);
      expect(resolved).toBe(DEFAULT_SHADOW_READY_TIMEOUT_MS);
    });

    it('resolves the env-var value when no flag is supplied', () => {
      const resolved = resolveShadowReadyTimeoutMs(
        {},
        'CDKL',
        { CDKL_SHADOW_READY_TIMEOUT_MS: '45000' }
      );
      expect(resolved).toBe(45_000);
    });

    it('flag wins over env when both are set', () => {
      const resolved = resolveShadowReadyTimeoutMs(
        { shadowReadyTimeout: 30_000 },
        'CDKL',
        { CDKL_SHADOW_READY_TIMEOUT_MS: '90000' }
      );
      expect(resolved).toBe(30_000);
    });

    it('honors a host-supplied envPrefix (e.g. CDKD)', () => {
      const resolved = resolveShadowReadyTimeoutMs(
        {},
        'CDKD',
        { CDKD_SHADOW_READY_TIMEOUT_MS: '75000' }
      );
      expect(resolved).toBe(75_000);
    });

    it('falls back to the default + warns on an invalid env value', async () => {
      const { getLogger } = await import('../../../src/utils/logger.js');
      const warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
      try {
        const resolved = resolveShadowReadyTimeoutMs(
          {},
          'CDKL',
          { CDKL_SHADOW_READY_TIMEOUT_MS: 'banana' }
        );
        expect(resolved).toBe(DEFAULT_SHADOW_READY_TIMEOUT_MS);
        const matched = warnSpy.mock.calls.find((args) =>
          String(args[0]).includes("CDKL_SHADOW_READY_TIMEOUT_MS='banana'")
        );
        expect(matched).toBeDefined();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('falls back to the default on a zero / negative env value (silent + warn)', async () => {
      const { getLogger } = await import('../../../src/utils/logger.js');
      const warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
      try {
        const zero = resolveShadowReadyTimeoutMs(
          {},
          'CDKL',
          { CDKL_SHADOW_READY_TIMEOUT_MS: '0' }
        );
        const neg = resolveShadowReadyTimeoutMs(
          {},
          'CDKL',
          { CDKL_SHADOW_READY_TIMEOUT_MS: '-5' }
        );
        expect(zero).toBe(DEFAULT_SHADOW_READY_TIMEOUT_MS);
        expect(neg).toBe(DEFAULT_SHADOW_READY_TIMEOUT_MS);
        expect(warnSpy).toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('treats an empty-string env value the same as unset', () => {
      const resolved = resolveShadowReadyTimeoutMs(
        {},
        'CDKL',
        { CDKL_SHADOW_READY_TIMEOUT_MS: '' }
      );
      expect(resolved).toBe(DEFAULT_SHADOW_READY_TIMEOUT_MS);
    });
  });

  describe('addCommonEcsServiceOptions wiring', () => {
    it('registers --shadow-ready-timeout on both start-service and start-alb command surfaces', async () => {
      const { Command } = await import('commander');
      const { addCommonEcsServiceOptions } = await import(
        '../../../src/cli/commands/ecs-service-emulator.js'
      );
      const svc = addCommonEcsServiceOptions(new Command('start-service'));
      const alb = addCommonEcsServiceOptions(new Command('start-alb'));
      const svcOpt = svc.options.find((o) => o.long === '--shadow-ready-timeout');
      const albOpt = alb.options.find((o) => o.long === '--shadow-ready-timeout');
      expect(svcOpt).toBeDefined();
      expect(albOpt).toBeDefined();
      // The help text MUST cite the canonical warning so users grep
      // their reload log -> find the flag.
      expect(svcOpt!.description).toMatch(/TCP probe/);
      expect(svcOpt!.description).toMatch(/did not accept within/);
      // Env-var hint must surface in --help so the env-var precedence
      // is discoverable.
      expect(svcOpt!.description).toMatch(/CDKL_SHADOW_READY_TIMEOUT_MS/);
    });

    it('parses --shadow-ready-timeout 45000 into options.shadowReadyTimeout = 45000', async () => {
      const { Command } = await import('commander');
      const { addCommonEcsServiceOptions } = await import(
        '../../../src/cli/commands/ecs-service-emulator.js'
      );
      const cmd = addCommonEcsServiceOptions(new Command('start-service')).action(() => {});
      cmd.exitOverride();
      cmd.parse(['node', 'cdkl', '--shadow-ready-timeout', '45000'], { from: 'user' });
      expect(cmd.opts().shadowReadyTimeout).toBe(45000);
    });

    it('uses the configured envPrefix in the --help text when embed-config is overridden', async () => {
      setEmbedConfig({ envPrefix: 'CDKD' });
      const { Command } = await import('commander');
      const { addCommonEcsServiceOptions } = await import(
        '../../../src/cli/commands/ecs-service-emulator.js'
      );
      const cmd = addCommonEcsServiceOptions(new Command('start-service'));
      const opt = cmd.options.find((o) => o.long === '--shadow-ready-timeout');
      expect(opt!.description).toMatch(/CDKD_SHADOW_READY_TIMEOUT_MS/);
    });
  });

  describe('setShadowReadyTimeoutMs guard', () => {
    afterEach(() => {
      // Restore the production default so sibling tests in this file
      // don't leak the override.
      setShadowReadyTimeoutMs(DEFAULT_SHADOW_READY_TIMEOUT_MS);
    });

    it('accepts a positive finite value', () => {
      expect(() => setShadowReadyTimeoutMs(1)).not.toThrow();
      expect(() => setShadowReadyTimeoutMs(60_000)).not.toThrow();
    });

    it('rejects 0 / negative / non-finite values (defense-in-depth)', () => {
      expect(() => setShadowReadyTimeoutMs(0)).toThrow();
      expect(() => setShadowReadyTimeoutMs(-1)).toThrow();
      expect(() => setShadowReadyTimeoutMs(Number.NaN)).toThrow();
      expect(() => setShadowReadyTimeoutMs(Number.POSITIVE_INFINITY)).toThrow();
    });
  });
});
