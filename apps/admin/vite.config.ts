import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

const DEFAULT_API_URL = 'http://127.0.0.1:8100'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = env.VITE_AWP_API_URL || DEFAULT_API_URL
  const proxy = {
    '/awp-api': {
      target: apiTarget,
      changeOrigin: false,
      rewrite: (path: string) => path.replace(/^\/awp-api/, ''),
    },
  }

  return {
    plugins: [vue()],
    base: '/admin/',
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
      },
    },
    server: {
      host: '127.0.0.1',
      port: 5174,
      strictPort: true,
      proxy,
    },
    preview: {
      host: '127.0.0.1',
      port: 4174,
      strictPort: true,
      proxy,
    },
  }
})
