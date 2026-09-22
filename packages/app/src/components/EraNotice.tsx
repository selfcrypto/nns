/**
 * One strip under the masthead, on every screen. Two notices share it, and
 * both are derived rather than configured, so neither can be forgotten or
 * left on:
 *
 * - on a compressed-tempo era (`isCompressedEra`, wording.ts): the tag and
 *   the line saying none of this is real. Renders nothing on mainnet.
 * - on mainnet, while `blocksToLaunch` (App, `useBlocksToLaunch`) is
 *   positive: when the registry opens, in the reader's own time zone. Gone
 *   once the height has passed.
 */

import { Hint } from './Hint'
import { eraNoticeHint, eraNoticeLine, eraTag, isCompressedEra, launchNoticeHint, launchNoticeLine, launchTag } from '../lib/wording'

export function EraNotice({ blocksToLaunch }: { blocksToLaunch: number | null }) {
  if (isCompressedEra()) {
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
  if (blocksToLaunch === null || blocksToLaunch === 0) return null
  return (
    <div className="era-notice" role="note">
      <span className="badge">{launchTag()}</span>
      <span>
        {launchNoticeLine(blocksToLaunch, Date.now())}
        <Hint>{launchNoticeHint()}</Hint>
      </span>
    </div>
  )
}
