import { createServer as createViteServer } from 'vite'
import { startDemoControlPlane } from './demo-control-plane.mjs'

const viteOrigin = 'http://127.0.0.1:5173'
const demo = await startDemoControlPlane({ allowedOrigins: [viteOrigin] })
process.env.VITE_AWP_DEMO_TOKEN = demo.token
process.env.VITE_AWP_DEMO_ORIGIN = demo.url

const vite = await createViteServer({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
})
await vite.listen()

console.log('\n[AWP demo] local adapter: ' + demo.url)
vite.printUrls()
console.log('[AWP demo] hosted auth is disabled; no account or API key is required\n')

let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  delete process.env.VITE_AWP_DEMO_TOKEN
  delete process.env.VITE_AWP_DEMO_ORIGIN
  await Promise.allSettled([vite.close(), demo.close()])
}

process.once('SIGINT', () => void shutdown().then(() => process.exit(0)))
process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)))