/**
 * One JSON object per line on stdout, same shape as the indexer's.
 *
 * A local copy rather than an import: `@nns/indexer` is where `Logger` already
 * lives, and taking it from there would drag `pg` and an RPC client into a
 * package that has neither — and would make a delegate depend on registry
 * infrastructure, which is the one thing this package exists to not be. The
 * duplication is twenty lines and is deliberate.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export type LogFields = Readonly<Record<string, unknown>>

export interface Logger {
  readonly level: LogLevel
  debug(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  error(msg: string, fields?: LogFields): void
}

export interface LoggerOptions {
  level?: LogLevel
  /** Defaults to writing a line to stdout. Tests pass a collector. */
  sink?: (line: string) => void
  now?: () => number
  base?: LogFields
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info'
  const sink = options.sink ?? ((line: string) => process.stdout.write(line + '\n'))
  const now = options.now ?? Date.now
  const base = options.base ?? {}
  const threshold = ORDER[level]

  const emit = (lineLevel: LogLevel, msg: string, fields?: LogFields): void => {
    if (ORDER[lineLevel] < threshold) return
    sink(JSON.stringify({ time: new Date(now()).toISOString(), level: lineLevel, msg, ...base, ...fields }))
  }

  return {
    level,
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  }
}

export function isLogLevel(value: string): value is LogLevel {
  return Object.hasOwn(ORDER, value)
}
