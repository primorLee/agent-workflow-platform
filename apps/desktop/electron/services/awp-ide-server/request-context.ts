/**
 * Per-request conversation context for the loopback awp-ide MCP server.
 * AsyncLocalStorage keeps concurrent request metadata isolated across awaits;
 * no filesystem, command, or remote-workspace capability is implied here.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export interface IdeRequestContext {
  /** Conversation id from the request header, or an empty string when absent. */
  convId: string
}

const ALS_KEY = '__awp_ide_request_als__'
const globalContext = globalThis as unknown as Record<
  string,
  AsyncLocalStorage<IdeRequestContext> | undefined
>
const context = globalContext[ALS_KEY]
  ?? (globalContext[ALS_KEY] = new AsyncLocalStorage<IdeRequestContext>())

/** Run a callback with request-local conversation metadata. */
export function runWithConvId<T>(convId: string | undefined | null, fn: () => T): T {
  return context.run({ convId: typeof convId === 'string' ? convId : '' }, fn)
}

/** Return the request-local conversation id, or an empty string outside a request. */
export function getCurrentConvId(): string {
  return context.getStore()?.convId ?? ''
}