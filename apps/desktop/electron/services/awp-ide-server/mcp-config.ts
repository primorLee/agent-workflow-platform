/**
 * Builds the local awp-ide MCP configuration consumed by a compatible
 * Agent CLI. This module intentionally composes no remote services and reads
 * no provider credentials. The localhost bearer token protects only the
 * per-process awp-ide endpoint, so the generated file is written mode 0600.
 */

import { writeFileSync, chmodSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

export interface McpConfig {
  mcpServers: Record<string, {
    type: 'http'
    url: string
    headers: Record<string, string>
  }>
}

export interface BuildIdeOnlyOpts {
  /** http://127.0.0.1:<port>/mcp */
  ideUrl: string
  /** Bearer token for the awp-ide MCP server */
  ideToken: string
}

/**
 * Build a strict local-only awp-ide configuration. External adapters must
 * be configured separately and are never injected by this module.
 */
export function buildIdeOnlyConfig(opts: BuildIdeOnlyOpts): McpConfig {
  return {
    mcpServers: {
      'awp-ide': {
        type: 'http',
        url: opts.ideUrl,
        headers: {
          authorization: `Bearer ${opts.ideToken}`,
        },
      },
    },
  }
}

/**
 * Default location: ~/.awp/awp-ide-mcp-config.json. The compatible CLI's
 * `--mcp-config` argv points here. Re-written every time the awp-ide
 * server starts (port changes between launches).
 */
export function defaultMcpConfigPath(): string {
  return join(homedir(), '.awp', 'awp-ide-mcp-config.json')
}

export function writeMcpConfig(config: McpConfig, path = defaultMcpConfigPath()): string {
  const dir = dirname(path)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600, encoding: 'utf-8' })
  try {
    chmodSync(path, 0o600)
  } catch {
    // best-effort, Windows
  }
  return path
}
