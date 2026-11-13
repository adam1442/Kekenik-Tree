export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, ...data: unknown[]): void;
  info(message: string, ...data: unknown[]): void;
  warn(message: string, ...data: unknown[]): void;
  error(message: string, ...data: unknown[]): void;
  child(scope: string): Logger;
}

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function createLogger(scope: string, minLevel: LogLevel = 'warn'): Logger {
  const emit = (level: LogLevel, message: string, data: unknown[]): void => {
    if (ORDER[level] < ORDER[minLevel]) return;
    const fn = level === 'debug' ? console.debug : level === 'info' ? console.info : level === 'warn' ? console.warn : console.error;
    fn(`[${scope}] ${message}`, ...data);
  };
  return {
    debug: (m, ...d) => emit('debug', m, d),
    info: (m, ...d) => emit('info', m, d),
    warn: (m, ...d) => emit('warn', m, d),
    error: (m, ...d) => emit('error', m, d),
    child: (s) => createLogger(`${scope}:${s}`, minLevel),
  };
}
