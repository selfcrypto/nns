/**
 * Structured logging, one JSON object per line. Deliberately its own tiny
 * implementation rather than an import from `@nns/indexer`: this service is
 * independent of the protocol's code, and a logger is not worth a coupling.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export function isLogLevel(value: string): value is LogLevel {
  return value in ORDER
}

export type LogFields = Record<string, unknown>

export interface Logger {
  debug(event: string, fields?: LogFields): void
  info(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
  error(event: string, fields?: LogFields): void
}

export function createLogger(level: LogLevel = 'info', write: (line: string) => void = (line) => process.stdout.write(line)): Logger {
  const emit = (severity: LogLevel, event: string, fields?: LogFields): void => {
    if (ORDER[severity] < ORDER[level]) return
    const payload: LogFields = { level: severity, component: 'chat-index', event, ...fields }
    if (payload['error'] instanceof Error) payload['error'] = payload['error'].message
    write(`${JSON.stringify(payload)}\n`)
  }
  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  }
}
