/**
 * Logger interface and console implementation for cdk-local.
 *
 * A minimal `Logger` / `LogLevel` interface with a `ConsoleLogger`
 * (`getLogger()` / `setLogger()` exports, `child(prefix)` for prefixed
 * sub-loggers). cdk-local invokes a single Lambda / API / task at a time,
 * so there is no parallel multi-stack output to interleave — a plain
 * console logger with no output buffer or live progress renderer suffices.
 */

import { getEmbedConfig, type EmbedHostLogger } from '../local/embed-config.js';
import { displayToolOutput } from './ident-display.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * What every continuation line of a multi-line message is indented by, so no
 * content line a message carries reaches column 0 (go-to-k/cdk-local#827).
 */
export const LOG_CONTINUATION_INDENT = '  ';

/**
 * Render one message's TEXT for output: the logger's own second layer beside
 * the `displayIdent` boundary of go-to-k/cdk-local#761, so an assembly-chosen
 * value interpolated BARE into a message cannot forge or rewrite a line.
 *
 * 1. `\r\n` folds to `\n`, so a CRLF-terminated tool message stays readable.
 * 2. Every remaining control character other than `\n` / `\t` (C0, DEL, C1 —
 *    a lone `\r`, ESC and the 8-bit CSI `\x9b` included), the Unicode line /
 *    paragraph separators and the bidi controls become their `\uXXXX` escape
 *    ({@link displayToolOutput}), so nothing can move the cursor, erase a line
 *    or start a colour.
 * 3. Every non-empty continuation line is indented by
 *    {@link LOG_CONTINUATION_INDENT}. A message can still span lines, but none
 *    of its lines after the first starts at column 0 — where studio's
 *    `classifyChildLine` / ready patterns and its LOG panel's `WARN:` /
 *    `ERROR:` colouring anchor, and where a reader takes a line to be a fresh
 *    one. The FIRST line is never indented: its column-0 prefix is the logger's
 *    own.
 *
 * Applied BEFORE the logger's own colouring (whose escapes must survive) and
 * before the embedding host's logger is handed the message, so a host gets the
 * same text. Not idempotent (each pass indents again): render each text ONCE.
 */
export function renderLogText(text: string): string {
  // A caller typed `any` can hand a non-string; render it as the template
  // literal this replaced did, rather than throw out of a log call.
  const raw = typeof text === 'string' ? text : String(text);
  return displayToolOutput(raw.replace(/\r\n/g, '\n')).replace(
    /\n(?=[^\n])/g,
    `\n${LOG_CONTINUATION_INDENT}`
  );
}

/** {@link renderLogText} over a host-bound argument, when it is text. */
function renderLogArg(arg: unknown): unknown {
  return typeof arg === 'string' ? renderLogText(arg) : arg;
}

/** True while a call is being handed to the host logger (re-entry guard). */
let forwarding = false;

/**
 * The embedding host's logger, when one was supplied via the embed config AND
 * the process is not a `cdkl studio` child. Studio sets `CDKL_LOG_LEVEL` /
 * `CDKL_LOG_STREAM` on the children it spawns to control what reaches its LOGS
 * panel and which pipe carries it (issues #403 / #608); an embedding host's
 * studio spawns the HOST's binary, so under either variable cdk-local keeps its
 * own console logger and honors them. Also undefined while a forward is in
 * flight, so a host logger that calls back into cdk-local's logger (or IS one)
 * falls through to the console instead of recursing.
 */
function hostLogger(): EmbedHostLogger | undefined {
  if (forwarding) return undefined;
  if (process.env['CDKL_LOG_STREAM'] !== undefined || process.env['CDKL_LOG_LEVEL'] !== undefined) {
    return undefined;
  }
  return getEmbedConfig().logger;
}

/**
 * Hand one call to the host logger. Returns false when it threw, so the caller
 * falls back to the console: a host logger failing must not turn a log line
 * into an exception inside cdk-local's cleanup paths.
 */
function forward(run: () => void): boolean {
  forwarding = true;
  try {
    run();
    return true;
  } catch {
    return false;
  } finally {
    forwarding = false;
  }
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  setLevel(level: LogLevel): void;
  getLevel(): LogLevel;
  child(prefix: string): Logger;
}

/**
 * ANSI color codes
 *
 * Kept internal — `ConsoleLogger.formatMessage` references these for the
 * verbose/compact mode level prefixes.
 */
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const;

function formatTimestamp(): string {
  const now = new Date();
  return now.toISOString();
}

/**
 * Resolve whether ANSI color should be emitted by default.
 *
 * Color is appropriate for an interactive terminal but is noise (literal
 * `\x1b[31m...` escapes) when the output is a pipe — e.g. when `cdkl studio`
 * spawns `cdkl invoke` / a serve command as a child and captures its output to
 * render in the browser, where the raw escapes leak as visible text. So the
 * default tracks the stdout TTY-ness, with the two standard env overrides:
 *
 * - `NO_COLOR` (any non-empty value) forces colors OFF (https://no-color.org).
 * - `FORCE_COLOR` (non-empty, not `'0'` / `'false'`) forces colors ON, even
 *   when not a TTY (the convention many CLIs honor for CI / log capture).
 * - otherwise: on when `process.stdout.isTTY`.
 *
 * We gate on `process.stdout.isTTY` even though warn / error go to stderr via
 * `console.error` / `console.warn`. In the case this fix targets — a piped
 * child (e.g. studio) — NEITHER stdout nor stderr is a TTY, so gating on stdout
 * still yields colorless output. Tracking stdout matches common CLI tooling and
 * keeps a single, predictable signal; an explicit `useColors` argument (passed
 * by child loggers) always overrides this default.
 */
export function resolveDefaultUseColors(): boolean {
  const noColor = process.env['NO_COLOR'];
  if (noColor !== undefined && noColor !== '') {
    return false;
  }
  const forceColor = process.env['FORCE_COLOR'];
  if (
    forceColor !== undefined &&
    forceColor !== '' &&
    forceColor !== '0' &&
    forceColor !== 'false'
  ) {
    return true;
  }
  return !!process.stdout.isTTY;
}

/**
 * Console logger implementation
 *
 * Supports two output modes:
 * - verbose (debug level): timestamps, module prefixes, all details
 * - compact (info level): clean output without timestamps or prefixes
 */
export class ConsoleLogger implements Logger {
  protected level: LogLevel;
  private useColors: boolean;

  constructor(level: LogLevel = 'info', useColors: boolean = resolveDefaultUseColors()) {
    this.level = level;
    this.useColors = useColors;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    const currentLevelIndex = levels.indexOf(this.level);
    const messageLevelIndex = levels.indexOf(level);
    return messageLevelIndex >= currentLevelIndex;
  }

  /**
   * Format a message whose text was already put through {@link renderLogText}
   * (each level method does that once, before the host route). The arguments'
   * JSON is rendered here: `JSON.stringify` escapes C0 but not DEL, C1 or
   * U+2028 / U+2029.
   */
  private formatMessage(level: LogLevel, message: string, ...args: unknown[]): string {
    const formattedArgs =
      args.length > 0 ? renderLogText(' ' + args.map((a) => JSON.stringify(a)).join(' ')) : '';

    if (this.level === 'debug') {
      const timestamp = formatTimestamp();
      const levelStr = level.toUpperCase().padEnd(5);

      if (this.useColors) {
        const levelColorMap: Record<LogLevel, string> = {
          debug: colors.gray,
          info: colors.blue,
          warn: colors.yellow,
          error: colors.red,
        };
        const levelColor = levelColorMap[level];

        return `${colors.dim}${timestamp}${colors.reset} ${levelColor}${levelStr}${colors.reset} ${message}${formattedArgs}`;
      }

      return `${timestamp} ${levelStr} ${message}${formattedArgs}`;
    }

    // Compact mode (info level) prefixes warn / error with an UPPERCASE level
    // tag so the severity is legible even when ANSI color is stripped — a
    // piped / redirected CLI run, `NO_COLOR`, or the `cdkl studio` serve child
    // (captured over a pipe, so colorless). Color, when available, still wraps
    // the whole line. info stays prefix-less so the common-case progress output
    // is unchanged. The prefix is the one severity signal that survives a pipe,
    // and studio's LOG panel re-colors off it (studio-ui).
    if (level === 'error') {
      const line = `ERROR: ${message}${formattedArgs}`;
      return this.useColors ? `${colors.red}${line}${colors.reset}` : line;
    }
    if (level === 'warn') {
      const line = `WARN: ${message}${formattedArgs}`;
      return this.useColors ? `${colors.yellow}${line}${colors.reset}` : line;
    }

    return `${message}${formattedArgs}`;
  }

  private emit(level: LogLevel, formatted: string): void {
    // `cdkl studio` sets `CDKL_LOG_STREAM=stdout` on its spawned serve children
    // (issue #403) so EVERY level routes to stdout instead of the default
    // warn/error -> stderr split. studio captures a child's stdout and stderr
    // via two separate OS pipes, and Node does NOT guarantee cross-pipe
    // delivery order — a warn written just before a stdout banner can surface
    // AFTER it in the studio LOG panel (e.g. the pinned-image WARN landing
    // below "Press ^C to shut down."). Emitting one stream preserves emission
    // order for that consumer. Direct CLI use never sets the var, so the
    // warn/error -> stderr split is unchanged there.
    if (process.env['CDKL_LOG_STREAM'] === 'stdout') {
      console.log(formatted);
      return;
    }
    if (level === 'error') console.error(formatted);
    else if (level === 'warn') console.warn(formatted);
    else if (level === 'info') console.info(formatted);
    else console.debug(formatted);
  }

  debug(message: string, ...args: unknown[]): void {
    const text = renderLogText(message);
    const host = hostLogger();
    if (host && forward(() => host.debug(text, ...args.map(renderLogArg)))) return;
    if (this.shouldLog('debug')) {
      this.emit('debug', this.formatMessage('debug', text, ...args));
    }
  }

  info(message: string, ...args: unknown[]): void {
    const text = renderLogText(message);
    const host = hostLogger();
    if (host && forward(() => host.info(text, ...args.map(renderLogArg)))) return;
    if (this.shouldLog('info')) {
      this.emit('info', this.formatMessage('info', text, ...args));
    }
  }

  warn(message: string, ...args: unknown[]): void {
    const text = renderLogText(message);
    const host = hostLogger();
    if (host && forward(() => host.warn(text, ...args.map(renderLogArg)))) return;
    if (this.shouldLog('warn')) {
      this.emit('warn', this.formatMessage('warn', text, ...args));
    }
  }

  error(message: string, ...args: unknown[]): void {
    const text = renderLogText(message);
    const host = hostLogger();
    if (host && forward(() => host.error(text, ...args.map(renderLogArg)))) return;
    if (this.shouldLog('error')) {
      this.emit('error', this.formatMessage('error', text, ...args));
    }
  }

  setLevel(level: LogLevel): void {
    this.level = level;
    const host = hostLogger();
    if (host) forward(() => host.setLevel(level));
  }

  getLevel(): LogLevel {
    const host = hostLogger();
    let level: LogLevel | undefined;
    if (host) forward(() => (level = host.getLevel()));
    return level ?? this.level;
  }

  child(prefix: string): ChildLogger {
    return new ChildLogger(prefix, this.useColors);
  }
}

/**
 * Child logger that always syncs level from global logger
 */
class ChildLogger extends ConsoleLogger {
  private readonly prefix: string;

  constructor(prefix: string, useColors: boolean) {
    super('info', useColors);
    this.prefix = prefix;
  }

  private syncLevel(): void {
    // Assign the field, not setLevel(): a child mirrors the level, and must not
    // push it back into an embedding host's logger.
    if (globalLogger) {
      this.level = globalLogger.getLevel();
    }
  }

  override debug(message: string, ...args: unknown[]): void {
    this.syncLevel();
    super.debug(`[${this.prefix}] ${message}`, ...args);
  }

  override info(message: string, ...args: unknown[]): void {
    this.syncLevel();
    const msg = this.getLevel() === 'debug' ? `[${this.prefix}] ${message}` : message;
    super.info(msg, ...args);
  }

  override warn(message: string, ...args: unknown[]): void {
    this.syncLevel();
    const msg = this.getLevel() === 'debug' ? `[${this.prefix}] ${message}` : message;
    super.warn(msg, ...args);
  }

  override error(message: string, ...args: unknown[]): void {
    this.syncLevel();
    const msg = this.getLevel() === 'debug' ? `[${this.prefix}] ${message}` : message;
    super.error(msg, ...args);
  }
}

/**
 * Resolve the initial log level from the `CDKL_LOG_LEVEL` env var, falling
 * back to `'info'`. This is primarily an internal contract: `cdkl studio`
 * spawns its single-shot `cdkl invoke` child with `CDKL_LOG_LEVEL=warn` so
 * cdk-local's OWN synth / orchestration progress (toolkit "Successfully
 * synthesized to ...", asset-bundling lines, info-level status) is silenced
 * in the child — leaving the studio LOGS panel showing only the Lambda
 * container's runtime logs (which stream straight from `docker logs` and are
 * unaffected by this level) plus the response. `--verbose` still overrides to
 * `debug` at the command layer. An invalid value is ignored.
 */
export function resolveConfiguredLogLevel(): LogLevel {
  const env = process.env['CDKL_LOG_LEVEL'];
  if (env === 'debug' || env === 'info' || env === 'warn' || env === 'error') {
    return env;
  }
  return 'info';
}

let globalLogger: ConsoleLogger | null = null;

export function getLogger(): ConsoleLogger {
  if (!globalLogger) {
    globalLogger = new ConsoleLogger(resolveConfiguredLogLevel());
  }
  return globalLogger;
}

export function setLogger(logger: ConsoleLogger): void {
  globalLogger = logger;
}
