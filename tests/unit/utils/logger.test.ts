import { describe, it, expect, afterEach, vi } from 'vite-plus/test';
import {
  resolveConfiguredLogLevel,
  resolveDefaultUseColors,
  ConsoleLogger,
} from '../../../src/utils/logger.js';

/**
 * Set `process.stdout.isTTY` for the duration of a test, returning a restore fn.
 * `isTTY` is a plain own property on the stream, so redefining it is enough.
 */
function withStdoutTTY(value: boolean | undefined): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    value,
  });
  return () => {
    if (descriptor) {
      Object.defineProperty(process.stdout, 'isTTY', descriptor);
    } else {
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  };
}

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

const ANSI_RED = '\x1b[31m';

describe('resolveDefaultUseColors (TTY-aware default, issue #2)', () => {
  const prevNoColor = process.env['NO_COLOR'];
  const prevForceColor = process.env['FORCE_COLOR'];
  let restoreTTY: (() => void) | undefined;

  afterEach(() => {
    if (prevNoColor === undefined) delete process.env['NO_COLOR'];
    else process.env['NO_COLOR'] = prevNoColor;
    if (prevForceColor === undefined) delete process.env['FORCE_COLOR'];
    else process.env['FORCE_COLOR'] = prevForceColor;
    restoreTTY?.();
    restoreTTY = undefined;
  });

  it('NO_COLOR disables colors even on a TTY', () => {
    delete process.env['FORCE_COLOR'];
    process.env['NO_COLOR'] = '1';
    restoreTTY = withStdoutTTY(true);
    expect(resolveDefaultUseColors()).toBe(false);
  });

  it('an empty NO_COLOR does NOT disable colors (must be non-empty)', () => {
    delete process.env['FORCE_COLOR'];
    process.env['NO_COLOR'] = '';
    restoreTTY = withStdoutTTY(true);
    expect(resolveDefaultUseColors()).toBe(true);
  });

  it('FORCE_COLOR enables colors even when stdout is not a TTY', () => {
    delete process.env['NO_COLOR'];
    process.env['FORCE_COLOR'] = '1';
    restoreTTY = withStdoutTTY(false);
    expect(resolveDefaultUseColors()).toBe(true);
  });

  it.each(['0', 'false'])('FORCE_COLOR=%s is treated as off', (val) => {
    delete process.env['NO_COLOR'];
    process.env['FORCE_COLOR'] = val;
    restoreTTY = withStdoutTTY(false);
    expect(resolveDefaultUseColors()).toBe(false);
  });

  it('NO_COLOR wins over FORCE_COLOR', () => {
    process.env['NO_COLOR'] = '1';
    process.env['FORCE_COLOR'] = '1';
    restoreTTY = withStdoutTTY(true);
    expect(resolveDefaultUseColors()).toBe(false);
  });

  it('no env: follows stdout.isTTY (true)', () => {
    delete process.env['NO_COLOR'];
    delete process.env['FORCE_COLOR'];
    restoreTTY = withStdoutTTY(true);
    expect(resolveDefaultUseColors()).toBe(true);
  });

  it('no env: follows stdout.isTTY (false)', () => {
    delete process.env['NO_COLOR'];
    delete process.env['FORCE_COLOR'];
    restoreTTY = withStdoutTTY(false);
    expect(resolveDefaultUseColors()).toBe(false);
  });
});

describe('ConsoleLogger color gating by default (issue #2)', () => {
  const prevNoColor = process.env['NO_COLOR'];
  const prevForceColor = process.env['FORCE_COLOR'];
  const prevLogStream = process.env['CDKL_LOG_STREAM'];
  let restoreTTY: (() => void) | undefined;

  afterEach(() => {
    if (prevNoColor === undefined) delete process.env['NO_COLOR'];
    else process.env['NO_COLOR'] = prevNoColor;
    if (prevForceColor === undefined) delete process.env['FORCE_COLOR'];
    else process.env['FORCE_COLOR'] = prevForceColor;
    if (prevLogStream === undefined) delete process.env['CDKL_LOG_STREAM'];
    else process.env['CDKL_LOG_STREAM'] = prevLogStream;
    restoreTTY?.();
    restoreTTY = undefined;
  });

  it('non-TTY, no env: the formatted error line carries NO ANSI', () => {
    // The studio-child case: stdout is a pipe. The default must be colorless.
    delete process.env['NO_COLOR'];
    delete process.env['FORCE_COLOR'];
    delete process.env['CDKL_LOG_STREAM'];
    restoreTTY = withStdoutTTY(false);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Construct WITHOUT an explicit useColors so the new default applies.
      const logger = new ConsoleLogger('info');
      logger.error('boom');
      const line = errSpy.mock.calls[0]?.[0] as string;
      expect(line).toBe('boom');
      expect(line).not.toContain(ANSI_RED);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('TTY, no env: the formatted error line carries ANSI red', () => {
    delete process.env['NO_COLOR'];
    delete process.env['FORCE_COLOR'];
    delete process.env['CDKL_LOG_STREAM'];
    restoreTTY = withStdoutTTY(true);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const logger = new ConsoleLogger('info');
      logger.error('boom');
      const line = errSpy.mock.calls[0]?.[0] as string;
      expect(line).toContain(ANSI_RED);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('composes with CDKL_LOG_STREAM=stdout: piped non-TTY child stays colorless', () => {
    // A studio serve child sets CDKL_LOG_STREAM=stdout (issue #403) AND has a
    // piped, non-TTY stdout. The two are orthogonal: routing to stdout must not
    // re-introduce color.
    delete process.env['NO_COLOR'];
    delete process.env['FORCE_COLOR'];
    process.env['CDKL_LOG_STREAM'] = 'stdout';
    restoreTTY = withStdoutTTY(false);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const logger = new ConsoleLogger('info');
      logger.error('boom');
      const line = logSpy.mock.calls[0]?.[0] as string;
      expect(line).toBe('boom');
      expect(line).not.toContain(ANSI_RED);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('honors an explicit useColors override regardless of TTY default', () => {
    // Child loggers pass useColors explicitly; the explicit value wins.
    delete process.env['NO_COLOR'];
    delete process.env['FORCE_COLOR'];
    delete process.env['CDKL_LOG_STREAM'];
    restoreTTY = withStdoutTTY(false);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const logger = new ConsoleLogger('info', true);
      logger.error('boom');
      const line = errSpy.mock.calls[0]?.[0] as string;
      expect(line).toContain(ANSI_RED);
    } finally {
      errSpy.mockRestore();
    }
  });
});
