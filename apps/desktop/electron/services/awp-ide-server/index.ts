/**
 * Public entry for the awp-ide MCP server module.
 *
 * Wired into electron/services/index.ts's startServices/stopServices
 * lifecycle in a separate edit. Importing from elsewhere should only
 * use the named exports below — internal modules (lock-file, tools,
 * mcp-config) are implementation details.
 */

export {
  startAwpIdeServer,
  stopAwpIdeServer,
  getServerInfo,
  getServerEndpoint,
  type StartOptions,
  type StartResult,
} from './server'

export {
  buildIdeOnlyConfig,
  defaultMcpConfigPath,
  writeMcpConfig,
  type McpConfig,
  type BuildIdeOnlyOpts,
} from './mcp-config'

export { AWP_IDE_TOOLS } from './tools'

export {
  ideDir,
  type IdeLockPayload,
} from './lock-file'
