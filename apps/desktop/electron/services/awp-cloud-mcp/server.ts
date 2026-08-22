/**
 * Stdio MCP server for the optional external artifact compatibility API.
 *
 * Invariants:
 *   - configuration is validated before tools are advertised
 *   - stdout is reserved for MCP JSON-RPC framing
 *   - diagnostics are emitted on stderr only
 *   - SIGTERM, SIGINT, and parent stdin closure stop the child cleanly
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { CLOUD_TOOLS, dispatchCloudTool, initializeCloudToolClient } from './tools'

function log(...args: unknown[]): void {
  console.error('[awp-cloud-mcp]', ...args)
}

function setupLifecycle(): void {
  const exit = (signal: string) => {
    log(`got ${signal}, exiting`)
    process.exit(0)
  }
  process.on('SIGTERM', () => exit('SIGTERM'))
  process.on('SIGINT', () => exit('SIGINT'))
  process.stdin.on('end', () => {
    log('stdin closed by parent, exiting')
    process.exit(0)
  })
  process.on('uncaughtException', (e) => {
    log('uncaughtException:', e?.stack || e)
  })
  process.on('unhandledRejection', (e) => {
    log('unhandledRejection:', e)
  })
}

function readVersion(): string {
  try {
    const pkg = require('../../../package.json')
    return typeof pkg?.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export async function runServer(): Promise<void> {
  // Fail before connecting stdio or advertising tools when the optional
  // external artifact service has not been explicitly enabled and configured.
  initializeCloudToolClient()
  setupLifecycle()

  const version = readVersion()
  const server = new Server(
    { name: 'awp-cloud', version },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...CLOUD_TOOLS],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params?.name ?? ''
    const args = (req.params?.arguments ?? {}) as Record<string, unknown>
    try {
      return await dispatchCloudTool(name, args)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log(`call_tool ${name} error: ${msg}`)
      return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true }
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
  log(`connected, version=${version}`)
}