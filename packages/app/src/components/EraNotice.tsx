/**
 * One strip under the masthead, on every screen. Two notices share it, and
 * both are derived rather than configured, so neither can be forgotten or
 * left on:
 *
 * - on a compressed-tempo era (`isCompressedEra`, wording.ts): the tag and
 *   the line saying none of this is real. Renders nothing on mainnet.
 * - on mainnet, while the chain's head is below `LAUNCH_HEIGHT`: when the
 *   registry opens, in the reader's own time zone. One `getBlockNumber` per
 *   page load — no timer, no polling — and it renders nothing once the
 *   height has passed or when no node is configured.
 */

import { useEffect, useState } from 'react'
import { Hint } from './Hint'
import { defaultTransport } from '../lib/history'
import {
  blocksToLaunch,
  eraNoticeHint,
  eraNoticeLine,
  eraTag,
  isCompressedEra,
  launchNoticeHint,
  launchNoticeLine,
  launchTag,
} from '../lib/wording'

export function EraNotice() {
  const [head, setHead] = useState<number | null>(null)
  const era = isCompressedEra()

  useEffect(() => {
    if (era) return
    const transport = defaultTransport()
    if (transport === null) return
    let live = true
    transport('getBlockNumber', [])
      .then((answer) => {
        if (live && typeof answer === 'number') setHead(answer)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [era])

  if (era) {
    return (
      <div className="era-notice" role="note">
        <span className="badge">{eraTag()}</span>
        <span>
          {eraNoticeLine()}
          <Hint>{eraNoticeHint()}</Hint>
        </span>
      </div>
    )
  }
  if (head === null || blocksToLaunch(head) === 0) return null
  return (
    <div className="era-notice" role="note">
      <span className="badge">{launchTag()}</span>
      <span>
        {launchNoticeLine(head, Date.now())}
        <Hint>{launchNoticeHint()}</Hint>
      </span>
    </div>
  )
}
