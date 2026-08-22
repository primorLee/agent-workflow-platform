/**
 * Central builder for HTTP headers that every AgentWorkflowPlatform Desktop request must
 * send — both the JSON/blob/form paths in `src/api/client.ts` and the SSE
 * path in `src/api/sse.ts`. Keeping this in one place prevents SSE from
 * silently bypassing the client-version / capabilities advertisement
 * (finding from Phase 0 audit: sse.ts:18-21 was building headers inline).
 *
 * Headers currently emitted:
 *   - `X-AgentWorkflowPlatform-Client-Version`: pinned build version from `pkg.version`
 *     via vite define `__APP_VERSION__`. Cloud uses this to gate legacy
 *     endpoints / warn on outdated clients.
 *   - `X-AgentWorkflowPlatform-Capabilities`: comma-separated list of optional client
 *     capabilities (e.g. `cc-local`, `sim-local`). Empty in Phase 1 — Cloud
 *     treats a missing/blank header as legacy and serves the current
 *     behaviour. Phase 2 will populate this when CC-local shipping begins.
 *   - `Authorization`: bearer token, appended when provided.
 *
 * Anything protocol-specific (Content-Type, Accept, X-CSRF-Token) stays with
 * the caller — this helper is intentionally the common prefix, not a god
 * function.
 */

export function buildCommonHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    'X-AgentWorkflowPlatform-Client-Version': resolveVersion(),
  }
  const caps = buildCapabilities()
  if (caps) h['X-AgentWorkflowPlatform-Capabilities'] = caps
  if (token) h['Authorization'] = `Bearer ${token}`
  return h
}

function resolveVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = (globalThis as any).__APP_VERSION__
    if (typeof v === 'string' && v.length > 0) return v
  } catch {
    /* not defined in this context — e.g. raw node test runner */
  }
  // Fall back to the declared global (vite injects this; tests may redeclare).
  if (typeof __APP_VERSION__ === 'string' && __APP_VERSION__.length > 0) {
    return __APP_VERSION__
  }
  return 'unknown'
}

/**
 * Advertise the local Agent CLI capability only after the main process has
 * confirmed an explicitly configured external or managed executable.
 */
function buildCapabilities(): string {
  if (typeof window === 'undefined') return ''
  const runtimeReady = (window as unknown as {
    __CC_LOCAL_RUNTIME_AVAILABLE?: boolean
  }).__CC_LOCAL_RUNTIME_AVAILABLE === true
  return runtimeReady ? 'cc-on-desktop' : ''
}
