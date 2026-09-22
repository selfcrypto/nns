/**
 * Night mode: which palette the dashboard is lit with, and the one screen
 * that never takes it.
 *
 * The choice is device-local and best-effort, exactly like the hidden senders
 * in `hidden.ts` and the Hub address set in `identity.ts` — nothing about how
 * someone likes their screen belongs on a chain or on a server, and a
 * storage that throws (a locked-down WebView, a private window) answers with
 * the system's own preference rather than failing.
 *
 * Nothing is stored until the button is pressed. Until then the answer is
 * `prefers-color-scheme`, which is the setting the person already made once,
 * for every app on the device; asking them to make it again is the kind of
 * choice an app invents for itself.
 *
 * **The landing page is deliberately exempt.** It is photographs and a video
 * shot for a white ground, and relighting the palette under them looks worse
 * than not offering the switch at all (Rico, 2026-09-14). So `dashboard` is a
 * parameter here rather than an assumption: the stored choice survives a trip
 * to the landing page, it just does not paint it. When those assets have dark
 * cuts, the call site drops the argument and this file does not change.
 */

import type { StorageLike } from './identity'

export type Theme = 'light' | 'dark'

const THEME_KEY = 'nns.theme'

/** The stored choice, or the system's if there is none (or none readable). */
export function loadTheme(storage: StorageLike, systemPrefersDark: boolean): Theme {
  let raw: string | null
  try {
    raw = storage.getItem(THEME_KEY)
  } catch {
    return systemPrefersDark ? 'dark' : 'light'
  }
  if (raw === 'dark' || raw === 'light') return raw
  return systemPrefersDark ? 'dark' : 'light'
}

export function saveTheme(storage: StorageLike, theme: Theme): void {
  try {
    storage.setItem(THEME_KEY, theme)
  } catch {
    // Best-effort, like every per-device store here: the session still
    // renders in the theme that was asked for, it just will not be
    // remembered.
  }
}

/**
 * `matchMedia` is absent in a jsdom test and has been absent in old WebViews;
 * a host that cannot answer is a host with no preference, which is light.
 */
export function systemPrefersDark(host: Window): boolean {
  try {
    return host.matchMedia?.('(prefers-color-scheme: dark)').matches === true
  } catch {
    return false
  }
}

/**
 * Paint it. `data-theme` goes on `<html>` rather than on the frame, because
 * `body`'s own background is a token and a frame-scoped attribute leaves the
 * page behind the app in the other palette — visible the moment a short
 * screen is over-scrolled.
 *
 * `theme-color` follows, so the browser's own bar matches the page under it.
 * The value is read back off the root rather than written twice: the palette
 * is `app.css`'s business, and a hex repeated here is a hex that drifts.
 */
export function applyTheme(doc: Document, theme: Theme, dashboard: boolean): void {
  const root = doc.documentElement
  if (theme === 'dark' && dashboard) root.setAttribute('data-theme', 'dark')
  else root.removeAttribute('data-theme')

  const meta = doc.querySelector('meta[name="theme-color"]')
  if (meta === null) return
  let paper = ''
  try {
    paper = doc.defaultView?.getComputedStyle(root).getPropertyValue('--paper').trim() ?? ''
  } catch {
    paper = ''
  }
  if (paper !== '') meta.setAttribute('content', paper)
}
