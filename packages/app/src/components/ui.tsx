import { useEffect, useState } from 'react'
import { NNS_NAME_CLASS } from '@nns/resolver'
import Identicons from '@nimiq/identicons/dist/identicons.bundle.min.js'
import type { ReactNode } from 'react'
import type { Tone } from '../lib/wording'

/** Every name and label renders through this — §4.3 CSS via @nns/resolver. */
export function NameText({ children }: { children: ReactNode }) {
  return <span className={NNS_NAME_CLASS}>{children}</span>
}

/**
 * The Nimiq identicon of an address — a picture of what will actually be
 * paid (§4.3), so it renders beside every address a user might pay.
 */
export function Identicon({ address, size = 40 }: { address: string; size?: number }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setUrl(null)
    Identicons.toDataUrl(address).then((dataUrl) => {
      if (!cancelled) setUrl(dataUrl)
    })
    return () => {
      cancelled = true
    }
  }, [address])
  return url === null ? (
    <span className="identicon identicon-blank" style={{ width: size, height: size }} aria-hidden />
  ) : (
    <img className="identicon" src={url} width={size} height={size} alt="" />
  )
}

export type BadgeTone = Tone | 'proven' | 'delegated' | 'grace'

export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>
}

/** The signature element: every result card carries a proof rail whose edge encodes the tier. */
export type RailTier = 'proven' | 'depth' | 'delegated' | 'alarm' | 'plain'

export function RailCard({ tier, children }: { tier: RailTier; children: ReactNode }) {
  return <section className={`card rail rail-${tier}`}>{children}</section>
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      <p className="empty-body">{body}</p>
    </div>
  )
}

export function Spinner() {
  return (
    <div className="spinner" role="status" aria-label="Loading">
      <span />
    </div>
  )
}
