import { defineConfig } from 'vite'
import { resolve } from 'path'
import { copyFileSync, mkdirSync, existsSync, writeFileSync } from 'fs'

// Plugin to copy static files after build
function copyStaticFiles() {
  return {
    name: 'copy-static-files',
    closeBundle() {
      const distDir = resolve(__dirname, 'dist')

      // Copy manifest.json
      copyFileSync(
        resolve(__dirname, 'manifest.json'),
        resolve(distDir, 'manifest.json')
      )

      // Create icons directory and copy icons
      const iconsDir = resolve(distDir, 'icons')
      if (!existsSync(iconsDir)) {
        mkdirSync(iconsDir, { recursive: true })
      }

      // Create simple colored PNG icons (blue square)
      const icons: Record<string, Buffer> = {
        'icon16.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAOklEQVQ4T2NkoBAwUqifgWoGjBow+A2g2hAYHgYMWgOGRxgMOgMGfRhMuiQx6MJgcIUBVdLhoA8DAHGcCBGjzm1TAAAAAElFTkSuQmCC', 'base64'),
        'icon32.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAWklEQVRYhe3OMQEAAAgDINc/tMeQBnrgBBUlJSUlJSUlJSUlJSUlJSUlJSUlJSUlJSUlJSUlJSUlJSUlJSUlJSUlJSUlJSUlJSUlJSUlJSUlJSUlJSUlJSXlJgDHpwKRxtLv9QAAAABJRU5ErkJggg==', 'base64'),
        'icon48.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAcklEQVRoge3OMQEAAAgDoGn/0G7hIB3gnqCgpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpfUCT+MCkfbIRYsAAAAASUVORK5CYII=', 'base64'),
        'icon128.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAAl0lEQVR4nO3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIC3AcUIAAGY7dY0AAAAAElFTkSuQmCC', 'base64'),
      }

      for (const [name, data] of Object.entries(icons)) {
        writeFileSync(resolve(iconsDir, name), data)
      }

      console.log('✓ Copied manifest.json and icons to dist/')
    }
  }
}

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyDirOnBuild: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background/index.ts'),
        content: resolve(__dirname, 'src/content/index.ts'),
      },
      output: {
        entryFileNames: '[name]/index.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        format: 'es',
      },
    },
    sourcemap: true,
    minify: false,
  },
  plugins: [copyStaticFiles()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
})
