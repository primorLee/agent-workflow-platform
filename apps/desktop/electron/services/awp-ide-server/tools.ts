/** Minimal, real desktop-side MCP tools exposed to a compatible Agent CLI. */
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { BrowserWindow } from 'electron'

export const AWP_IDE_TOOLS: readonly Tool[] = [
  {
    name: 'awp_notify_user',
    description: 'Display a short non-blocking desktop notification.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['message'],
      properties: {
        message: { type: 'string' },
        level: { type: 'string', enum: ['info', 'success', 'warning', 'error'] },
        duration_ms: { type: 'number' },
      },
    },
  },
] as const

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

async function dispatchInner(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (name !== 'awp_notify_user') return errorResult(`unknown tool: ${name}`)
  const message = typeof args.message === 'string' ? args.message.slice(0, 200) : ''
  if (!message) return errorResult('message is required')
  const level = ['info', 'success', 'warning', 'error'].includes(String(args.level))
    ? String(args.level)
    : 'info'
  const duration = Number.isFinite(args.duration_ms)
    ? Math.max(1_000, Math.min(30_000, Number(args.duration_ms)))
    : 5_000
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      window.webContents.send('awp-ide:notify-user', {
        message,
        level,
        duration_ms: duration,
      })
    } catch {
      // A window may close while the notification is being broadcast.
    }
  }
  return okResult({ notified: true })
}

export async function dispatchAwpIdeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    // Local traces remain exact opt-in and scrubbed by the trace collector.
    const { wrapDispatch } = require('../trace-collector') as typeof import('../trace-collector')
    return wrapDispatch(name, args, () => dispatchInner(name, args))
  } catch {
    return dispatchInner(name, args)
  }
}

function okResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
}
