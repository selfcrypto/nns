import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@nimiqnames/resolver/rendering.css'
import './app.css'
import { App, DEFAULT_TAB } from './App'
import { applyHostChrome, watchViewport } from './lib/chrome'
import { parseRoute } from './lib/route'
import { applyTheme, loadTheme, systemPrefersDark } from './lib/theme'

const container = document.getElementById('root')
if (container === null) throw new Error('missing #root')

// Before the first render: the frame's padding is these two custom properties,
// and a frame laid out at zero and corrected afterwards flashes the masthead
// under Nimiq Pay's bar on the way past.
//
// Wrapped, because it runs *ahead* of the render and a throw here would take
// the whole app with it — a blank screen inside a host we cannot attach a
// console to. The CSS defaults (the plain safe area) are a working layout on
// their own, so failing to improve on them is not a reason to show nothing.
try {
  applyHostChrome()
  watchViewport()
} catch {
  /* keep the stylesheet's defaults */
}

// And before it too: `App` re-applies this on every render, but its first one
// is already a paint late, and a dark-mode user would watch the app flash
// white on the way in. Same guard, same reason — the light palette is a
// working page on its own, so a store that throws costs nothing here.
try {
  applyTheme(
    document,
    loadTheme(window.localStorage, systemPrefersDark(window)),
    parseRoute(window.location.hash, DEFAULT_TAB).tab !== 'home',
  )
} catch {
  /* keep the light palette */
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
