/**
 * Blocks still to go before `LAUNCH_HEIGHT`, asked of the relay once per
 * page load — no timer, no polling. `null` while unknown: before the answer,
 * with no node configured, or on a compressed-tempo era, where the question
 * does not apply. Positive means the registry is not open yet: the strip
 * says when, and every search field is inert, because a lookup against
 * resolvers that hold no state yet answers "unreachable", which reads as an
 * outage rather than a date (Rico, 2026-09-22).
 */

import { useEffect, useState } from 'react'
import { defaultTransport } from './history'
import { blocksToLaunch, isCompressedEra } from './wording'

export function useBlocksToLaunch(): number | null {
  const [blocks, setBlocks] = useState<number | null>(null)
  useEffect(() => {
    if (isCompressedEra()) return
    const transport = defaultTransport()
    if (transport === null) return
    let live = true
    transport('getBlockNumber', [])
      .then((answer) => {
        if (live && typeof answer === 'number') setBlocks(blocksToLaunch(answer))
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  return blocks
}
