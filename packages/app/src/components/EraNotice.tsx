/**
 * One strip under the masthead, on every screen: the chain's numbers, and —
 * while the bundle is built on a compressed-tempo era — the tag and the
 * warning a tester is owed.
 *
 * The two halves have different lifetimes on purpose. The **era half** is the
 * constants' decision (`isCompressedEra`, wording.ts): a mainnet build cannot
 * show it and an era build cannot forget it. The **chain half** renders
 * always, mainnet included, because the head and the registry's height are
 * facts about the deployment rather than about the era — which is what lets
 * this component survive losing its beta wording at launch instead of taking
 * the readout down with it (Kike, 2026-09-16).
 *
 * The readout earns its space by explaining the app's one unavoidable wait.
 * The registry only counts finalised blocks, so it trails the head and
 * catches up a batch at a time; a person watching a send can see the distance
 * close instead of watching a spinner and guessing. Nothing here claims a
 * transaction succeeded — these are two heights, and the gap between them.
 */

import { Hint } from './Hint'
import { ChainIcon, LayersIcon } from './icons'
import { registryLag, useChainHeight, useRegistryHeight } from '../lib/chain'
import {
  chainHeightLabel,
  chainReadoutHint,
  eraNoticeHint,
  eraNoticeLine,
  eraTag,
  isCompressedEra,
  registryHeightLabel,
  registryLagLine,
} from '../lib/wording'

const groups = (height: number): string => height.toLocaleString('en-US')

export function EraNotice() {
  const head = useChainHeight()
  const registry = useRegistryHeight()
  const era = isCompressedEra()
  const lag = registryLag(head, registry)

  // Nothing to say: a mainnet build whose RPC and API have both stayed silent
  // would otherwise render an empty bar under the masthead.
  if (!era && head === null && registry === null) return null

  // Without the era half this strip is permanent chrome, and it must not wear
  // the amber: in this app that colour means "a test era", and a readout that
  // borrows it would warn about the deployment on every mainnet screen.
  return (
    <div className={era ? 'era-notice' : 'era-notice is-chain-only'} role="note">
      {era && <span className="badge">{eraTag()}</span>}
      {era && (
        <span>
          {eraNoticeLine()}
          <Hint>{eraNoticeHint()}</Hint>
        </span>
      )}
      {(head !== null || registry !== null) && (
        <span className="chain-readout">
          {head !== null && (
            <span className="chain-figure" title={chainHeightLabel()}>
              <ChainIcon />
              {/* `tabular-nums` in the stylesheet: a height that reflows every
                  second would drag the strip's whole layout with it. */}
              <span className="chain-height">{groups(head)}</span>
            </span>
          )}
          {registry !== null && (
            <span className="chain-figure" title={registryHeightLabel()}>
              <LayersIcon />
              <span className="chain-height">{groups(registry)}</span>
              {lag !== null && <span className="chain-lag">{registryLagLine(lag)}</span>}
            </span>
          )}
          <Hint>{chainReadoutHint()}</Hint>
        </span>
      )}
    </div>
  )
}
