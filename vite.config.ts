import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  server: { port: Number(process.env.PORT) || 5173 },
  build: {
    target: 'es2022',
    // three.js は 3D タブを開いた時だけ読み込む(動的 import)ため、
    // メインバンドルは極小に保たれる
    chunkSizeWarningLimit: 900
  }
})
