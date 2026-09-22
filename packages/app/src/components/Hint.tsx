/**
 * A "?" beside a line, and the explanation behind it — hover on a desktop,
 * tap on a phone, where there is no hover. It exists so a card can state a
 * fact in one line and keep the paragraph that justifies it one gesture away
 * instead of on screen (Rico, 2026-09-04: "a lot of text everywhere").
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
 * must be visible — the verified count, the alarm bodies, the custodial
 * warning before a `B`, the chat notice — stays on the card; the hint carries
 * the *why* beside it. The resolver list under the count is the one fact kept
 * folded, and by a disclosure of its own (result.tsx), not by a hint: it is
 * evidence, and evidence is read on demand.
 *
 * `glyph="i"` is the one variant, and it is not a second `?`. The difference
 * is positional, so no line has to be judged: the `?` explains a line on a
 * card, and the blue `(i)` is the **action sheet's** bubble, on the custody
 * disclosure (§8.5 #10) and on the review. A sheet is where a person commits
 * to something, and its lines are already down to the amount, the address and
 * the date, with every rule behind that one bubble. What the spec requires to
 * be visible stays visible in both: the custodial line and its checkbox are
 * beside the `(i)`, not behind it.
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { hintLabel } from '../lib/wording'

type Opened = 'tap' | 'hover'

const MARGIN = 12
const GAP = 8
const MAX_WIDTH = 320

export function Hint({ children, label, glyph = '?' }: { children: ReactNode; label?: string; glyph?: '?' | 'i' }) {
  const [open, setOpen] = useState<Opened | null>(null)
  const [placed, setPlaced] = useState<CSSProperties | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLSpanElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = () => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }

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
      clearTimer()
    }
  }, [open])

  const handlePointerEnter = (event: React.PointerEvent) => {
    if (event.pointerType === 'mouse') {
      clearTimer()
      if (open === null) setOpen('hover')
    }
  }

  const handlePointerLeave = (event: React.PointerEvent) => {
    if (event.pointerType === 'mouse') {
      clearTimer()
      closeTimer.current = setTimeout(() => {
        setOpen((prev) => (prev === 'hover' ? null : prev))
      }, 120)
    }
  }

  return (
    <span className="hint">
      <button
        ref={button}
        type="button"
        className={glyph === 'i' ? 'hint-btn hint-btn-info' : 'hint-btn'}
        aria-label={label ?? hintLabel()}
        aria-expanded={open !== null}
        onClick={() => {
          clearTimer()
          setOpen(open === 'tap' ? null : 'tap')
        }}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      >
        {glyph}
      </button>
      {typeof document !== 'undefined' &&
        open !== null &&
        createPortal(
          <>
            {open === 'tap' && <button type="button" className="hint-scrim" aria-label="Close" onClick={() => setOpen(null)} />}
            <span
              ref={pop}
              role="tooltip"
              className="hint-pop"
              onPointerEnter={handlePointerEnter}
              onPointerLeave={handlePointerLeave}
              // Measured on the first paint, then placed; hidden until then so the
              // unplaced frame never flashes at the viewport's corner.
              style={placed ?? { left: 0, top: 0, width: Math.min(MAX_WIDTH, window.innerWidth - MARGIN * 2), visibility: 'hidden' }}
            >
              {children}
            </span>
          </>,
          document.body,
        )}
    </span>
  )
}
