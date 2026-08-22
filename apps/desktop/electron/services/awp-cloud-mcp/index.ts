/**
 * Optional external artifact MCP stdio entry point.
 *
 * A compatible Agent CLI may spawn the built bundle through an explicit MCP
 * configuration. The child must receive all three settings below:
 *
 *   {
 *     "mcpServers": {
 *       "awp-cloud": {
 *         "type": "stdio",
 *         "command": "node",
 *         "args": ["<install-dir>/dist-awp-cloud-mcp/index.js"],
 *         "env": {
 *           "AWP_CLOUD_ARTIFACT_MCP_OPT_IN": "1",
 *           "AWP_API_BASE": "https://artifacts.example.test",
 *           "AWP_API_TOKEN_PATH": "<operator-managed token file>"
 *         }
 *       }
 *     }
 *   }
 *
 * The API is an external compatibility contract; the public control plane in
 * this repository does not implement /v1/project/files endpoints. HTTP is
 * accepted only for a loopback API. Every non-loopback API must use HTTPS.
 *
 * Stdout is owned by MCP JSON-RPC framing; diagnostics go to stderr only.
 */

import { runServer } from './server'

runServer().catch((err) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  console.error('[awp-cloud-mcp] fatal:', (err as any)?.stack || err)
  process.exit(1)
})