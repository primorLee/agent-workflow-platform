// Standalone entry for awp-ide MCP server. Runs outside Electron.
// 1. Reads $AWP_DESKTOP_VERSION as the desktop version label.
// 2. Starts HTTP MCP server on 127.0.0.1:0 (dynamic port).
// 3. Prints `READY url=... token=...` line on stdout (one line) so the launcher
//    can parse and pass to a compatible Agent CLI's MCP configuration.
// 4. Keeps running until SIGINT/SIGTERM.

import { startAwpIdeServer } from './server'

async function main() {
  const desktopVersion = process.env.AWP_DESKTOP_VERSION || 'sandbox-0.0.1'
  const result = await startAwpIdeServer({ desktopVersion })
  process.stdout.write(`READY url=${result.url} token=${result.token}\n`)
  // Idle forever
  process.stdin.resume()
}

main().catch((err) => {
  process.stderr.write(`awp-ide standalone failed: ${err?.stack || err}\n`)
  process.exit(1)
})
