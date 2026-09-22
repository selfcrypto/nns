/**
 * `#/probe-sign`: tasks/26 D0, the one-time device probe of the wallet's
 * `sign()`. Signs a fixed text, verifies the result locally with `core`
 * under both conventions, and shows what came back so the answer can be
 * pasted into `docs/rpc-reference.md`. Nothing leaves the device.
 *
 * A page, not a tab: reached by typing the hash, hidden from the bar, and
 * kept after the probe because the next SDK release may change the answer.
 */

import { useState } from 'react'
import { verifySignedMessage } from '@nimiqnames/core'

import { type CopyOutcome, writeClipboard } from '../lib/clipboard'
import { primaryAddress } from '../lib/identity'
import type { Wallet } from '../lib/wallet'
import { probeCopyLabel, probeIntro, probeNoWalletLine, probeSignLabel, probeTitle, probeUnverifiedLine, probeVerifiedLine, shareCopiedLine } from '../lib/wording'

const TEXT = 'NNS signing probe. Nonce 0000000000000000. Valid until 2027-01-01T00:00:00.000Z.'

export function ProbeSignScreen({ wallet }: { wallet: Wallet | null }) {
  const [result, setResult] = useState<string | null>(null)
  const [verdict, setVerdict] = useState<string | null>(null)
  const [copied, setCopied] = useState<CopyOutcome | null>(null)
  const address = wallet === null ? null : primaryAddress(wallet.identity)

  const run = async () => {
    if (wallet === null || wallet.sign === null || address === null) return
    setResult(null)
    setVerdict(null)
    const signed = await wallet.sign(address, TEXT)
    const record: Record<string, unknown> = { host: wallet.identity.kind, address, text: TEXT, ...signed }
    if (signed.ok) {
      let verified = null
      try {
        verified = verifySignedMessage(TEXT, signed.publicKey, signed.signature)
      } catch (error) {
        record['verifyError'] = error instanceof Error ? error.message : String(error)
      }
      record['verified'] = verified
      setVerdict(verified === null ? probeUnverifiedLine() : probeVerifiedLine(verified.convention, verified.address))
    }
    setResult(JSON.stringify(record, null, 2))
  }

  return (
    <section className="panel probe-sign">
      <h2>{probeTitle()}</h2>
      <p className="notify-note">{probeIntro()}</p>
      {wallet === null || wallet.sign === null || address === null ? (
        <p className="notify-note notify-note-warn">{probeNoWalletLine()}</p>
      ) : (
        <button type="button" className="modal-btn-send" onClick={() => void run()}>
          {probeSignLabel()}
        </button>
      )}
      {verdict !== null && <p className="notify-note">{verdict}</p>}
      {result !== null && (
        <>
          <pre className="probe-result">{result}</pre>
          <button type="button" className="connect connect-quiet" onClick={() => void writeClipboard(result).then(setCopied)}>
            {copied === 'ok' ? shareCopiedLine() : probeCopyLabel()}
          </button>
        </>
      )}
    </section>
  )
}
