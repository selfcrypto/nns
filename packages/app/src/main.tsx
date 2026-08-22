import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@nns/resolver/rendering.css'
import './app.css'
import { App } from './App'
import { applyHostChrome } from './lib/chrome'

const container = document.getElementById('root')
if (container === null) throw new Error('missing #root')

// Before the first render: the frame's padding is these two custom properties,
// and a frame laid out at zero and corrected afterwards flashes the masthead
// under Nimiq Pay's bar on the way past.
applyHostChrome()

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
