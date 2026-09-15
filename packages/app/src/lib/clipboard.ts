/**
 * The clipboard, both directions: the paste button beside a search field
 * reads it, and everything that offers a copy writes through here.
 *
 * Both of the app's links — a referral link (`referral.ts`) and a payment
 * link (`payRequest.ts`) — do their work by being **pasted into a field**,
 * which inside Nimiq Pay's WebView is a long-press on a box a thumb is
 * already covering. The button makes it a tap.
 *
 * Best-effort, like every other host capability here: `readText` may not
 * exist at all (Firefox gives it to extensions only, and a WebView may ship
 * without it), and where it exists the host may refuse it — a WebView
 * answers the permission prompt on the page's behalf and can say no without
 * asking anyone. So the three outcomes are a value, not an exception, and
 * the caller shows a note rather than swallowing a refusal: a button that
 * silently does nothing is the failure this exists to avoid.
 */

export interface ClipboardLike {
  readText(): Promise<string>
}

export type PasteOutcome =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'refused' }

/**
 * The host's clipboard, or `null` where it cannot be read. `null` is what
 * hides the button — an offer that cannot be honoured is worse than none.
 */
export function clipboardReader(): ClipboardLike | null {
  const clipboard = globalThis.navigator?.clipboard
  return typeof clipboard?.readText === 'function' ? clipboard : null
}

export async function readClipboard(source: ClipboardLike | null): Promise<PasteOutcome> {
  if (source === null) return { kind: 'refused' }
  let text: string
  try {
    text = await source.readText()
  } catch {
    return { kind: 'refused' }
  }
  return typeof text === 'string' && text.trim() !== '' ? { kind: 'text', text } : { kind: 'empty' }
}


/** A copy either reached the clipboard or it did not. There is no third case to show. */
export type CopyOutcome = 'ok' | 'failed'

export interface ClipboardWriter {
  writeText(text: string): Promise<void>
}

/** The host's clipboard, or `null` where it cannot be written. */
export function clipboardWriter(): ClipboardWriter | null {
  const clipboard = globalThis.navigator?.clipboard
  return typeof clipboard?.writeText === 'function' ? clipboard : null
}

/**
 * Copy, through whichever of the two mechanisms this host has.
 *
 * Writing is not the mirror of reading: a page may write the clipboard from a
 * user gesture without asking anyone, which is why this returns `'ok'` far
 * more often than `readClipboard` returns text. What it does share is that
 * `navigator.clipboard` may simply be absent — a WebView can ship without it,
 * and Pay's is the host this app was built for. `document.execCommand('copy')`
 * is deprecated and still the only thing that works there, so a missing or
 * throwing `writeText` falls through to a hidden textarea rather than
 * reporting a failure the host could have honoured. Every copy in the app
 * went through its own `navigator.clipboard.writeText`, and only the Inbox's
 * had the fallback, so copying a referral or payment link failed silently on
 * exactly the wallet the links are for (2026-09-16).
 *
 * Call it from a click handler. Both mechanisms require the gesture.
 */
export async function writeClipboard(text: string, target: ClipboardWriter | null = clipboardWriter()): Promise<CopyOutcome> {
  if (target !== null) {
    try {
      await target.writeText(text)
      return 'ok'
    } catch {
      // Fall through: a refusal from one mechanism says nothing about the other.
    }
  }
  return copyByTextarea(text)
}

function copyByTextarea(text: string): CopyOutcome {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return 'failed'
  const textarea = document.createElement('textarea')
  textarea.value = text
  // Fixed and transparent, so the selection never scrolls the page under a
  // thumb or flashes a box where the address was.
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  try {
    textarea.focus()
    textarea.select()
    return document.execCommand('copy') ? 'ok' : 'failed'
  } catch {
    return 'failed'
  } finally {
    document.body.removeChild(textarea)
  }
}
