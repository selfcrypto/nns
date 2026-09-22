/**
 * §10.1 as a table: one row per open band, a year and a lifetime each, off
 * the live `/params.fees` so a governance change reprices it by itself. The
 * landing page and Buy's idle state both show it — a reader deciding what to
 * search for wants the price before the name, and the sheet's "?" sentence
 * only appears once a name is chosen (Rico, 2026-09-22).
 */

import { getParams, type FeeRow } from '../lib/api'
import { apiBase } from '../lib/nns'
import { lunaToNim } from '../lib/format'
import { priceBands } from '../lib/states'
import { useAsync } from '../lib/useAsync'
import { PRICE_TABLE, lengthBandLabel, nimAmountLine } from '../lib/wording'

const PRICES_DOC = '#/docs/prices'

export function PriceTable({ fees }: { fees: readonly FeeRow[] }) {
  return (
    <div className="price-table">
      <table>
        <thead>
          <tr>
            <th scope="col">{PRICE_TABLE.length}</th>
            <th scope="col">{PRICE_TABLE.year}</th>
            <th scope="col">{PRICE_TABLE.lifetime}</th>
          </tr>
        </thead>
        <tbody>
          {priceBands(fees).map((band) => (
            <tr key={band.from}>
              <th scope="row">{lengthBandLabel(band.from, band.to)}</th>
              <td>{nimAmountLine(lunaToNim(band.yearly))}</td>
              <td>{nimAmountLine(lunaToNim(band.lifetime))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="price-table-foot">
        {PRICE_TABLE.reserved} <a href={PRICES_DOC}>{PRICE_TABLE.more}</a>
      </p>
    </div>
  )
}

/**
 * The table off the live `/params`. Nothing while it loads or if it fails:
 * display-only, and the docs page states the same prices for a reader who
 * arrives while the API is down.
 */
export function LivePriceTable() {
  const params = useAsync(() => getParams(apiBase()), [])
  return params.status === 'done' ? <PriceTable fees={params.value.fees} /> : null
}
