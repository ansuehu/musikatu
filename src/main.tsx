import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { migrateStorageKeys } from './migrate'
import './styles.css'

migrateStorageKeys()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
