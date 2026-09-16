import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const PYTHON_BACKEND_PORT = Number(process.env.FOCUSLEARN_PORT ?? 8787)

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      // Forward YouTube search calls to the Python (yt-dlp) backend.
      '/api': `http://localhost:${PYTHON_BACKEND_PORT}`,
    },
  },
})