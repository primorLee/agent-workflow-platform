// @vitest-environment node
/**
 * Per-conversation request context (AsyncLocalStorage) — lock-in for the
 * "对话串了" root-cause fix (2026-06-01).
 *
 * server.ts binds the `x-awp-conv` header into this context for the
 * duration of each MCP request; vm-exec-runner reads it via getCurrentConvId()
 * to scope the VM workspace per conversation. The two invariants that matter:
 *
 *   1. Inside a runWithConvId(id, …) scope, getCurrentConvId() === id — even
 *      across awaits and even when two scopes run concurrently (the whole
 *      point of ALS over a module global).
 *   2. Outside any scope, getCurrentConvId() === '' so callers degrade to the
 *      tenant-scoped workdir (backward-compat / never throw).
 */

import { describe, it, expect } from 'vitest'
import { runWithConvId, getCurrentConvId } from '../request-context'

describe('ide request-context (AsyncLocalStorage)', () => {
  it('returns "" outside any run scope', () => {
    expect(getCurrentConvId()).toBe('')
  })

  it('returns the bound convId inside a run scope', () => {
    const seen = runWithConvId('conv-abc123', () => getCurrentConvId())
    expect(seen).toBe('conv-abc123')
  })

  it('reverts to "" after the scope ends', () => {
    runWithConvId('conv-xyz', () => getCurrentConvId())
    expect(getCurrentConvId()).toBe('')
  })

  it('carries the value across awaits', async () => {
    const seen = await runWithConvId('conv-async', async () => {
      await Promise.resolve()
      await new Promise((r) => setTimeout(r, 1))
      return getCurrentConvId()
    })
    expect(seen).toBe('conv-async')
  })

  it('keeps concurrent scopes isolated (no cross-talk)', async () => {
    // Interleave two scopes; each must observe only its own id despite the
    // shared module. A plain `let current` would fail this.
    const run = (id: string, delay: number): Promise<string> =>
      runWithConvId(id, async () => {
        await new Promise((r) => setTimeout(r, delay))
        return getCurrentConvId()
      })
    const [a, b] = await Promise.all([run('conv-A', 5), run('conv-B', 1)])
    expect(a).toBe('conv-A')
    expect(b).toBe('conv-B')
  })

  it('normalises undefined/null convId to ""', () => {
    expect(runWithConvId(undefined, () => getCurrentConvId())).toBe('')
    expect(runWithConvId(null, () => getCurrentConvId())).toBe('')
  })
})
