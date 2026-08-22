/**
 * Render the MCP configuration used by the embedded Agent CLI.
 *
 * Public default: one loopback-only `awp-ide` endpoint. A remote MCP entry is
 * accepted only when the caller and the operator both opt in. Nothing in this
 * module invents a host, token, provider, or model.
 */

import path from 'node:path'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { getAwpDir } from '../utils/config'

export interface McpHttpEndpoint {
  url: string
  token?: string
  conversationId?: string
  headers?: Record<string, string>
}

export interface RemoteMcpEndpoint extends McpHttpEndpoint {
  /** Stable MCP server name. Must not shadow the local awp-ide entry. */
  name: string
}

export interface McpConfigRenderOpts {
  /** Desktop-owned loopback MCP endpoint. Remote URLs are rejected here. */
  awpIde?: McpHttpEndpoint
  /**
   * Optional remote MCP endpoint. This is ignored unless BOTH this option and
   * AWP_AGENT_REMOTE_MCP_OPT_IN=1 are present.
   */
  remoteMcp?: RemoteMcpEndpoint
  allowRemoteMcp?: boolean
  /** Optional output override used by tests. */
  outputPath?: string
}

export interface McpConfigRenderResult {
  path: string
}

export interface McpHttpServerEntry {
  type: 'http'
  url: string
  headers: Record<string, string>
}

export interface McpConfigDoc {
  mcpServers: Record<string, McpHttpServerEntry>
}

function parseHttpUrl(raw: string): URL {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('invalid_mcp_url')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('unsupported_mcp_url_scheme')
  }
  if (parsed.username || parsed.password) {
    throw new Error('mcp_url_credentials_forbidden')
  }
  return parsed
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}

function endpointHeaders(endpoint: McpHttpEndpoint): Record<string, string> {
  const headers: Record<string, string> = { ...(endpoint.headers ?? {}) }
  if (endpoint.token) headers.authorization = `Bearer ${endpoint.token}`
  if (endpoint.conversationId) headers['x-awp-conv'] = endpoint.conversationId
  return headers
}

function validateRemoteName(name: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name) || name === 'awp-ide') {
    throw new Error('invalid_remote_mcp_name')
  }
}

export function buildMcpConfig(opts: McpConfigRenderOpts = {}): McpConfigDoc {
  const mcpServers: Record<string, McpHttpServerEntry> = {}

  if (opts.awpIde) {
    const parsed = parseHttpUrl(opts.awpIde.url)
    if (!isLoopbackHost(parsed.hostname)) {
      throw new Error('awp_ide_must_be_loopback')
    }
    mcpServers['awp-ide'] = {
      type: 'http',
      url: parsed.toString(),
      headers: endpointHeaders(opts.awpIde),
    }
  }

  if (opts.remoteMcp) {
    const operatorOptIn = process.env.AWP_AGENT_REMOTE_MCP_OPT_IN === '1'
    if (opts.allowRemoteMcp !== true || !operatorOptIn) {
      throw new Error('remote_mcp_requires_explicit_opt_in')
    }
    validateRemoteName(opts.remoteMcp.name)
    const parsed = parseHttpUrl(opts.remoteMcp.url)
    if (parsed.protocol !== 'https:' && !isLoopbackHost(parsed.hostname)) {
      throw new Error('remote_mcp_requires_https')
    }
    mcpServers[opts.remoteMcp.name] = {
      type: 'http',
      url: parsed.toString(),
      headers: endpointHeaders(opts.remoteMcp),
    }
  }

  return { mcpServers }
}

/**
 * Write the configuration through a same-directory temporary file, then rename
 * it into place. Readers therefore observe either the old complete document or
 * the new complete document, never a partially written token/header set.
 */
export function renderMcpConfig(opts: McpConfigRenderOpts = {}): McpConfigRenderResult {
  const doc = buildMcpConfig(opts)
  const outPath = opts.outputPath ?? path.join(getAwpDir(), 'agent-mcp-config.json')
  const parent = path.dirname(outPath)
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true })

  const tempPath = path.join(parent, `.${path.basename(outPath)}.${randomUUID()}.tmp`)
  try {
    writeFileSync(tempPath, JSON.stringify(doc, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    })
    renameSync(tempPath, outPath)
    try {
      chmodSync(outPath, 0o600)
    } catch {
      // Windows permissions are governed by the user's profile ACL.
    }
  } finally {
    try {
      if (existsSync(tempPath)) rmSync(tempPath, { force: true })
    } catch {
      // Best-effort cleanup; a complete destination is already in place.
    }
  }

  return { path: outPath }
}
