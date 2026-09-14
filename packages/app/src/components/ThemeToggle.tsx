/**
 * The night-mode switch: the third control in the masthead corner, to the
 * left of the nav button and the wallet chip (`App.tsx`), in the same 30px
 * circle so the corner reads as one set rather than three visitors.
 *
 * Leftmost because the corner is ordered by how often it is touched, and this
 * is the one a person presses once and then forgets. The wallet chip — the
 * half of the corner a user has to be able to read — keeps the edge.
 *
 * It is not rendered on the landing page. The stored choice survives a trip
 * there, but that page is lit for its photographs (`lib/theme.ts`), so the
 * button would sit on a screen it cannot change: an option that does nothing
 * where it is shown is worse than an option that is not shown.
 *
 * A plain button, not a `role="switch"` — it changes the page immediately
 * rather than setting a value someone submits, and the page itself is the
 * feedback. `title` carries the same words as `aria-label` so a pointer gets
 * what a screen reader gets.
 */

import { themeToggleLabel } from '../lib/wording'
import type { Theme } from '../lib/theme'
import { MoonIcon, SunIcon } from './icons'

export function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const dark = theme === 'dark'
  const label = themeToggleLabel(dark)
  return (
    <button type="button" className="theme-toggle" onClick={onToggle} aria-label={label} title={label}>
      {dark ? <SunIcon /> : <MoonIcon />}
    </button>
  )
}
