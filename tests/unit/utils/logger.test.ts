import { describe, it, expect, afterEach, vi } from 'vite-plus/test';
import {
  resolveConfiguredLogLevel,
  resolveDefaultUseColors,
  ConsoleLogger,
  setLogger,
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
        'WARN: a warning',
        'ERROR: an error',
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
      expect(line).toBe('ERROR: boom');
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
      expect(line).toBe('ERROR: boom');
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

describe('ConsoleLogger compact-mode level prefix', () => {
  const prevLogStream = process.env['CDKL_LOG_STREAM'];

  afterEach(() => {
    if (prevLogStream === undefined) delete process.env['CDKL_LOG_STREAM'];
    else process.env['CDKL_LOG_STREAM'] = prevLogStream;
  });

  it('prefixes warn / error so severity survives a colorless pipe; info stays bare', () => {
    // The severity signal that crosses the studio child pipe (no ANSI there).
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const logger = new ConsoleLogger('info', false);
      logger.info('progress');
      logger.warn('heads up');
      logger.error('broke');
      expect(infoSpy.mock.calls[0]?.[0]).toBe('progress');
      expect(warnSpy.mock.calls[0]?.[0]).toBe('WARN: heads up');
      expect(errSpy.mock.calls[0]?.[0]).toBe('ERROR: broke');
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('keeps the prefix INSIDE the color wrap when colors are on', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const logger = new ConsoleLogger('info', true);
      logger.error('broke');
      const line = errSpy.mock.calls[0]?.[0] as string;
      // red ... ERROR: broke ... reset
      expect(line).toBe(`\x1b[31mERROR: broke\x1b[0m`);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('a child logger in compact mode also carries the prefix (no [module] tag)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // The child syncs its LEVEL from the global logger; pin it to info so the
      // compact (not debug) branch is exercised regardless of cross-test state.
      const parent = new ConsoleLogger('info', false);
      setLogger(parent);
      const child = parent.child('docker');
      child.warn('heads up');
      // compact mode omits the [module] tag but keeps the level prefix.
      expect(warnSpy.mock.calls[0]?.[0]).toBe('WARN: heads up');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('ConsoleLogger with an embedding host logger (go-to-k/cdkd#2429)', () => {
  // A host that reserves stdout for a payload must be able to keep every line
  // cdk-local logs off it, and its --verbose must reach cdk-local's debug lines.
  // The embed config's `logger` takes over output, level filtering and level.
  type Level = 'debug' | 'info' | 'warn' | 'error';
  function makeHost(initial: Level = 'info') {
    let level: Level = initial;
    return {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      setLevel: vi.fn((l: Level) => {
        level = l;
      }),
      getLevel: vi.fn(() => level),
    };
  }

  afterEach(async () => {
    const { resetEmbedConfig } = await import('../../../src/local/embed-config.js');
    resetEmbedConfig();
    setLogger(new ConsoleLogger('info', false));
    vi.restoreAllMocks();
  });

  it('hands every level to the host unformatted and writes nothing to the console', async () => {
    const { setEmbedConfig } = await import('../../../src/local/embed-config.js');
    const host = makeHost();
    setEmbedConfig({ logger: host });
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
    ];
    const logger = new ConsoleLogger('info', false);

    logger.info('Building container image (platform=linux/amd64)...');
    logger.warn('careful', { a: 1 });
    logger.error('broken');
    logger.debug('detail');

    expect(host.info).toHaveBeenCalledWith('Building container image (platform=linux/amd64)...');
    expect(host.warn).toHaveBeenCalledWith('careful', { a: 1 });
    expect(host.error).toHaveBeenCalledWith('broken');
    // The host owns the level filter, so a debug line reaches it at info.
    expect(host.debug).toHaveBeenCalledWith('detail');
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("forwards setLevel to the host and reads the host's level back", async () => {
    const { setEmbedConfig } = await import('../../../src/local/embed-config.js');
    const host = makeHost('info');
    setEmbedConfig({ logger: host });
    const logger = new ConsoleLogger('info', false);

    logger.setLevel('debug'); // what a cdk-local command does under --verbose
    expect(host.setLevel).toHaveBeenCalledWith('debug');
    host.setLevel('warn');
    expect(logger.getLevel()).toBe('warn');
  });

  it("routes a child logger through the host, prefixed under the host's debug level", async () => {
    const { setEmbedConfig } = await import('../../../src/local/embed-config.js');
    const host = makeHost('debug');
    setEmbedConfig({ logger: host });
    const parent = new ConsoleLogger('info', false);
    setLogger(parent);
    const child = parent.child('role-arn');
    host.setLevel.mockClear();

    child.info('assumed');
    child.warn('fallback');

    expect(host.info).toHaveBeenCalledWith('[role-arn] assumed');
    expect(host.warn).toHaveBeenCalledWith('[role-arn] fallback');
    // A child mirrors the level; it must not push it back into the host.
    expect(host.setLevel).not.toHaveBeenCalled();
  });

  it('writes to the console again once the host logger is cleared', async () => {
    const { setEmbedConfig } = await import('../../../src/local/embed-config.js');
    const host = makeHost();
    setEmbedConfig({ logger: host });
    setEmbedConfig({ cliName: 'x' }); // a later factory without a logger
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    new ConsoleLogger('info', false).info('hello');

    expect(info).toHaveBeenCalledWith('hello');
    expect(host.info).not.toHaveBeenCalled();
  });

  it('falls back to the console instead of recursing when the host is a cdk-local logger', async () => {
    const { setEmbedConfig } = await import('../../../src/local/embed-config.js');
    const self = new ConsoleLogger('info', false);
    // A counting host that delegates straight back into cdk-local's logger.
    const host = {
      debug: vi.fn((m: string) => self.debug(m)),
      info: vi.fn((m: string) => self.info(m)),
      warn: vi.fn((m: string) => self.warn(m)),
      error: vi.fn((m: string) => self.error(m)),
      setLevel: vi.fn((l: Level) => self.setLevel(l)),
      getLevel: vi.fn(() => self.getLevel()),
    };
    setEmbedConfig({ logger: host });
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    self.info('once');
    // One forward, one console write: the re-entry reached the console
    // directly instead of forwarding again (a missing guard recurses until the
    // stack overflows, and the catch in forward() would otherwise hide it).
    expect(host.info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('once');
    expect(self.getLevel()).toBe('info');
    expect(host.getLevel).toHaveBeenCalledTimes(1);
  });

  it('falls back to the console when the host logger throws', async () => {
    const { setEmbedConfig } = await import('../../../src/local/embed-config.js');
    const host = makeHost();
    host.warn.mockImplementation(() => {
      throw new Error('host sink closed');
    });
    setEmbedConfig({ logger: host });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(() => new ConsoleLogger('info', false).warn('cleanup failed')).not.toThrow();
    expect(warn).toHaveBeenCalledWith('WARN: cleanup failed');
  });

  it.each(['CDKL_LOG_STREAM', 'CDKL_LOG_LEVEL'])(
    'keeps the console logger in a studio child (%s set), honoring its level',
    async (name) => {
      const { setEmbedConfig } = await import('../../../src/local/embed-config.js');
      const host = makeHost('debug');
      setEmbedConfig({ logger: host });
      const prev = process.env[name];
      process.env[name] = name === 'CDKL_LOG_STREAM' ? 'stderr' : 'warn';
      vi.spyOn(console, 'info').mockImplementation(() => undefined);
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        const logger = new ConsoleLogger('warn', false);
        logger.info('Synthesizing CDK app...');
        expect(host.info).not.toHaveBeenCalled();
        expect(logger.getLevel()).toBe('warn');
      } finally {
        if (prev === undefined) delete process.env[name];
        else process.env[name] = prev;
      }
    }
  );
});

describe('ConsoleLogger control escape + continuation indent (go-to-k/cdk-local#827)', () => {
  // The expected values are written out literally rather than derived from
  // `renderLogText` / `LOG_CONTINUATION_INDENT`, so a change to the subject
  // cannot move the expectation with it.
  const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
  // Each value an assembly-chosen identifier could carry into a message.
  const FORGERIES: Array<[string, string]> = [
    ['an injected newline + WARN: line', 'id-a\nWARN: forged'],
    ['an injected newline + ready banner', 'id-a\nServer listening on http://evil:1'],
    ['a carriage return rewriting the line', 'id-a\rERROR: forged'],
    ['a CRLF + ERROR: line', 'id-a\r\nERROR: forged'],
    ['an ESC clear-screen', 'id-a\x1b[2Jforged'],
    ['an ESC erase-line + CR', 'id-a\x1b[2K\rWARN: forged'],
    ['a C1 CSI', 'id-a\x9b2Jforged'],
    ['a DEL and a NUL', 'id-a\x7f\x00forged'],
    ['a Unicode line separator', 'id-a\u2028WARN: forged'],
  ];
  // Any control character the logger must never emit from a message body,
  // with colours off (C0 minus \n / \t, DEL, C1, the Unicode separators).
  // eslint-disable-next-line no-control-regex -- the control characters are exactly what is hunted.
  const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/;

  function captureAll(): { lines: () => string[]; restore: () => void } {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined)
    );
    return {
      lines: () => spies.flatMap((s) => s.mock.calls.map((c) => String(c[0]))),
      restore: () => {
        for (const s of spies) s.mockRestore();
      },
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const mode of ['info', 'debug'] as const) {
    for (const level of LEVELS) {
      it.each(FORGERIES)(
        `${mode}-mode ${level}: %s forges no line and emits no control`,
        (_label, value) => {
          const cap = captureAll();
          try {
            const logger = new ConsoleLogger(mode, false);
            logger[level](`Resolving ${value} in stack`);
            const out = cap.lines();
            if (mode === 'info' && level === 'debug') {
              expect(out).toEqual([]);
              return;
            }
            expect(out).toHaveLength(1);
            const physical = out[0]!.split('\n');
            expect(out[0]).not.toMatch(UNSAFE);
            for (const cont of physical.slice(1)) {
              expect(cont.startsWith('  ')).toBe(true);
            }
            // No physical line but the first may begin with anything a
            // studio matcher or a reader anchors on.
            for (const line of physical.slice(1)) {
              expect(line).not.toMatch(/^(WARN|ERROR): /);
              expect(line).not.toMatch(/^Server listening on /);
              expect(line).not.toMatch(/^\d{4}-\d{2}-\d{2}T/);
            }
          } finally {
            cap.restore();
          }
        }
      );
    }
  }

  it('renders each forgery to an exact, readable value (compact warn)', () => {
    const cap = captureAll();
    try {
      const logger = new ConsoleLogger('info', false);
      logger.warn('x id-a\nWARN: forged');
      logger.warn('x id-a\rERROR: forged');
      logger.warn('x id-a\r\nERROR: forged');
      logger.warn('x id-a\x1b[2Jforged');
      logger.warn('x id-a\x9b2Jforged');
      logger.warn('x\ty');
      expect(cap.lines()).toEqual([
        'WARN: x id-a\n  WARN: forged',
        'WARN: x id-a\\u000dERROR: forged',
        'WARN: x id-a\n  ERROR: forged',
        'WARN: x id-a\\u001b[2Jforged',
        'WARN: x id-a\\u009b2Jforged',
        'WARN: x\ty',
      ]);
    } finally {
      cap.restore();
    }
  });

  it('keeps a legitimate multi-line message, indenting each non-empty continuation line', () => {
    const cap = captureAll();
    try {
      const logger = new ConsoleLogger('info', false);
      logger.error('Route discovery failed:\n  - first\n  - second\n\nSee the docs.');
      logger.info('one\ntwo');
      // `captureAll` groups by console method: info's line precedes error's.
      expect(cap.lines()).toEqual([
        'one\n  two',
        'ERROR: Route discovery failed:\n    - first\n    - second\n\n  See the docs.',
      ]);
    } finally {
      cap.restore();
    }
  });

  it("keeps the logger's own colours, escaping only the message's ESC", () => {
    const cap = captureAll();
    try {
      const logger = new ConsoleLogger('info', true);
      logger.warn('a\x1b[2Jb\nc');
      logger.error('e\x1b[31m');
      expect(cap.lines()).toEqual([
        '\x1b[33mWARN: a\\u001b[2Jb\n  c\x1b[0m',
        '\x1b[31mERROR: e\\u001b[31m\x1b[0m',
      ]);
    } finally {
      cap.restore();
    }
  });

  it('keeps the verbose-mode colours, escaping only the message', () => {
    const cap = captureAll();
    try {
      const logger = new ConsoleLogger('debug', true);
      logger.info('a\x1b[2Jb\nc');
      const [line] = cap.lines();
      expect(line).toMatch(
        /^\x1b\[2m\d{4}-\d{2}-\d{2}T[\d:.]+Z\x1b\[0m \x1b\[34mINFO \x1b\[0m a\\u001b\[2Jb\n {2}c$/
      );
    } finally {
      cap.restore();
    }
  });

  it('renders a child logger prefix and message once (verbose and compact)', () => {
    const cap = captureAll();
    try {
      setLogger(new ConsoleLogger('debug', false));
      const child = new ConsoleLogger('debug', false).child('mod');
      child.warn('a\nWARN: b');
      setLogger(new ConsoleLogger('info', false));
      child.warn('a\nWARN: b');
      const out = cap.lines();
      expect(out[0]).toMatch(/^\S+Z WARN {2}\[mod\] a\n {2}WARN: b$/);
      expect(out[1]).toBe('WARN: a\n  WARN: b');
    } finally {
      cap.restore();
      setLogger(new ConsoleLogger('info', false));
    }
  });

  it('escapes what JSON.stringify leaves raw in the extra arguments', () => {
    const cap = captureAll();
    try {
      const logger = new ConsoleLogger('info', false);
      logger.warn('m', 'a\u2028b\x9bc\x7f');
      expect(cap.lines()).toEqual(['WARN: m "a\\u2028b\\u009bc\\u007f"']);
    } finally {
      cap.restore();
    }
  });

  it('hands the embedding host the rendered message and string arguments', async () => {
    const { setEmbedConfig, resetEmbedConfig } =
      await import('../../../src/local/embed-config.js');
    const host = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      setLevel: vi.fn(),
      getLevel: vi.fn(() => 'info' as const),
    };
    setEmbedConfig({ logger: host });
    const cap = captureAll();
    try {
      const logger = new ConsoleLogger('info', false);
      const obj = { k: 'v\x1b' };
      logger.debug('d\x1b[2J');
      logger.info('i\nERROR: x');
      logger.warn('w\r\nWARN: x', 'arg\rz', obj);
      logger.error('e\x9b');
      expect(host.debug).toHaveBeenCalledWith('d\\u001b[2J');
      expect(host.info).toHaveBeenCalledWith('i\n  ERROR: x');
      // A non-string argument is handed over as-is: the host formats it.
      expect(host.warn).toHaveBeenCalledWith('w\n  WARN: x', 'arg\\u000dz', obj);
      expect(host.error).toHaveBeenCalledWith('e\\u009b');
      expect(cap.lines()).toEqual([]);
    } finally {
      cap.restore();
      resetEmbedConfig();
      setLogger(new ConsoleLogger('info', false));
    }
  });
});
