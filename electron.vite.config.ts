import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Bundle third-party main-process dependencies into the application output.
  // The installer then needs only compiled output, not complete package sources.
  main: {
    build: {
      externalizeDeps: false
    }
  },
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
