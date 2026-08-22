/**
 * Unit tests for the central HTTP header builder (T-A014).
 *
 * Validates that every Desktop HTTP/SSE request gets the same
 * X-AgentWorkflowPlatform-Client-Version + (future) X-AgentWorkflowPlatform-Capabilities, and that
 * the bearer token is only appended when provided.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Provide __APP_VERSION__ on globalThis BEFORE importing the module —
// vite defines this in production bundles; in vitest we inject it.
beforeEach(() => {
  ;(globalThis as unknown as Record<string, unknown>).__APP_VERSION__ = '1.6.6'
  vi.resetModules()
})

describe('buildCommonHeaders', () => {
  it('sets X-AgentWorkflowPlatform-Client-Version from __APP_VERSION__', async () => {
    const { buildCommonHeaders } = await import('../buildCommonHeaders')
    const h = buildCommonHeaders()
    expect(h['X-AgentWorkflowPlatform-Client-Version']).toBe('1.6.6')
  })

  it('bearer header is optional — omitted when token absent', async () => {
    const { buildCommonHeaders } = await import('../buildCommonHeaders')
    const h = buildCommonHeaders()
    expect(h['Authorization']).toBeUndefined()
  })

  it('bearer header is added when token provided', async () => {
    const { buildCommonHeaders } = await import('../buildCommonHeaders')
    const h = buildCommonHeaders('abc.def.ghi')
    expect(h['Authorization']).toBe('Bearer abc.def.ghi')
  })

  it('X-AgentWorkflowPlatform-Capabilities is empty (absent) in Phase 1', async () => {
    const { buildCommonHeaders } = await import('../buildCommonHeaders')
    const h = buildCommonHeaders('tok')
    // Phase 1 contract: Cloud treats missing header as legacy. When Phase 2
    // ships CC-local, this test will flip to expect a non-empty string.
    expect(h['X-AgentWorkflowPlatform-Capabilities']).toBeUndefined()
  })

  it('falls back to "unknown" when __APP_VERSION__ is undefined', async () => {
    delete (globalThis as unknown as Record<string, unknown>).__APP_VERSION__
    const { buildCommonHeaders } = await import('../buildCommonHeaders')
    const h = buildCommonHeaders()
    expect(h['X-AgentWorkflowPlatform-Client-Version']).toBe('unknown')
  })
})
