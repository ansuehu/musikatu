import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Relative asset paths so the production build loads from file:// inside Electron.
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  build: { outDir: 'dist', target: 'chrome120' },
})
