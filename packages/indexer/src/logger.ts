/**
 * Structured logging — one JSON object per line on stdout.
 *
 * Lines are machine-readable on purpose: the operational questions this
 * indexer has to answer ("which height is committed", "how many verdicts of
 * each kind", "which root at which checkpoint") are all aggregations, and a
 * prose log makes them a parsing exercise. `msg` is the stable key; every
 * other field is free.
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
  /** A child logger that stamps `fields` onto every line. */
  child(fields: LogFields): Logger
}

export interface LoggerOptions {
  level?: LogLevel
  /** Defaults to writing a line to stdout. Tests pass a collector. */
  sink?: (line: string) => void
  /** Defaults to `Date.now`. */
  now?: () => number
  base?: LogFields
}

/**
 * `bigint` has no JSON representation, and every luna amount in this codebase
 * is one. Serialising it as a decimal string keeps the log lossless; throwing
 * (the default) would take the process down from inside a log call.
 */
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Error) return { name: value.name, message: value.message }
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex')
  return value
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info'
  const sink = options.sink ?? ((line: string) => process.stdout.write(line + '\n'))
  const now = options.now ?? Date.now
  const base = options.base ?? {}
  const threshold = ORDER[level]

  const emit = (lineLevel: LogLevel, msg: string, fields?: LogFields): void => {
    if (ORDER[lineLevel] < threshold) return
    const record = { time: new Date(now()).toISOString(), level: lineLevel, msg, ...base, ...fields }
    sink(JSON.stringify(record, replacer))
  }

  return {
    level,
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (fields) => createLogger({ ...options, level, base: { ...base, ...fields } }),
  }
}

export function isLogLevel(value: string): value is LogLevel {
  // `in` would walk the prototype chain and accept "toString".
  return Object.hasOwn(ORDER, value)
}
