/**
 * One strip under the masthead, on every screen, whenever the bundle was
 * built on a compressed-tempo era (`isCompressedEra`, wording.ts): the tag,
 * the two clocks a tester is about to be quoted, and a hint with the why.
 * Renders nothing on mainnet — the decision is the constants', so a
 * mainnet build cannot show it and an era build cannot forget it.
 */

import { Hint } from './Hint'
import { eraNoticeHint, eraNoticeLine, eraTag, isCompressedEra } from '../lib/wording'

export function EraNotice() {
  if (!isCompressedEra()) return null
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
