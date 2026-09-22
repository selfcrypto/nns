import { useEffect, useRef, useState } from 'react'
import { addressFromOutcome, readAddressField } from '../lib/addressField'
import { splitAroundName } from '../lib/format'
import { search } from '../lib/search'
import { useDebounced } from '../lib/useDebounced'
import {
  addressOrNamePlaceholder,
  filledFromDelegateLine,
  filledFromNameLine,
  lookingUpLine,
  notAnAddressLine,
  queryFaultLine,
} from '../lib/wording'
import { NameText } from './ui'

/** A note that has a name in it renders that name in the §4.3 face, as a review line does. */
function NoteWithName({ line, name }: { line: string; name: string }) {
  return (
    <p className="sheet-note">
      {splitAroundName(line, name).map((part, index) =>
        part.isName ? <NameText key={index}>{part.text}</NameText> : <span key={index}>{part.text}</span>,
      )}
    </p>
  )
}

/**
 * The one field that takes **an address or a name**. A name is resolved and
 * the box fills itself with the address that came back (Rico, 2026-09-15:
 * *"it should allow a name, resolve the target and auto fill the box with the
 * output address"*).
 *
 * The box shows the address rather than keeping the name, and that is the
 * point: `X` and `S` both record an address, the review line names that
 * address, and an owner transferring a name gets to read the thing they are
 * signing before they sign it. The note underneath says which name it came
 * from, so the fill is never a box changing under someone's hands.
 *
 * The parent holds the **address** and is handed `''` the moment the text
 * stops being one — so a half-typed name can never reach `prepareAction`,
 * which is what put *"The new owner is not a Nimiq address"* under the word
 * `rico` as it was being typed.
 */
export function AddressInput({
  value,
  onChange,
  placeholder = addressOrNamePlaceholder(),
}: {
  value: string
  onChange: (address: string) => void
  placeholder?: string
}) {
  const [text, setText] = useState(value)
  const [settled] = useDebounced(text, 400)
  const [looking, setLooking] = useState<string | null>(null)
  const [filled, setFilled] = useState<{ readonly from: string; readonly delegated: boolean } | null>(null)
  const [fault, setFault] = useState<string | null>(null)
  // A lookup that has been superseded must not land: the field is typed into
  // faster than the network answers, and the last *request* is not always the
  // last *response*.
  const asked = useRef(0)

  const take = (next: string) => {
    setText(next)
    setFilled(null)
    setFault(null)
    const read = readAddressField(next)
    onChange(read.kind === 'address' ? read.address : '')
  }

  useEffect(() => {
    const read = readAddressField(settled)
    if (read.kind !== 'name') {
      setLooking(null)
      // The fault only shows once typing has settled. Shown on every
      // keystroke it says "not an address" about every prefix of one.
      setFault(read.kind === 'fault' ? (read.fault === 'address' ? notAnAddressLine() : queryFaultLine(read.fault)) : null)
      return
    }
    const ticket = ++asked.current
    setLooking(read.query)
    setFault(null)
    void search(read.query).then((outcome) => {
      if (ticket !== asked.current) return
      setLooking(null)
      const lookup = addressFromOutcome(outcome, read.query)
      if (lookup.kind === 'none') {
        setFault(lookup.line)
        return
      }
      setText(lookup.address)
      setFilled({ from: lookup.from, delegated: lookup.delegated })
      onChange(lookup.address)
    })
    // `onChange` is the parent's setter and is stable enough in practice; the
    // effect keys on the settled text alone so a re-render cannot re-ask.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled])

  return (
    <>
      <input
        className="sheet-input nns-name"
        placeholder={placeholder}
        value={text}
        onChange={(event) => take(event.target.value)}
      />
      {looking !== null && <NoteWithName line={lookingUpLine(looking)} name={looking} />}
      {filled !== null && (
        <NoteWithName
          line={filled.delegated ? filledFromDelegateLine(filled.from) : filledFromNameLine(filled.from)}
          name={filled.from}
        />
      )}
      {fault !== null && <p className="field-error">{fault}</p>}
    </>
  )
}
