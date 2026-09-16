/**
 * The app's few icons, drawn inline so no request leaves the device for them
 * (§2.2 — the same reason there is no webfont). Stroke icons on a 24-box in
 * `currentColor`, so each takes the colour of the text beside it and a tab or
 * a verification line recolours them for free.
 *
 * Five for the tab bar, three for the verification line, four for the
 * masthead — the button that holds the nav on a phone, where there is room
 * for a glyph and not for the word, the mark on the rows that leave the app,
 * and the sun and moon on the night-mode switch, which is the one control in
 * the chrome whose whole label is its picture — and two for the copy control
 * on a resolved address, which is a picture because the row it sits in is
 * already a full address and has no room for a word until it is pressed — and
 * two for the masthead's chain readout, where a phone has room for two long
 * numbers or for their labels, but not for both.
 * Nothing else earns a pictogram: the proof rail and the identicon already carry the meanings that
 * matter, and a glyph beside every sentence would spend the reader's
 * attention on decoration.
 */

import type { ReactNode } from 'react'

function Glyph({ children, size = 22 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      {children}
    </svg>
  )
}

export type TabIconName = 'search' | 'pay' | 'names' | 'inbox' | 'market'

export function TabIcon({ name }: { name: TabIconName }) {
  switch (name) {
    case 'search':
      return (
        <Glyph>
          <circle cx="11" cy="11" r="6.5" />
          <path d="M16 16l4.5 4.5" />
        </Glyph>
      )
    case 'pay':
      return (
        <Glyph>
          <path d="M4 11.5l16-7.5-7.5 16-1.8-6.7L4 11.5z" />
          <path d="M10.7 13.3L20 4" />
        </Glyph>
      )
    case 'names':
      return (
        <Glyph>
          <path d="M3.5 3.5h7.6l9.4 9.4-7.6 7.6-9.4-9.4V3.5z" />
          <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
        </Glyph>
      )
    case 'inbox':
      return (
        <Glyph>
          <path d="M4 5.5h16v10.5H9.5L4.5 20v-4H4V5.5z" />
        </Glyph>
      )
    case 'market':
      return (
        <Glyph>
          <path d="M3 9.5l1.6-5h14.8L21 9.5H3z" />
          <path d="M4.5 9.5V20h15V9.5" />
          <path d="M10 20v-5.5h4V20" />
        </Glyph>
      )
  }
}

/** The proven tick: a check inside a circle, sized to sit in a line of text. */
export function CheckIcon() {
  return (
    <Glyph size={18}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l2.7 2.7L16 9.5" />
    </Glyph>
  )
}

/** Pending depth: a clock, because depth is time (§8.7), never a warning. */
export function ClockIcon() {
  return (
    <Glyph size={18}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V12l3 2" />
    </Glyph>
  )
}

/** The disclosure on the verified line: down when collapsed, flipped by CSS
 *  when the resolver list is open. */
export function ChevronIcon() {
  return (
    <Glyph size={16}>
      <path d="M6 9.5l6 6 6-6" />
    </Glyph>
  )
}

/**
 * The masthead's nav button on a phone. Not a `TabIcon`: that union is the
 * five tab-bar destinations, and this is chrome rather than a destination.
 */
export function MenuIcon() {
  return (
    <Glyph size={20}>
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </Glyph>
  )
}

/** Marks a nav row that leaves the app, so a new tab is never a surprise. */
export function ExternalIcon() {
  return (
    <Glyph size={14}>
      <path d="M14 4h6v6" />
      <path d="M20 4l-8.5 8.5" />
      <path d="M18 14.5V20H4V6h5.5" />
    </Glyph>
  )
}

/** The copy control on a rendered address: the two-sheets mark every platform uses. */
export function CopyIcon() {
  return (
    <Glyph size={14}>
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M5.5 15H5a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 5 3.5h8.5A1.5 1.5 0 0 1 15 5v0.5" />
    </Glyph>
  )
}

/** What the copy control becomes for a moment. Bare, not `CheckIcon`'s circle:
 *  that one is the §8.3 proven mark and means something on its own. */
export function TickIcon() {
  return (
    <Glyph size={14}>
      <path d="M4.5 12.5l5 5 10-10" />
    </Glyph>
  )
}

/**
 * Night mode's two faces. Each shows the *destination*, not the state: the
 * moon on a lit page is what pressing it gets you. That is the convention
 * every phone's own switch uses, and the button says the same thing in words
 * (`themeToggleLabel`) for anything that cannot see it.
 */
export function MoonIcon() {
  return (
    <Glyph size={18}>
      <path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z" />
    </Glyph>
  )
}

export function SunIcon() {
  return (
    <Glyph size={18}>
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" />
    </Glyph>
  )
}

/**
 * The chain's height, in the masthead strip. Two links: the chain is the one
 * thing in this app that is not a metaphor, so the glyph is literal.
 */
export function ChainIcon() {
  return (
    <Glyph size={15}>
      <path d="M10 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1" />
      <path d="M14 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1" />
    </Glyph>
  )
}

/**
 * The registry's height, beside the chain's. Stacked layers, because what the
 * registry has is the blocks it has folded in — and it is always a subset of
 * the chain's, which is exactly what the strip is showing.
 */
export function LayersIcon() {
  return (
    <Glyph size={15}>
      <path d="M12 3.5l8 4.5-8 4.5-8-4.5 8-4.5z" />
      <path d="M4 13l8 4.5 8-4.5" />
    </Glyph>
  )
}
