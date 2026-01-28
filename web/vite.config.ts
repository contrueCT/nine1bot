import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/session': 'http://localhost:4096',
      '/event': 'http://localhost:4096',
      '/file': 'http://localhost:4096',
      '/project': 'http://localhost:4096',
      '/global': 'http://localhost:4096',
      '/find': 'http://localhost:4096',
    }
  }
})
