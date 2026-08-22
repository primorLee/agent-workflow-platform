/** Generic cloud artifact tool schemas and dispatch. */

import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { CloudApiError, CloudClient } from './api-client'

export const CLOUD_TOOLS: readonly Tool[] = [
  {
    name: 'cloud_read_file',
    description: 'Read a project artifact. Text is returned as UTF-8; binary data is returned as base64.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['path'],
      properties: { path: { type: 'string', description: 'Virtual project path.' } },
    },
  },
  {
    name: 'cloud_write_file',
    description: 'Create or replace a UTF-8 project artifact.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['path', 'content'],
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        content_type: { type: 'string', default: 'text/plain' },
      },
    },
  },
  {
    name: 'cloud_delete_file',
    description: 'Delete a project artifact.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['path'],
      properties: { path: { type: 'string' } },
    },
  },
  {
    name: 'cloud_list_files',
    description: 'List artifact metadata below a virtual path prefix.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        prefix: { type: 'string', default: '/' },
        limit: { type: 'integer', default: 200, minimum: 1, maximum: 1000 },
      },
    },
  },
  {
    name: 'cloud_search_files',
    description: 'Search text artifacts and return matching paths and lines.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['q'],
      properties: {
        q: { type: 'string' },
        limit: { type: 'integer', default: 50, minimum: 1, maximum: 200 },
      },
    },
  },
  {
    name: 'cloud_stat_file',
    description: 'Read artifact metadata without downloading its content.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['path'],
      properties: { path: { type: 'string' } },
    },
  },
] as const

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

let client: CloudClient | null = null
function getClient(): CloudClient {
  return (client ??= new CloudClient())
}

export function initializeCloudToolClient(): void {
  const configured = new CloudClient()
  configured.assertReady()
  client = configured
}

export function _setClientForTesting(value: CloudClient | null): void {
  client = value
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} is required`)
  return value
}

function ok(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

function failed(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

export async function dispatchCloudTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    switch (name) {
      case 'cloud_read_file':
        return ok(await getClient().getFile(requiredString(args, 'path')))
      case 'cloud_write_file':
        return ok(await getClient().putFile(
          requiredString(args, 'path'),
          requiredString(args, 'content'),
          typeof args.content_type === 'string' ? args.content_type : 'text/plain',
        ))
      case 'cloud_delete_file':
        return ok(await getClient().deleteFile(requiredString(args, 'path')))
      case 'cloud_list_files':
        return ok(await getClient().listFiles(
          typeof args.prefix === 'string' ? args.prefix : '/',
          typeof args.limit === 'number' ? args.limit : 200,
        ))
      case 'cloud_search_files':
        return ok(await getClient().searchFiles(
          requiredString(args, 'q'),
          typeof args.limit === 'number' ? args.limit : 50,
        ))
      case 'cloud_stat_file':
        return ok(await getClient().statFile(requiredString(args, 'path')))
      default:
        return failed(`unknown tool: ${name}`)
    }
  } catch (error) {
    if (error instanceof CloudApiError) {
      return failed(`cloud api error ${error.status}: ${error.detail}`)
    }
    return failed(error instanceof Error ? error.message : String(error))
  }
}