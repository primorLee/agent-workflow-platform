/**
 * Persistent awp-ide MCP server.
 *
 * Lifetime = awp Desktop process (starts in startServices(), stops
 * in stopServices()). Runs an HTTP MCP server on 127.0.0.1 at an
 * OS-assigned random high port. Token-authed via Bearer header.
 *
 * This localhost server is discovered through an app-owned private lock and
 * an explicitly rendered MCP configuration. No ambient directory scan is used.
 */

import type { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js'
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'

import { AWP_IDE_TOOLS, dispatchAwpIdeTool } from './tools'
import { runWithConvId } from './request-context'
import {
  deleteLockFile,
  ensureIdeDir,
  type IdeLockInput,
  mintAuthToken,
  writeLockFile,
} from './lock-file'

// ---------------------------------------------------------------------------
// Module-level state — one server per Electron process
// ---------------------------------------------------------------------------

interface RunningServer {
  http: HttpServer
  host: string
  port: number
  token: string
  lockPath: string
  mcpServer: McpServer
}

let _running: RunningServer | null = null

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface StartOptions {
  /** Desktop package version, written into lock file for diagnostics. */
  desktopVersion: string
  /** Semantic loopback host (default 127.0.0.1). */
  host?: string
  /** Override port (default 0 = OS assigns). Tests may pin a port. */
  port?: number
  /** Authoritative Electron userData root for the private discovery lock. */
  appDataRoot?: string
}

export interface StartResult {
  port: number
  token: string
  url: string
  lockPath: string
}

/**
 * Start the awp-ide MCP server. Idempotent — calling twice returns
 * the existing instance. Hooks SIGINT/SIGTERM for graceful shutdown.
 */
export async function startAwpIdeServer(opts: StartOptions): Promise<StartResult> {
  if (_running) {
    return {
      port: _running.port,
      token: _running.token,
      url: buildAwpIdeUrl(_running.host, _running.port),
      lockPath: _running.lockPath,
    }
  }

  const host = normalizeAwpIdeLoopbackHost(opts.host ?? '127.0.0.1')
  const requestedPort = normalizeRequestedPort(opts.port ?? 0)

  // Validate and prepare the app-owned lock root before any socket is bound.
  // An unsafe or corrupt root therefore fails without opening a listener.
  ensureIdeDir(opts.appDataRoot)

  let mcpServer: McpServer | null = null
  let httpServer: HttpServer | null = null
  let lockPath: string | null = null

  try {
    // Dynamic import keeps the MCP SDK out of the cold-boot critical path.
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js')
    const { CallToolRequestSchema, ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js')
    const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js')

    const activeMcpServer = new Server(
      { name: 'awp-ide', version: opts.desktopVersion },
      { capabilities: { tools: {} } },
    )
    mcpServer = activeMcpServer

    activeMcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools: [...AWP_IDE_TOOLS] }
    })

    activeMcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
      const name = req.params?.name ?? ''
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>
      return dispatchAwpIdeTool(name, args)
    })

    const token = mintAuthToken()

    const activeHttpServer = createHttpServer(async (httpReq, httpRes) => {
      try {
        if (httpReq.url === '/' && httpReq.method === 'GET') {
          return writeJson(httpRes, 200, {
            name: 'awp-ide',
            version: opts.desktopVersion,
            mcp_endpoint: '/mcp',
            auth: 'Bearer required on /mcp',
          })
        }
        if (httpReq.url !== '/mcp' || httpReq.method !== 'POST') {
          return writeJson(httpRes, 404, { error: 'not_found' })
        }
        if (!checkAuth(httpReq, token)) {
          return writeJson(httpRes, 401, { error: 'unauthorized' })
        }

        // Bind the optional request context without emitting its identifier.
        // Older callers may omit the header and use the generic workspace.
        const rawConv = httpReq.headers['x-awp-conv']
        const convId = Array.isArray(rawConv) ? (rawConv[0] ?? '') : (rawConv ?? '')
        log('mcp_request_context', { conversation_present: Boolean(convId) })

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        })
        httpRes.on('close', () => {
          transport.close().catch(() => { /* */ })
        })
        await runWithConvId(convId, async () => {
          await activeMcpServer.connect(transport)
          await transport.handleRequest(httpReq, httpRes)
        })
      } catch (error) {
        log('http_handler_error', { error_kind: errorKind(error) })
        if (!httpRes.headersSent) {
          try {
            writeJson(httpRes, 500, { error: 'internal' })
          } catch { /* */ }
        }
      }
    })
    httpServer = activeHttpServer

    await listenHttpServer(activeHttpServer, requestedPort, host)
    const addr = activeHttpServer.address()
    const port = typeof addr === 'object' && addr ? addr.port : requestedPort
    const url = buildAwpIdeUrl(host, port)

    const lockPayload: IdeLockInput = {
      pid: process.pid,
      host,
      port,
      token,
      url,
      started_at: new Date().toISOString(),
      desktop_version: opts.desktopVersion,
    }
    lockPath = writeLockFile(lockPayload, opts.appDataRoot)

    _running = { http: activeHttpServer, host, port, token, lockPath, mcpServer: activeMcpServer }
    log('started', {
      host_family: host === '::1' ? 'ipv6' : 'ipv4',
      port,
      lock_created: true,
    })

    return { port, token, url, lockPath }
  } catch (error) {
    if (lockPath) {
      try {
        deleteLockFile(lockPath)
      } catch {
        log('startup_lock_cleanup_failed')
      }
    }
    if (httpServer) await closeHttpServerBounded(httpServer)
    if (mcpServer) await closeMcpServerBounded(mcpServer)
    _running = null
    throw error
  }
}

