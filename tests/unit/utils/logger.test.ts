import { describe, it, expect, afterEach, vi } from 'vite-plus/test';
import { resolveConfiguredLogLevel, ConsoleLogger } from '../../../src/utils/logger.js';

describe('resolveConfiguredLogLevel', () => {
  const prev = process.env['CDKL_LOG_LEVEL'];
  afterEach(() => {
    if (prev === undefined) delete process.env['CDKL_LOG_LEVEL'];
    else process.env['CDKL_LOG_LEVEL'] = prev;
  });

  it('defaults to info when CDKL_LOG_LEVEL is unset', () => {
    delete process.env['CDKL_LOG_LEVEL'];
    expect(resolveConfiguredLogLevel()).toBe('info');
  });

  it.each(['debug', 'info', 'warn', 'error'] as const)('honors a valid level %s', (level) => {
    process.env['CDKL_LOG_LEVEL'] = level;
    expect(resolveConfiguredLogLevel()).toBe(level);
  });

  it('ignores an invalid value and falls back to info', () => {
    process.env['CDKL_LOG_LEVEL'] = 'loud';
    expect(resolveConfiguredLogLevel()).toBe('info');
  });

  it('a warn-level ConsoleLogger suppresses info but keeps warn/error', () => {
    // The studio child runs at warn: cdk-local's info progress is silenced
    // while real warnings/errors still surface.
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const logger = new ConsoleLogger('warn', false);
      logger.info('synth progress noise');
      logger.warn('a real warning');
      expect(infoSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

describe('ConsoleLogger CDKL_LOG_STREAM=stdout unification (issue #403)', () => {
  const prev = process.env['CDKL_LOG_STREAM'];
  afterEach(() => {
    if (prev === undefined) delete process.env['CDKL_LOG_STREAM'];
    else process.env['CDKL_LOG_STREAM'] = prev;
  });

  it('routes warn AND error to stdout (console.log) instead of stderr when set', () => {
    process.env['CDKL_LOG_STREAM'] = 'stdout';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const logger = new ConsoleLogger('info', false);
      logger.info('an info line');
      logger.warn('a warning');
      logger.error('an error');
      // All three landed on stdout, in emission order, so a consumer that
      // reads only one stream sees them ordered.
      expect(logSpy.mock.calls.map((c) => c[0])).toEqual([
        'an info line',
        'a warning',
        'an error',
      ]);
      // None went to the stderr-backed channels.
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('keeps the default warn->stderr split when the env var is unset', () => {
    delete process.env['CDKL_LOG_STREAM'];
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const logger = new ConsoleLogger('info', false);
      logger.info('info to stdout');
      logger.warn('warn to stderr');
      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
