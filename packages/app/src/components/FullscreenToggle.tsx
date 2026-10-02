/**
 * Nimiq Pay's native fullscreen, as a button in the masthead corner. It draws
 * only where the host offers the calls (`hostFullscreen`), so a browser and an
 * older Pay never see it.
 *
 * Pay shows no approval prompt and asks the mini app to ask before each
 * request. The press is the ask: nothing else enters fullscreen, not a stored
 * choice and not a page load.
 *
 * The state is the host's, never this component's guess. The user can leave
 * through Pay's own button or Android Back, and backgrounding the app leaves
 * too, so the button listens for the change and asks again when the page
 * becomes visible. No timer.
 *
 * While fullscreen is on the button is gone. Pay draws its own exit button
 * over the masthead row's right end (app.css keeps that spot clear), and a
 * second exit beside it is one control twice.
 */

import { useEffect, useState } from 'react'
import { applyFullscreen } from '../lib/chrome'
import { hostFullscreen } from '../lib/sdk'
import { fullscreenLabel } from '../lib/wording'
import { ExpandIcon } from './icons'

export function FullscreenToggle() {
  const [host] = useState(() => hostFullscreen())
  const [on, setOn] = useState(false)

  useEffect(() => {
    if (host === null) return
    let live = true
    const set = (enabled: boolean) => {
      if (!live) return
      setOn(enabled)
      try {
        applyFullscreen(enabled)
      } catch {
        /* keep the insets as they are */
      }
    }
    const refresh = () => {
      host.getFullscreen().then(set, () => {})
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    let stop = () => {}
    try {
      stop = host.onFullscreenChange(set)
    } catch {
      /* the press still works, and `refresh` still reads the state */
    }
    document.addEventListener('visibilitychange', onVisible)
    refresh()
    return () => {
      live = false
      stop()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [host])

  if (host === null || on) return null
  const label = fullscreenLabel()
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={label}
      title={label}
      onClick={() => {
        // A refusal changes nothing on screen, and the host reports the
        // outcome through `onFullscreenChange` either way.
        void host.requestFullscreen().catch(() => {})
      }}
    >
      <ExpandIcon />
    </button>
  )
}
