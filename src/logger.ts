/**
 * Minimal timestamped logger. Will be swapped for a structured logger later
 * once the project grows (queue system, LLM calls, etc.).
 */

type Level = 'info' | 'warn' | 'error' | 'debug';

function ts(): string {
  return new Date().toISOString();
}

function log(level: Level, scope: string, ...args: unknown[]): void {
  const prefix = `[${ts()}] [${level.toUpperCase()}] [${scope}]`;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  sink(prefix, ...args);
}

export function createLogger(scope: string) {
  return {
    info: (...args: unknown[]) => log('info', scope, ...args),
    warn: (...args: unknown[]) => log('warn', scope, ...args),
    error: (...args: unknown[]) => log('error', scope, ...args),
    debug: (...args: unknown[]) => log('debug', scope, ...args),
  };
}

export type Logger = ReturnType<typeof createLogger>;
