import { describe, expect, it } from 'vitest'

import { createLogger, isLogLevel } from './logger.js'

function collector() {
  const lines: string[] = []
  return { lines, sink: (line: string) => lines.push(line) }
}

describe('createLogger', () => {
  it('emits one JSON object per line', () => {
    const { lines, sink } = collector()
    createLogger({ sink, now: () => 0 }).info('scan.batch', { batch: 7 })
    expect(JSON.parse(lines[0] ?? '{}')).toEqual({
      time: '1970-01-01T00:00:00.000Z',
      level: 'info',
      msg: 'scan.batch',
      batch: 7,
    })
  })

  it('honours the level threshold', () => {
    const { lines, sink } = collector()
    const logger = createLogger({ sink, level: 'warn' })
    logger.debug('a')
    logger.info('b')
    logger.warn('c')
    logger.error('d')
    expect(lines.map((line) => (JSON.parse(line) as { msg: string }).msg)).toEqual(['c', 'd'])
  })

  it('serialises bigint amounts rather than throwing inside a log call', () => {
    const { lines, sink } = collector()
    createLogger({ sink }).info('fee', { value: 400_000_000_000n })
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ value: '400000000000' })
  })

  it('serialises errors and byte arrays', () => {
    const { lines, sink } = collector()
    createLogger({ sink }).error('boom', { error: new TypeError('nope'), root: new Uint8Array([0xde, 0xad]) })
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      error: { name: 'TypeError', message: 'nope' },
      root: 'dead',
    })
  })

  it('stamps child fields onto every line', () => {
    const { lines, sink } = collector()
    createLogger({ sink, base: { component: 'indexer' } }).child({ batch: 3 }).info('x', { extra: 1 })
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ component: 'indexer', batch: 3, extra: 1 })
  })
})

describe('isLogLevel', () => {
  it('accepts the four levels and nothing else', () => {
    expect(['debug', 'info', 'warn', 'error'].every(isLogLevel)).toBe(true)
    expect(isLogLevel('trace')).toBe(false)
    expect(isLogLevel('toString')).toBe(false)
  })
})
