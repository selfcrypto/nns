import type { SendPhase } from '../lib/send'
import { sendConfirmingLine, sendSubmittingLine } from '../lib/wording'

/**
 * What a send is waiting for, in one shape everywhere it waits (Kike,
 * 2026-09-15: *"the waiting message isn't the same for every card using
 * it"*). Pay had a tinted banner with a spinner; the action sheet and the
 * chat composer had a plain grey note and a button that said "Confirming…"
 * with nothing moving. Three surfaces waiting on one macro block should not
 * look like three different states of the app.
 *
 * The spinner is the whole animation: the wait is a batch closing, so there
 * is no progress to draw, only evidence that the app is still looking.
 */
export function SendProgress({ progress }: { progress: SendPhase | 'idle' }) {
  if (progress === 'idle') return null
  return (
    <p className="send-status">
      <span className="send-status-spinner" aria-hidden="true" />
      <span>{progress === 'submitting' ? sendSubmittingLine() : sendConfirmingLine()}</span>
    </p>
  )
}

/** The same spinner inside a button that is mid-send, beside its label. */
export function ButtonSpinner() {
  return <span className="btn-spinner" aria-hidden="true" />
}
