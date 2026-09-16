import { fileURLToPath } from 'node:url'
import { defineConfig, normalizePath } from 'vite'
import react from '@vitejs/plugin-react'

// Vite's canonical module IDs use forward slashes, including on Windows.
// Built-in alias resolution lets relative and alias imports share one instance.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': normalizePath(fileURLToPath(new URL('./src', import.meta.url))),
    },
    dedupe: ['react', 'react-dom'],
  },
  build: { outDir: 'dist/client', emptyOutDir: true },
  server: {
    host: 'localhost',
    port: Number(process.env.PORT || 3410),
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${process.env.API_PORT || 3411}` },
  },
})
