import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  removeHandler: vi.fn((channel: string) => state.handlers.delete(channel)),
  handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
    state.handlers.set(channel, handler)
  }),
  checkAndUpdate: vi.fn(),
  getCliPath: vi.fn(),
  getProgress: vi.fn(),
  getStatusSnapshot: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: state.removeHandler,
    handle: state.handle,
  },
}))

vi.mock('../cc-runtime-updater', () => ({
  checkAndUpdate: state.checkAndUpdate,
  getCliPath: state.getCliPath,
  getProgress: state.getProgress,
  getStatusSnapshot: state.getStatusSnapshot,
}))

vi.mock('../../utils/logger', () => ({ log: vi.fn() }))

import { registerCcRuntimeHandlers } from '../cc-runtime-handlers'

beforeEach(() => {
  delete process.env.AWP_AGENT_RUNTIME_FORCE_UPDATE_OPT_IN
  state.handlers.clear()
  state.removeHandler.mockClear()
  state.handle.mockClear()
  state.checkAndUpdate.mockReset()
  state.getCliPath.mockReset()
  state.getProgress.mockReset()
  state.getStatusSnapshot.mockReset()
  state.getStatusSnapshot.mockReturnValue({
    currentVersion: null,
    lastCheckMs: 0,
    lastUpdateMs: 0,
    updating: false,
    available: false,
    source: 'disabled',
  })
  state.getCliPath.mockReturnValue(null)
  state.getProgress.mockReturnValue({
    stage: 'idle',
    bytesDownloaded: 0,
    bytesTotal: 0,
    version: null,
  })
  state.checkAndUpdate.mockResolvedValue({ updated: false })
})

afterEach(() => {
  delete process.env.AWP_AGENT_RUNTIME_FORCE_UPDATE_OPT_IN
})

function invoke(channel: string): unknown {
  const handler = state.handlers.get(channel)
  if (!handler) throw new Error(`missing handler: ${channel}`)
  return handler()
}

describe('cc runtime renderer contract', () => {
  it('registers only the provider-neutral runtime status/update surfaces', () => {
    registerCcRuntimeHandlers()

    expect([...state.handlers.keys()].sort()).toEqual([
      'bridge:cc-runtime-progress',
      'cc-runtime:check-now',
      'cc-runtime:force-update',
      'cc-runtime:get-cli-path',
      'cc-runtime:status',
    ])
    expect(state.handlers.has('cc-runtime:cli-local-env')).toBe(false)
    expect(invoke('cc-runtime:status')).toEqual({
      currentVersion: null,
      lastCheckMs: 0,
      lastUpdateMs: 0,
      updating: false,
      available: false,
      source: 'disabled',
    })
    expect(invoke('cc-runtime:get-cli-path')).toBeNull()
    expect(invoke('bridge:cc-runtime-progress')).toMatchObject({ stage: 'idle' })
  })

  it('checks an explicitly configured managed feed without forcing', async () => {
    registerCcRuntimeHandlers()
    await expect(invoke('cc-runtime:check-now')).resolves.toEqual({ updated: false })
    expect(state.checkAndUpdate).toHaveBeenCalledWith({ force: false })
  })

  it('requires a separate operator opt-in before a forced update', async () => {
    registerCcRuntimeHandlers()

    await expect(invoke('cc-runtime:force-update')).resolves.toEqual({
      updated: false,
      error: 'force_update_requires_explicit_opt_in',
    })
    expect(state.checkAndUpdate).not.toHaveBeenCalled()

    process.env.AWP_AGENT_RUNTIME_FORCE_UPDATE_OPT_IN = '1'
    await expect(invoke('cc-runtime:force-update')).resolves.toEqual({ updated: false })
    expect(state.checkAndUpdate).toHaveBeenCalledWith({ force: true })
  })

  it('is idempotent across main-process soft restarts', () => {
    registerCcRuntimeHandlers()
    registerCcRuntimeHandlers()
    expect(state.handlers.size).toBe(5)
    expect(state.removeHandler).toHaveBeenCalledTimes(10)
  })
})