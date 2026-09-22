/**
 * The notifications sheet for one address (tasks/26): sign in with the
 * address, then the contacts, the four toggles and the delete row.
 *
 * `MessageModal`'s shell, no transaction anywhere. The address is the
 * subject: a Pay wallet chooses which of its addresses signs, so a signature
 * from another member of the set is shown as such, with the address it came
 * from, rather than silently signing that one in.
 */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { type CopyOutcome, writeClipboard } from '../lib/clipboard'
import { ellipsizeAddress } from '../lib/format'
import {
  addEmail,
  deleteEverything,
  getSettings,
  loadSession,
  NotifyError,
  putPreferences,
  removeContact,
  saveSession,
  signIn,
  signOut,
  telegramLink,
  type Contact,
  type NotifySettings,
  type Preferences,
} from '../lib/notify'
import { CATEGORIES } from '../lib/notifyKinds'
import type { Wallet } from '../lib/wallet'
import {
  closeLabel,
  copyLinkLabel,
  NOTIFY_CATEGORY_HINT,
  NOTIFY_CATEGORY_LABEL,
  notifyConfirmedLabel,
  notifyContactsLabel,
  notifyDataHint,
  notifyDeclinedLine,
  notifyDeleteConfirmLabel,
  notifyDeleteHint,
  notifyDeleteLabel,
  notifyEmailAddLabel,
  notifyEmailBadLine,
  notifyEmailLabel,
  notifyEmailLimitLine,
  notifyEmailPlaceholder,
  notifyEmailSentLine,
  notifyEventsLabel,
  notifyFailedLine,
  notifyLoadingLine,
  notifyMismatchLine,
  notifyNoChannelsLine,
  notifyPendingLabel,
  notifyRemoveLabel,
  notifySheetIntro,
  notifySheetTitle,
  notifySignInHint,
  notifySignInLabel,
  notifySignOutLabel,
  notifySigningLine,
  notifyTelegramConnectLabel,
  notifyTelegramHint,
  notifyTelegramLabel,
  notifyTelegramLinkedLabel,
  notifyTelegramOpenLabel,
  notifyTelegramOpenLine,
  notifyUnreachableLine,
  notifyUnsupportedLine,
  shareCopiedLine,
  shareCopyFailedLine,
} from '../lib/wording'
import { Hint } from './Hint'
import { Spinner } from './ui'

type View =
  | { kind: 'loading' }
  | { kind: 'signed-out'; note: string | null; busy: boolean }
  | { kind: 'signed-in'; token: string; settings: NotifySettings }
  | { kind: 'unreachable' }

