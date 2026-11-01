import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { PetApp } from './PetApp'
import { QuotaApp } from './QuotaApp'
import { RemotePetApp } from './RemotePetApp'
import { initializeTheme } from './theme'
import './styles.css'
import './settings.css'
import './features.css'
import './project.css'
import './office.css'
import './pet.css'
import './usage.css'
import './appearance.css'
import './quota-window.css'

initializeTheme()

const el = document.getElementById('root')
if (el) {
  // The desktop pet overlay loads the same bundle at #/pet and renders only the pet.
  const pet = window.location.hash === '#/pet'
  const quota = window.location.hash === '#/quota'
  const remotePet = window.location.hash === '#/remote-pet'
  createRoot(el).render(<StrictMode>{pet ? <PetApp /> : quota ? <QuotaApp /> : remotePet ? <RemotePetApp /> : <App />}</StrictMode>)
}
