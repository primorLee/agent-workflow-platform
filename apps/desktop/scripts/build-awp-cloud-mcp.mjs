/**
 * Bundle awp-cloud-mcp into a single self-contained JS file via esbuild.
 *
 * Mirrors build-cc-mcp.mjs but targets the awp-cloud-mcp stdio MCP
 * server. A configured compatible agent runtime spawns this bundle as a
 * Node subprocess on each session start via the awp-cloud entry in
 * mcp-config.json. Bundling means the MCP child boots from a single file
 * on disk with @modelcontextprotocol/sdk inlined — same asar-unpack
 * survival rationale as build-cc-mcp.mjs.
 *
 * Output: desktop/dist-awp-cloud-mcp/index.js. Public production bundles
 * deliberately omit source maps.
 * Consumer: electron/services/index.ts startServices step 10b builds
 *           the explicit configuration that points the compatible agent at this bundle.
 */
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

await build({
  entryPoints: [path.join(repoRoot, 'electron/services/awp-cloud-mcp/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: path.join(repoRoot, 'dist-awp-cloud-mcp/index.js'),
  sourcemap: false,
  external: [
    // Electron — never imported in awp-cloud-mcp, but mark external
    // in case a transitive ever does. The child runs under Electron.exe
    // with ELECTRON_RUN_AS_NODE=1.
    'electron',
    // No ssh2 in this module (it's pure HTTP), but mark external defensively
    // in case @modelcontextprotocol/sdk drags it in transitively.
    'ssh2',
  ],
  logLevel: 'info',
})
