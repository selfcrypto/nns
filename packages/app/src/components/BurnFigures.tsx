import { getBurn } from '../lib/api'
import { lunaToNim } from '../lib/format'
import { apiBase } from '../lib/nns'
import { useAsync } from '../lib/useAsync'
import {
  burnBurnedLabel,
  burnEvenLine,
  burnExplainer,
  burnOwedLabel,
  burnShortfallLine,
  burnSurplusLine,
  burnTitle,
} from '../lib/wording'
import { Hint } from './Hint'

/**
 * §10.2's burn record, both halves — burned means nothing without owed, so
 * both quantities are shown. The landing page
 * has its own rendering in `LANDING`'s voice; this one is for the app path,
 * which Nimiq Pay opens on and which never sees the landing page. It sits on
 * Market, where the registry's money is discussed. Quiet when the API does
 * not answer, because an unreachable record must not read as a broken promise.
 */
export function BurnFigures() {
  const burn = useAsync(() => getBurn(apiBase()), [])
  if (burn.status !== 'done') return null
  const { burned, owed } = burn.value
  const gap = owed - burned
  return (
    <section className="burn-figures">
      <h3 className="burn-title">
        {burnTitle()}
        <Hint>{burnExplainer()}</Hint>
      </h3>
      <p className="burn-row">
        <span>{burnBurnedLabel()}</span>
        <span className="burn-amount">{lunaToNim(burned)} NIM</span>
      </p>
      <p className="burn-row">
        <span>{burnOwedLabel()}</span>
        <span className="burn-amount">{lunaToNim(owed)} NIM</span>
      </p>
      <p className="burn-row">{gap > 0n ? burnShortfallLine(lunaToNim(gap)) : gap < 0n ? burnSurplusLine(lunaToNim(-gap)) : burnEvenLine()}</p>
    </section>
  )
}
