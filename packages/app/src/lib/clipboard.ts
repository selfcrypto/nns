/**
 * Reading the clipboard, for the paste button beside a search field.
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
