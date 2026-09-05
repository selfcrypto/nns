/**
 * A "?" beside a line, and the explanation behind it — hover on a desktop,
 * tap on a phone, where there is no hover. It exists so a card can state a
 * fact in one line and keep the paragraph that justifies it one gesture away
 * instead of on screen (Kike, 2026-09-04: "a lot of text everywhere").
 *
 * The popover is `position: fixed` and placed by measurement: centred under
 * the button, clamped to the viewport's width, and flipped above the button
 * when there is no room below. Nothing about the frame's geometry (app.css,
 * `.frame`) is involved — this is an overlay a few lines tall, not the layout.
 * It closes on scroll, resize and Escape, and a tap-opened one also gets a
 * scrim, the same device the identity panel uses, so the next tap anywhere
 * closes it rather than acting through it. A hover-opened one has no scrim:
 * the pointer leaving the button is its close.
 *
 * What goes behind a hint is explanation only. A line the states doc says
 * must be visible — the verified count and its resolver list, the alarm
 * bodies, the custodial warning before a `B`, the chat notice — stays on the
 * card; the hint carries the *why* beside it.
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { hintLabel } from '../lib/wording'

type Opened = 'tap' | 'hover'

const MARGIN = 12
const GAP = 8
const MAX_WIDTH = 320

export function Hint({ children, label }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState<Opened | null>(null)
  const [placed, setPlaced] = useState<CSSProperties | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    if (open === null) {
      setPlaced(null)
      return
    }
    const anchor = button.current?.getBoundingClientRect()
    const height = pop.current?.offsetHeight ?? 0
    if (anchor === undefined) return
    const width = Math.min(MAX_WIDTH, window.innerWidth - MARGIN * 2)
    const centred = anchor.left + anchor.width / 2 - width / 2
    const left = Math.max(MARGIN, Math.min(centred, window.innerWidth - MARGIN - width))
    const below = anchor.bottom + GAP
    const fitsBelow = below + height <= window.innerHeight - MARGIN
    const top = fitsBelow ? below : Math.max(MARGIN, anchor.top - GAP - height)
    setPlaced({ left, top, width })
  }, [open])

  useEffect(() => {
    if (open === null) return
    const close = () => setOpen(null)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('scroll', close, { passive: true, capture: true })
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', close, { capture: true })
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <span className="hint">
      <button
        ref={button}
        type="button"
        className="hint-btn"
        aria-label={label ?? hintLabel()}
        aria-expanded={open !== null}
        onClick={() => setOpen(open === 'tap' ? null : 'tap')}
        onPointerEnter={(event) => {
          if (event.pointerType === 'mouse' && open === null) setOpen('hover')
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === 'mouse' && open === 'hover') setOpen(null)
        }}
      >
        ?
      </button>
      {open === 'tap' && <button type="button" className="hint-scrim" aria-label="Close" onClick={() => setOpen(null)} />}
      {open !== null && (
        <span
          ref={pop}
          role="tooltip"
          className="hint-pop"
          // Measured on the first paint, then placed; hidden until then so the
          // unplaced frame never flashes at the viewport's corner.
          style={placed ?? { left: 0, top: 0, width: Math.min(MAX_WIDTH, window.innerWidth - MARGIN * 2), visibility: 'hidden' }}
        >
          {children}
        </span>
      )}
    </span>
  )
}