export function NotifySheet({ base, address, wallet, onClose }: { base: string; address: string; wallet: Wallet | null; onClose: () => void }) {
  const storage = window.localStorage
  const [view, setView] = useState<View>({ kind: 'loading' })
  const [email, setEmail] = useState('')
  const [emailNote, setEmailNote] = useState<string | null>(null)
  const [emailBusy, setEmailBusy] = useState(false)
  const [link, setLink] = useState<string | null>(null)
  const [copied, setCopied] = useState<CopyOutcome | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (copied === null) return
    const timer = setTimeout(() => setCopied(null), 2_500)
    return () => clearTimeout(timer)
  }, [copied])

  // On opening: a stored session is tried, and a gone one is the signed-out state.
  useEffect(() => {
    let cancelled = false
    const token = loadSession(storage, address)
    if (token === null) {
      setView({ kind: 'signed-out', note: null, busy: false })
      return
    }
    getSettings(base, token)
      .then((settings) => {
        if (cancelled) return
        if (settings === null) {
          saveSession(storage, address, null)
          setView({ kind: 'signed-out', note: null, busy: false })
        } else setView({ kind: 'signed-in', token, settings })
      })
      .catch(() => {
        if (!cancelled) setView({ kind: 'unreachable' })
      })
    return () => {
      cancelled = true
    }
  }, [base, address, storage])

  const start = async () => {
    setView({ kind: 'signed-out', note: null, busy: true })
    const outcome = await signIn(base, address, wallet?.sign ?? null)
    if (outcome.ok) {
      saveSession(storage, address, outcome.token)
      try {
        const settings = await getSettings(base, outcome.token)
        if (settings === null) setView({ kind: 'signed-out', note: null, busy: false })
        else setView({ kind: 'signed-in', token: outcome.token, settings })
      } catch {
        setView({ kind: 'unreachable' })
      }
      return
    }
    const note =
      outcome.reason === 'declined'
        ? notifyDeclinedLine()
        : outcome.reason === 'unsupported'
          ? notifyUnsupportedLine()
          : outcome.reason === 'mismatch'
            ? notifyMismatchLine(ellipsizeAddress(outcome.signer))
            : outcome.reason === 'failed'
              ? notifyFailedLine(outcome.detail)
              : notifyUnreachableLine()
    setView({ kind: 'signed-out', note, busy: false })
  }

  const withSession = async (work: (token: string) => Promise<NotifySettings | void>) => {
    if (view.kind !== 'signed-in') return
    try {
      const next = await work(view.token)
      if (next !== undefined) setView({ kind: 'signed-in', token: view.token, settings: next })
    } catch (error) {
      if (error instanceof NotifyError && error.status === 401) {
        saveSession(storage, address, null)
        setView({ kind: 'signed-out', note: null, busy: false })
      } else if (error instanceof NotifyError && error.status === 0) setView({ kind: 'unreachable' })
      else throw error
    }
  }

  const toggle = (category: keyof Preferences) =>
    void withSession(async (token) => {
      if (view.kind !== 'signed-in') return
      return putPreferences(base, token, { ...view.settings.preferences, [category]: !view.settings.preferences[category] })
    })

  const submitEmail = async () => {
    if (view.kind !== 'signed-in') return
    setEmailBusy(true)
    setEmailNote(null)
    try {
      const contact = await addEmail(base, view.token, email.trim())
      setEmail('')
      setEmailNote(contact.confirmed ? null : notifyEmailSentLine())
      const settings = await getSettings(base, view.token)
      if (settings !== null) setView({ kind: 'signed-in', token: view.token, settings })
    } catch (error) {
      if (error instanceof NotifyError && error.code === 'BAD_EMAIL') setEmailNote(notifyEmailBadLine())
      else if (error instanceof NotifyError && error.status === 429) setEmailNote(notifyEmailLimitLine())
      else if (error instanceof NotifyError && error.status === 401) {
        saveSession(storage, address, null)
        setView({ kind: 'signed-out', note: null, busy: false })
      } else setEmailNote(notifyUnreachableLine())
    } finally {
      setEmailBusy(false)
    }
  }

  const connectTelegram = () =>
    void withSession(async (token) => {
      const url = await telegramLink(base, token)
      setLink(url)
      // The WebView may or may not hand the link to Telegram; opening it is
      // the attempt, the button under it is the fallback.
      window.open(url, '_blank', 'noopener')
    })

  const refresh = () =>
    void withSession(async (token) => {
      const settings = await getSettings(base, token)
      return settings ?? undefined
    })

  const remove = (contact: Contact) => void withSession((token) => removeContact(base, token, contact.id))

  const leave = () =>
    void withSession(async (token) => {
      await signOut(base, token)
      saveSession(storage, address, null)
      setView({ kind: 'signed-out', note: null, busy: false })
    })

  const wipe = () =>
    void withSession(async (token) => {
      await deleteEverything(base, token)
      saveSession(storage, address, null)
      setConfirmDelete(false)
      setView({ kind: 'signed-out', note: null, busy: false })
    })

  const copy = () => {
    if (link !== null) void writeClipboard(link).then(setCopied)
  }

  if (typeof document === 'undefined') return null

  const body = () => {
    switch (view.kind) {
      case 'loading':
        return (
          <div className="sheet-loading">
            <Spinner />
            <span>{notifyLoadingLine()}</span>
          </div>
        )
      case 'unreachable':
        return <p className="notify-note notify-note-warn">{notifyUnreachableLine()}</p>
      case 'signed-out':
        return (
          <div className="notify-signin">
            <button type="button" className="modal-btn-send" disabled={view.busy} onClick={() => void start()}>
              {view.busy ? notifySigningLine() : notifySignInLabel()}
            </button>
            <p className="notify-note">
              <Hint>{notifySignInHint()}</Hint>
            </p>
            {view.note !== null && <p className="notify-note notify-note-warn">{view.note}</p>}
          </div>
        )
      case 'signed-in': {
        const { settings } = view
        const emails = settings.contacts.filter((contact) => contact.channel === 'email')
        const telegrams = settings.contacts.filter((contact) => contact.channel === 'telegram')
        const noChannels = !settings.channels.email && !settings.channels.telegram
        return (
          <>
            <section className="notify-section">
              <h4 className="notify-heading">
                {notifyContactsLabel()} <Hint>{notifyDataHint()}</Hint>
              </h4>
              {noChannels && <p className="notify-note">{notifyNoChannelsLine()}</p>}
              {settings.channels.email && (
                <div className="notify-channel">
                  <span className="request-field-label">{notifyEmailLabel()}</span>
                  {emails.map((contact) => (
                    <div key={contact.id} className="notify-contact">
                      <span className="notify-contact-target">{contact.target}</span>
                      <span className={contact.confirmed ? 'notify-state notify-state-ok' : 'notify-state'}>
                        {contact.confirmed ? notifyConfirmedLabel() : notifyPendingLabel()}
                      </span>
                      <button type="button" className="notify-remove" onClick={() => remove(contact)}>
                        {notifyRemoveLabel()}
                      </button>
                    </div>
                  ))}
                  <form
                    className="notify-email-form"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void submitEmail()
                    }}
                  >
                    <input
                      className="modal-input"
                      type="email"
                      inputMode="email"
                      autoComplete="email"
                      placeholder={notifyEmailPlaceholder()}
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                    />
                    <button type="submit" className="connect connect-quiet" disabled={emailBusy || email.trim() === ''}>
                      {notifyEmailAddLabel()}
                    </button>
                  </form>
                  {emailNote !== null && <p className="notify-note">{emailNote}</p>}
                </div>
              )}
              {settings.channels.telegram && (
                <div className="notify-channel">
                  <span className="request-field-label">
                    {notifyTelegramLabel()} <Hint>{notifyTelegramHint()}</Hint>
                  </span>
                  {telegrams.map((contact) => (
                    <div key={contact.id} className="notify-contact">
                      <span className="notify-contact-target">{notifyTelegramLabel()}</span>
                      <span className="notify-state notify-state-ok">{notifyTelegramLinkedLabel()}</span>
                      <button type="button" className="notify-remove" onClick={() => remove(contact)}>
                        {notifyRemoveLabel()}
                      </button>
                    </div>
                  ))}
                  {link === null ? (
                    <button type="button" className="connect connect-quiet" onClick={connectTelegram}>
                      {notifyTelegramConnectLabel()}
                    </button>
                  ) : (
                    <div className="notify-link">
                      <p className="notify-note">{notifyTelegramOpenLine()}</p>
                      <div className="notify-link-actions">
                        <a className="connect connect-quiet" href={link} target="_blank" rel="noopener noreferrer" onClick={() => setTimeout(refresh, 4_000)}>
                          {notifyTelegramOpenLabel()}
                        </a>
                        <button type="button" className="connect connect-quiet" onClick={copy}>
                          {copyLinkLabel()}
                        </button>
                      </div>
                      {copied === 'ok' && <p className="notify-note">{shareCopiedLine()}</p>}
                      {copied === 'failed' && <p className="notify-note">{shareCopyFailedLine(link)}</p>}
                    </div>
                  )}
                </div>
              )}
            </section>

            <section className="notify-section">
              <h4 className="notify-heading">{notifyEventsLabel()}</h4>
              {CATEGORIES.map((category) => (
                <label key={category} className="sheet-check notify-toggle">
                  <input type="checkbox" checked={settings.preferences[category]} onChange={() => toggle(category)} />
                  <span>
                    {NOTIFY_CATEGORY_LABEL[category]} <Hint>{NOTIFY_CATEGORY_HINT[category]}</Hint>
                  </span>
                </label>
              ))}
            </section>

            <section className="notify-section notify-foot">
              <button type="button" className="connect connect-quiet" onClick={leave}>
                {notifySignOutLabel()}
              </button>
              {confirmDelete ? (
                <button type="button" className="notify-danger" onClick={wipe}>
                  {notifyDeleteConfirmLabel()}
                </button>
              ) : (
                <span className="notify-delete-row">
                  <button type="button" className="notify-danger-quiet" onClick={() => setConfirmDelete(true)}>
                    {notifyDeleteLabel()}
                  </button>
                  <Hint>{notifyDeleteHint()}</Hint>
                </span>
              )}
            </section>
          </>
        )
      }
    }
  }

  return createPortal(
    <>
      <div className="modal-scrim" onClick={onClose} aria-hidden="true" />
      <div className="modal-container notify-sheet" role="dialog" aria-modal="true" aria-labelledby="notify-modal-title">
        <div className="modal-handle" aria-hidden="true" />
        <div className="modal-header">
          <div className="modal-header-left">
            <div className="modal-icon-badge" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
            </div>
            <div className="modal-header-text">
              <h3 id="notify-modal-title" className="modal-title">{notifySheetTitle()}</h3>
              <p className="modal-subtitle nns-name">{notifySheetIntro(ellipsizeAddress(address))}</p>
            </div>
          </div>
          <button type="button" className="modal-close-btn" onClick={onClose} aria-label={closeLabel()}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="notify-body">{body()}</div>
      </div>
    </>,
    document.body,
  )
}
