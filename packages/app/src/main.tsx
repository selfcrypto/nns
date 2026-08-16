import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@nns/resolver/rendering.css'
import './app.css'
import { App } from './App'

const container = document.getElementById('root')
if (container === null) throw new Error('missing #root')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
