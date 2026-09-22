/**
 * §10.1 as a table: one row per open band, a year and a lifetime each, off
 * the live `/params.fees` so a governance change reprices it by itself. A
 * reader deciding what to search for wants the price before the name, and
 * the sheet's "?" sentence only appears once a name is chosen (Rico,
 * 2026-09-22). `PriceDisclosure` below is how both screens show it.
 */

import { useId, useState } from 'react'
import { getParams, type FeeRow } from '../lib/api'
import { apiBase } from '../lib/nns'
import { lunaToNim } from '../lib/format'
import { priceBands } from '../lib/states'
import { useAsync } from '../lib/useAsync'
import { LANDING, PRICE_TABLE, fromPriceLine, lengthBandLabel, nimAmountLine } from '../lib/wording'
import { ChevronIcon } from './icons'

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
 * One row — "Prices", the cheapest band, a chevron — that opens into the
 * table, the way a proven answer's foot opens into its resolvers
 * (`result.tsx`). On the landing page and on Buy before a query: a whole
 * section, or the open table, was too much page for a fact a reader wants
 * once (Rico, 2026-09-22, twice). The row is there before `/params` answers
 * so the page does not jump; the figure joins it and the toggle enables.
 */
export function PriceDisclosure() {
  const params = useAsync(() => getParams(apiBase()), [])
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const fees = params.status === 'done' ? params.value.fees : null
  const cheapest = fees === null ? null : (priceBands(fees).at(-1)?.yearly ?? null)
  return (
    <div className="prices-card">
      <button type="button" className="prices-toggle" aria-expanded={open} aria-controls={bodyId} disabled={fees === null} onClick={() => setOpen(!open)}>
        <span className="prices-toggle-title">{LANDING.prices.title}</span>
        {cheapest !== null && <span className="prices-toggle-from">{fromPriceLine(lunaToNim(cheapest))}</span>}
        <ChevronIcon />
      </button>
      {open && fees !== null && (
        <div className="prices-body" id={bodyId}>
          <PriceTable fees={fees} />
        </div>
      )}
    </div>
  )
}
