import { useState } from 'react'
import { CHAT_DUST_LUNA, chatByteBudget, encodeChatPayload, messageBytes } from '@nns/chat'
import { defaultTransport } from '../lib/history'
import { performSend, type SendResult } from '../lib/send'
import { sameAddress } from '../lib/states'
import type { Wallet } from '../lib/wallet'
import {
  CHAT_ENCODE_TEXT,
  GATE_REASON_TEXT,
  chatBudgetLine,
  chatOwnNameLine,
  chatPublicNotice,
  sendConfirmedLine,
  sendConfirmingLine,
  sendDeclinedLine,
  sendNoRpcLine,
  sendSubmittingLine,
  sendRejectedLine,
  sendSettlingLine,
  sendUncheckedLine,
  sendUnconfirmedLine,
} from '../lib/wording'
import { NameText } from './ui'

/**
 * The NC message composer (docs/app-chat.md). Counts UTF-8 bytes, refuses
 * everything the convention refuses, carries the public-forever notice —
 * and sends, through the one send machine, when the wallet can sign and a
 * recipient (the owner, or a thread's peer) is known. Confirmation is the
 * transaction found executed in history, keyed on the wallet's hash.
 */
export function Composer({
  name,
  recipient,
  wallet,
  sender,
  heading,
}: {
  name: string
  /** The owner's address (or the thread peer). Null when unknown — composing stays possible, sending does not. */
  recipient: string | null
  wallet: Wallet | null
  /** The signing address — the identity set's primary. */
  sender: string | null
  heading?: string
}) {
  const [text, setText] = useState('')
  const [progress, setProgress] = useState<'idle' | 'submitting' | 'confirming'>('idle')
  const [result, setResult] = useState<SendResult | null>(null)

  const ownName = recipient !== null && sender !== null && sameAddress(recipient, sender)
  if (ownName) return <p className="note note-info">{chatOwnNameLine()}</p>

  const budget = chatByteBudget(name)
  const used = messageBytes(text)
  const encoded = text === '' ? null : encodeChatPayload(name, text)
  const failure = encoded !== null && !encoded.ok ? encoded.reason : null

  const canSend =
    encoded?.ok === true && recipient !== null && sender !== null && wallet !== null && progress === 'idle'

  const send = async () => {
    if (encoded?.ok !== true || recipient === null || sender === null || wallet === null) return
    const transport = defaultTransport()
    setResult(null)
    const outcome = await performSend({
      wallet,
      transport,
      request: { sender, recipient, value: CHAT_DUST_LUNA, dataHex: encoded.dataHex },
      confirm: {
        poll: async (hash) => {
          if (hash === null || transport === null) return false
          const tx = await transport('getTransactionByHash', [hash])
          return typeof tx === 'object' && tx !== null && (tx as Record<string, unknown>)['executionResult'] === true
        },
      },
      onPhase: setProgress,
    })
    setProgress('idle')
    setResult(outcome)
    if (outcome.status === 'confirmed') setText('')
  }

  return (
    <div className="composer">
      <p className="composer-to">
        {heading ?? 'To the owner of '}
        {heading === undefined && <NameText>{name}</NameText>}
      </p>
      <textarea
        className="composer-input"
        rows={2}
        maxLength={budget}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="A short message…"
        aria-label={`Message the owner of ${name}`}
      />
      <div className="composer-meta">
        <span className={used > budget ? 'composer-count composer-over' : 'composer-count'}>
          {chatBudgetLine(used, budget)}
        </span>
        <button
          className="composer-send"
          type="button"
          disabled={!canSend}
          // The honest reason: with no wallet there is no signer — the old line
          // claimed the build could not send, which stopped being true 2026-08-21.
          title={wallet === null ? GATE_REASON_TEXT['no-viewer'] : undefined}
          onClick={() => void send()}
        >
          Send
        </button>
      </div>
      {failure !== null && failure !== 'EMPTY_MESSAGE' && <p className="field-error">{CHAT_ENCODE_TEXT[failure]}</p>}

      {progress === 'submitting' && <p className="note note-info">{sendSubmittingLine()}</p>}
      {progress === 'confirming' && <p className="note note-info">{sendConfirmingLine()}</p>}
      {result !== null && (
        <p
          className={
            result.status === 'confirmed'
              ? 'verify verify-proven'
              : result.status === 'unchecked' || result.status === 'settling'
                ? 'note note-info'
                : 'field-error'
          }
        >
          {result.status === 'confirmed' && sendConfirmedLine()}
          {result.status === 'declined' && sendDeclinedLine()}
          {result.status === 'settling' && sendSettlingLine()}
          {result.status === 'rejected' && sendRejectedLine()}
          {result.status === 'unconfirmed' && sendUnconfirmedLine()}
          {result.status === 'unchecked' && sendUncheckedLine()}
          {result.status === 'blocked' && sendNoRpcLine()}
          {result.status === 'failed' && `Couldn’t send: ${result.detail}`}
        </p>
      )}

      <p className="note note-info">{chatPublicNotice()}</p>
    </div>
  )
}
