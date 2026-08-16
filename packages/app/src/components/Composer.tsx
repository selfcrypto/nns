import { useState } from 'react'
import { chatByteBudget, encodeChatPayload, messageBytes } from '../lib/chat'
import {
  CHAT_ENCODE_TEXT,
  chatBudgetLine,
  chatOwnNameLine,
  chatPublicNotice,
  sendsDisabledLine,
} from '../lib/wording'
import { NameText } from './ui'

/**
 * The NC message composer (docs/app-chat.md). Counts UTF-8 bytes, refuses
 * everything the convention refuses, and carries the public-forever notice.
 * The send button stays behind the same gate as every send.
 */
export function Composer({ name, ownName, heading }: { name: string; ownName: boolean; heading?: string }) {
  const [text, setText] = useState('')

  if (ownName) return <p className="note note-info">{chatOwnNameLine()}</p>

  const budget = chatByteBudget(name)
  const used = messageBytes(text)
  const encoded = text === '' ? null : encodeChatPayload(name, text)
  const failure = encoded !== null && !encoded.ok ? encoded.reason : null

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
        <button className="composer-send" type="button" disabled title={sendsDisabledLine()}>
          Send
        </button>
      </div>
      {failure !== null && failure !== 'EMPTY_MESSAGE' && <p className="field-error">{CHAT_ENCODE_TEXT[failure]}</p>}
      <p className="note note-info">{chatPublicNotice()}</p>
      <p className="note note-info">{sendsDisabledLine()}</p>
    </div>
  )
}
