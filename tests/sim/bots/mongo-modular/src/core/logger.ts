export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

type Meta = Record<string, unknown>;

// Errors become name/message/stack only: discord.js errors carry the request URL and body, which we don't want in logs.
function serialize(meta: Meta): string {
  return JSON.stringify(meta, (_key, value: unknown) => {
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
    if (typeof value === 'bigint') return value.toString();
    return value;
  });
}

export class Logger {
  constructor(
    private readonly level: LogLevel,
    private readonly scope = 'app',
  ) {}

  child(scope: string): Logger {
    return new Logger(this.level, `${this.scope}:${scope}`);
  }

  isEnabled(level: LogLevel): boolean {
    return SEVERITY[level] >= SEVERITY[this.level];
  }

  debug(message: string, meta?: Meta): void {
    this.write('debug', message, meta);
  }

  info(message: string, meta?: Meta): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: Meta): void {
    this.write('warn', message, meta);
  }

  error(message: string, meta?: Meta): void {
    this.write('error', message, meta);
  }

  private write(level: LogLevel, message: string, meta?: Meta): void {
    if (!this.isEnabled(level)) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${this.scope}] ${message}${meta ? ` ${serialize(meta)}` : ''}\n`;
    if (SEVERITY[level] >= SEVERITY.warn) process.stderr.write(line);
    else process.stdout.write(line);
  }
}
