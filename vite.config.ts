import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.config'

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome116',
    rollupOptions: {
      // offscreen.html 不在 manifest 里引用，需显式作为入口
      input: {
        offscreen: 'src/offscreen/index.html',
      },
    },
  },
})
