import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@nimiqnames/resolver/rendering.css'
import './app.css'
import { App } from './App'
import { applyHostChrome, watchViewport } from './lib/chrome'

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

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
