/**
 * Logger interface and console implementation for cdk-local.
 *
 * A minimal `Logger` / `LogLevel` interface with a `ConsoleLogger`
 * (`getLogger()` / `setLogger()` exports, `child(prefix)` for prefixed
 * sub-loggers). cdk-local invokes a single Lambda / API / task at a time,
 * so there is no parallel multi-stack output to interleave — a plain
 * console logger with no output buffer or live progress renderer suffices.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

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
 * Console logger implementation
 *
 * Supports two output modes:
 * - verbose (debug level): timestamps, module prefixes, all details
 * - compact (info level): clean output without timestamps or prefixes
 */
export class ConsoleLogger implements Logger {
  private level: LogLevel;
  private useColors: boolean;

  constructor(level: LogLevel = 'info', useColors: boolean = true) {
    this.level = level;
    this.useColors = useColors;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    const currentLevelIndex = levels.indexOf(this.level);
    const messageLevelIndex = levels.indexOf(level);
    return messageLevelIndex >= currentLevelIndex;
  }

  private formatMessage(level: LogLevel, message: string, ...args: unknown[]): string {
    const formattedArgs = args.length > 0 ? ' ' + args.map((a) => JSON.stringify(a)).join(' ') : '';

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

    if (this.useColors) {
      if (level === 'error') {
        return `${colors.red}${message}${formattedArgs}${colors.reset}`;
      }
      if (level === 'warn') {
        return `${colors.yellow}${message}${formattedArgs}${colors.reset}`;
      }
      return `${message}${formattedArgs}`;
    }

    return `${message}${formattedArgs}`;
  }

  private emit(level: LogLevel, formatted: string): void {
    if (level === 'error') console.error(formatted);
    else if (level === 'warn') console.warn(formatted);
    else if (level === 'info') console.info(formatted);
    else console.debug(formatted);
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.shouldLog('debug')) {
      this.emit('debug', this.formatMessage('debug', message, ...args));
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (this.shouldLog('info')) {
      this.emit('info', this.formatMessage('info', message, ...args));
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (this.shouldLog('warn')) {
      this.emit('warn', this.formatMessage('warn', message, ...args));
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (this.shouldLog('error')) {
      this.emit('error', this.formatMessage('error', message, ...args));
    }
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
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
    if (globalLogger) {
      this.setLevel(globalLogger.getLevel());
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

let globalLogger: ConsoleLogger | null = null;

export function getLogger(): ConsoleLogger {
  if (!globalLogger) {
    globalLogger = new ConsoleLogger();
  }
  return globalLogger;
}

export function setLogger(logger: ConsoleLogger): void {
  globalLogger = logger;
}
