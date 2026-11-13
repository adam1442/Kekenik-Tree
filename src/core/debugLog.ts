import type { Logger, LogLevel } from './logger';

export interface LogLine {
  t: number;
  level: LogLevel;
  scope: string;
  text: string;
}

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** In-memory ring buffer of recent log lines (included in crash reports). */
class DebugLog {
  private readonly buffer: LogLine[] = [];
  private readonly listeners = new Set<() => void>();
  constructor(private readonly capacity = 200) {}

  push(line: LogLine): void {
    this.buffer.push(line);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    this.listeners.forEach((l) => l());
  }

  lines(): readonly LogLine[] {
    return this.buffer;
  }

  clear(): void {
    this.buffer.length = 0;
    this.listeners.forEach((l) => l());
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const debugLog = new DebugLog();

const fmt = (message: string, data: unknown[]): string => (data.length === 0 ? message : `${message} ${data.map((d) => (typeof d === 'string' ? d : JSON.stringify(d))).join(' ')}`);

/** Logger that records EVERY level into `debugLog` and echoes lines at or above `consoleLevel` to the console. */
export function createDebugLogger(scope: string, consoleLevel: LogLevel = 'warn'): Logger {
  const emit = (level: LogLevel, message: string, data: unknown[]): void => {
    debugLog.push({ t: Date.now(), level, scope, text: fmt(message, data) });
    if (ORDER[level] < ORDER[consoleLevel]) return;
    const fn = level === 'debug' ? console.debug : level === 'info' ? console.info : level === 'warn' ? console.warn : console.error;
    fn(`[${scope}] ${message}`, ...data);
  };
  return {
    debug: (m, ...d) => emit('debug', m, d),
    info: (m, ...d) => emit('info', m, d),
    warn: (m, ...d) => emit('warn', m, d),
    error: (m, ...d) => emit('error', m, d),
    child: (s) => createDebugLogger(`${scope}:${s}`, consoleLevel),
  };
}
