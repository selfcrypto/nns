/**
 * The masthead's nav: Docs, Protocol, GitHub, Dashboard and Contact (`NAV`
 * and `CONTACT`, in `lib/wording.ts`).
 *
 * It exists because two screens render no tab bar — `home` and `docs` — and on
 * Docs the only way back into the app was clicking the wordmark, an `h1` with a
 * click handler that no keyboard can reach. The repo and the protocol document
 * had no place in the chrome at all; they lived only in the landing page's
 * footer, which is to say nowhere once you are inside the app.
 *
 * Two exports rather than one component, because the two forms sit at different
 * points in the masthead and neither can be the other moved:
 *
 * - `MastheadLinks` is the row of anchors after the wordmark, shown above
 *   768px. Below that the row has no space for it — the corner chip is ~156px
 *   and the wordmark ~143px, so a phone has between 17 and 87 px of slack, and
 *   below 380px `app.css` already blanks the wordmark to keep the address
 *   readable.
 * - `MastheadMenu` is the button that holds the same rows on a phone, in the
 *   corner beside the wallet chip. A button costs width, not height, which is
 *   what matters inside Nimiq Pay: `--chrome-top` is 0 there and the bottom is
 *   already down ~120px before the tab bar's pill.
 *
 * Which one shows is CSS (`app.css`, the 960px block), not a JS breakpoint —
 * one list, rendered twice, so the two can never disagree about what is in it.
 *
 * **Contact is a group, not a link** (2026-09-16), because there is no contact
 * page to point at. On the wide row it is a disclosure with its own panel; in
 * the phone panel it is a labelled section under a hairline, because a panel
 * inside a panel is a worse answer than a heading. Its own `open` state is
 * local: `MastheadMenu`'s is `App.tsx`'s only because the wallet panel hangs
 * in that same corner, and this one drops from the middle of the row where
 * nothing else does.
 *
 * The button is its own pill beside the wallet chip, not welded to it: the chip
 * has four looks (the orange Connect pill, the "Checking wallet…" note, the
 * chip, and a flat disabled chip that says so by not looking pressable), so
 * three of them have no edge to fuse to — and `IdentityBar` exists precisely so
 * identity has one control, which a menu welded to its side would blur.
 */

import { useEffect, useState } from 'react'
import { closeLabel, CONTACT, CONTACT_TITLE, contactSoonLabel, NAV, menuLabel } from '../lib/wording'
import { ChevronIcon, ExternalIcon, MenuIcon } from './icons'

/**
 * The app's link rule, as `screens/Home.tsx` states it: a hash href stays in
 * the app, an absolute one leaves and says so — a new tab the reader did not
 * ask for is only a surprise if nothing marked it.
 */
function NavLink({ label, href, onNavigate }: { label: string; href: string; onNavigate?: () => void }) {
  const internal = href.startsWith('#')
  return (
    <a
      href={href}
      onClick={onNavigate}
      {...(internal ? {} : { target: '_blank', rel: 'noopener noreferrer' })}
    >
      {label}
      {!internal && <ExternalIcon />}
    </a>
  )
}

/**
 * The contact channels, in whichever panel is asking. A `null` href is a
 * channel that has no address yet: it draws as a row that is visibly not
 * pressable with the reason beside it, never as `href="#"`, which on a
 * hash-routed app would throw the reader off the screen they were on.
 */
function ContactRows({ onNavigate }: { onNavigate: () => void }) {
  return (
    <>
      {CONTACT.map(([label, href]) =>
        href === null ? (
          <span key={label} className="nav-soon">
            {label}
            <span className="nav-soon-tag">{contactSoonLabel()}</span>
          </span>
        ) : (
          <NavLink key={label} label={label} href={href} onNavigate={onNavigate} />
        ),
      )}
    </>
  )
}

/** Contact on the wide row: a disclosure, the same shape as the phone button. */
function ContactMenu() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <div className="nav-contact">
      {open && <button type="button" className="nav-scrim" aria-label={closeLabel()} onClick={() => setOpen(false)} />}
      <button
        type="button"
        className="nav-contact-btn"
        aria-expanded={open}
        aria-controls="nav-contact-panel"
        onClick={() => setOpen(!open)}
      >
        {CONTACT_TITLE}
        <ChevronIcon />
      </button>
      {open && (
        <div className="masthead-menu-panel nav-contact-panel" id="nav-contact-panel">
          <ContactRows onNavigate={() => setOpen(false)} />
        </div>
      )}
    </div>
  )
}

/** The links themselves, above 960px. */
export function MastheadLinks() {
  return (
    <nav className="masthead-nav" aria-label="Site">
      {NAV.map(([label, href]) => (
        <NavLink key={label} label={label} href={href} />
      ))}
      <ContactMenu />
    </nav>
  )
}

/**
 * The same rows behind a button, at 960px and below. `open` is owned by
 * `App.tsx` because the wallet panel hangs in this same corner and the two have
 * to be mutually exclusive — two panels overlapping in one corner is a bug you
 * only see on the device.
 */
export function MastheadMenu({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onToggle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onToggle])

  return (
    <div className="masthead-menu-wrap">
      {/* A tap anywhere else closes it, the same way the wallet panel does. */}
      {open && <button type="button" className="nav-scrim" aria-label={closeLabel()} onClick={onToggle} />}
      {/* A disclosure, not an ARIA menu: `aria-haspopup` would promise
          `role="menuitem"` children with arrow-key navigation, and these are
          ordinary links, most of which leave the app. `aria-expanded` alone
          is what the wallet chip beside it already says. */}
      <button
        type="button"
        className="masthead-menu"
        aria-label={menuLabel()}
        aria-expanded={open}
        aria-controls="masthead-menu-panel"
        onClick={onToggle}
      >
        <MenuIcon />
      </button>
      {open && (
        <nav className="masthead-menu-panel" id="masthead-menu-panel" aria-label="Site">
          {/* The panel closes on the way out, or it hangs over the screen the
              reader just asked for. An external row closes too: the tab it
              opened is in front of them, and this one should be as they left it. */}
          {NAV.map(([label, href]) => (
            <NavLink key={label} label={label} href={href} onNavigate={onToggle} />
          ))}
          {/* A section, not a nested disclosure: three rows are cheaper to
              show than a second panel is to open on a thumb. */}
          <span className="nav-section">{CONTACT_TITLE}</span>
          <ContactRows onNavigate={onToggle} />
        </nav>
      )}
    </div>
  )
}
