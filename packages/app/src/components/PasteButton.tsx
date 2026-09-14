/**
 * The **Paste** button inside a search field.
 *
 * A referral link and a payment link both reach the app by being pasted into
 * a box (`lib/clipboard.ts` says why that is the only route a reader inside
 * Nimiq Pay has). One component for all three boxes — Home's, Buy's and
 * Pay's — because three copies is three that drift; its styling is global
 * `.paste-btn` in `app.css` for the same reason `.trust-*` is.
 *
 * It renders nothing where the clipboard cannot be read, and a refusal is a
 * note rather than nothing happening.
 */

import { useMemo } from 'react'
import { clipboardReader, readClipboard } from '../lib/clipboard'
import { pasteEmptyLine, pasteLabel, pasteRefusedLine } from '../lib/wording'

export function PasteButton({
  onPaste,
  onNote,
  className,
}: {
  /** The clipboard's text, handed over exactly as a keystroke would be. */
  onPaste: (text: string) => void
  /** The line to show when there was nothing to paste, or `null` to clear it. */
  onNote: (line: string | null) => void
  className?: string | undefined
}) {
  const clipboard = useMemo(() => clipboardReader(), [])
  if (clipboard === null) return null

  return (
    <button
      type="button"
      className={`paste-btn${className === undefined ? '' : ` ${className}`}`}
      title={pasteLabel()}
      aria-label={pasteLabel()}
      onClick={() => {
        onNote(null)
        void readClipboard(clipboard).then((outcome) => {
          if (outcome.kind === 'text') onPaste(outcome.text.trim())
          else onNote(outcome.kind === 'empty' ? pasteEmptyLine() : pasteRefusedLine())
        })
      }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="8" y="2" width="8" height="4" rx="1" />
        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      </svg>
    </button>
  )
}