/**
 * Stop the awp-ide MCP server and clean up its lock file.
 * Idempotent — safe to call when not running.
 */
export async function stopAwpIdeServer(): Promise<void> {
  if (!_running) return
  const running = _running
  _running = null
  try {
    deleteLockFile(running.lockPath)
  } catch {
    log('lock_cleanup_failed')
  }
  await closeHttpServerBounded(running.http)
  await closeMcpServerBounded(running.mcpServer)
  log('stopped')
}

/**
 * Read-only accessor for diagnostics / IPC handlers that need to surface
 * server state in the UI ("MCP server: running on :51247").
 */
export function getServerInfo(): { running: boolean; url?: string; lockPath?: string } {
  if (!_running) return { running: false }
  return {
    running: true,
    url: buildAwpIdeUrl(_running.host, _running.port),
    lockPath: _running.lockPath,
  }
}

/**
 * Server URL + auth token, for mcp-config rendering. Returns null if the
 * server isn't running yet (caller falls back to a config without the
 * awp-ide entry).
 *
 * Intentionally exposes the token — mcp-config-renderer needs to embed
 * it in the generated JSON as a Bearer header. The mcp-config file
 * itself is mode 0600.
 */
export function getServerEndpoint(): { url: string; token: string } | null {
  if (!_running) return null
  return { url: buildAwpIdeUrl(_running.host, _running.port), token: _running.token }
}

/**
 * For tests + the future mcp-config.json generator. NOT exported for
 * runtime use; callers should consume the generated private MCP configuration.
 */
export function _internal_getToken(): string | null {
  return _running?.token ?? null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function normalizeAwpIdeLoopbackHost(input: string): string {
  if (typeof input !== 'string' || input !== input.trim() || !input) {
    throw new Error('awp_ide_host_not_loopback')
  }
  if (/[\s\\/@?#]/u.test(input)) throw new Error('awp_ide_host_not_loopback')
  if (input === '::1' || input === '[::1]') return '::1'

  const parts = input.split('.')
  if (parts.length !== 4) throw new Error('awp_ide_host_not_loopback')
  const octets = parts.map((part) => {
    if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(part)) throw new Error('awp_ide_host_not_loopback')
    const value = Number(part)
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new Error('awp_ide_host_not_loopback')
    }
    return value
  })
  if (octets[0] !== 127) throw new Error('awp_ide_host_not_loopback')
  return octets.join('.')
}

export function buildAwpIdeUrl(host: string, port: number): string {
  const canonicalHost = normalizeAwpIdeLoopbackHost(host)
  const canonicalPort = normalizeRequestedPort(port)
  if (canonicalPort === 0) throw new Error('awp_ide_port_invalid')
  const authority = canonicalHost === '::1' ? `[${canonicalHost}]` : canonicalHost
  return `http://${authority}:${canonicalPort}/mcp`
}

function normalizeRequestedPort(port: number): number {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('awp_ide_port_invalid')
  }
  return port
}

async function listenHttpServer(server: HttpServer, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    try {
      server.listen(port, host)
    } catch (error) {
      server.off('error', onError)
      server.off('listening', onListening)
      reject(error)
    }
  })
}

async function closeHttpServerBounded(server: HttpServer): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve()
    }
    timer = setTimeout(() => {
      try { server.closeAllConnections?.() } catch { /* */ }
      finish()
    }, 1_000)
    try {
      server.close(() => finish())
      server.closeIdleConnections?.()
      server.closeAllConnections?.()
    } catch {
      finish()
    }
  })
}

async function closeMcpServerBounded(server: McpServer): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      Promise.resolve(server.close?.()),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1_000)
      }),
    ])
  } catch {
    log('mcp_close_failed')
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function errorKind(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as NodeJS.ErrnoException).code
    if (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(code)) return code
    if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(error.name)) return error.name
  }
  return 'unknown'
}

function checkAuth(req: IncomingMessage, expected: string): boolean {
  const header = req.headers['authorization']
  if (typeof header !== 'string') return false
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match) return false
  const presented = match[1]
  // Constant-time compare: pad to equal length then xor-fold via Buffer.
  const a = Buffer.from(expected, 'utf-8')
  const b = Buffer.from(presented, 'utf-8')
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

function log(...args: unknown[]): void {
  // Mirror cc-mcp-local's logging style: stderr-only, never stdout (stdout
  // is reserved for clean test fixtures). In production this goes to the
  // Electron main process log via the default console transport.
  console.error('[awp-ide-server]', ...args)
}
