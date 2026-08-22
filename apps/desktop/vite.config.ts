import { fileURLToPath, URL } from 'node:url'
import { readFileSync } from 'node:fs'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [
    vue(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __FORCE_DEV_MODE__: process.env.AWP_DEV === '1',
    __VUE_I18N_FULL_INSTALL__: true,
    __VUE_I18N_LEGACY_API__: false,
    __INTLIFY_JIT_COMPILATION__: false,
    __INTLIFY_DROP_MESSAGE_COMPILER__: false,
  },
  build: {
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        // Vite 8 / Rollup: object-literal manualChunks record is still supported
        // at runtime but the exported type only exposes the function form.
        manualChunks(id) {
          if (/[\\/]node_modules[\\/](vue|vue-router|pinia|vue-i18n)[\\/]/.test(id)) return 'vendor-vue'
          if (/[\\/]node_modules[\\/](@antv[\\/]x6|tslib)[\\/]/.test(id)) return 'vendor-x6'
          if (/[\\/]node_modules[\\/]marked[\\/]/.test(id)) return 'vendor-utils'
        },
      },
    },
  },
})
