/** Hosted credential migration and IPC gating regression tests. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type HandlerFn = (event: unknown, ...args: unknown[]) => Promise<unknown>

const state = vi.hoisted(() => ({
  handlers: {} as Record<string, HandlerFn>,
  secureSet: vi.fn(),
  secureGet: vi.fn(),
  secureDelete: vi.fn(),
  encryptedAvailable: vi.fn(),
  readLegacy: vi.fn(),
  removeLegacy: vi.fn(),
  replaceLegacy: vi.fn(),
  exists: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  unlink: vi.fn(),
  send: vi.fn(),
  log: vi.fn(),
  logError: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: HandlerFn) => {
      state.handlers[channel] = handler
    }),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [{ isDestroyed: () => false, webContents: { send: state.send } }]),
  },
  dialog: { showMessageBoxSync: vi.fn(), showErrorBox: vi.fn() },
  clipboard: { writeText: vi.fn(), readText: vi.fn(() => '') },
  shell: { openExternal: vi.fn() },
}))

vi.mock('node:fs', () => {
  const mocked = {
    existsSync: state.exists,
    readFileSync: state.read,
    writeFileSync: state.write,
    unlinkSync: state.unlink,
  }
  return { ...mocked, default: mocked }
})

vi.mock('../../utils/logger', () => ({ log: state.log, logError: state.logError }))
vi.mock('../../utils/config', () => ({
  getAwpDir: () => 'C:\\Users\\Example\\AppData\\Roaming\\awp',
  getSshKeyPath: () => 'C:\\Users\\Example\\AppData\\Roaming\\awp\\private\\keys\\awp_vm_key',
  getAuthPath: () => 'C:\\Users\\Example\\AppData\\Roaming\\awp\\auth.json',
  getCustomerIdPath: () => 'C:\\Users\\Example\\AppData\\Roaming\\awp\\customer_id',
  ensureAwpDir: vi.fn(),
}))
vi.mock('../../utils/credentials', () => ({
  secureSetCredential: state.secureSet,
  secureGetCredential: state.secureGet,
  secureDeleteCredential: state.secureDelete,
}))
vi.mock('../../utils/safe-storage-compat', () => ({
  isEncryptedStorage: state.encryptedAvailable,
}))
vi.mock('../../utils/legacy-auth-migration', () => ({
  readLegacyAuthFile: state.readLegacy,
  removeLegacyAuthFile: state.removeLegacy,
  replaceLegacyAuthFile: state.replaceLegacy,
}))
vi.mock('../../bridge/ssh-connect', () => ({ attachHostVerifier: vi.fn() }))

async function loadHandlers() {
  vi.resetModules()
  return await import('../handlers')
}

beforeEach(() => {
  process.env.AWP_HOSTED_AUTH_OPT_IN = '1'
  for (const key of Object.keys(state.handlers)) delete state.handlers[key]
  vi.clearAllMocks()
  state.encryptedAvailable.mockReturnValue(true)
  state.readLegacy.mockReturnValue(null)
  state.secureSet.mockResolvedValue({ ok: true })
  state.secureGet.mockResolvedValue({ ok: true, value: undefined })
  state.secureDelete.mockResolvedValue({ ok: true })
  state.exists.mockReturnValue(false)
  state.read.mockReturnValue('{}')
})

afterEach(() => {
  delete process.env.AWP_HOSTED_AUTH_OPT_IN
})

describe('strict hosted credential migration', () => {
  it('encrypts a validated legacy API token before removing the legacy file', async () => {
    const mod = await loadHandlers()
    const record = { path: 'legacy-api-token', buffer: Buffer.from('synthetic_value'), stat: {} }
    state.readLegacy.mockReturnValueOnce(record)

    await mod.migratePlaintextApiToken()

    expect(state.secureSet).toHaveBeenCalledWith('auth_token', 'synthetic_value')
    expect(state.removeLegacy).toHaveBeenCalledWith(record)
    expect(state.secureSet.mock.invocationCallOrder[0]).toBeLessThan(state.removeLegacy.mock.invocationCallOrder[0])
    expect(JSON.stringify(state.log.mock.calls)).not.toContain('synthetic_value')
  })

  it('does not inspect legacy files when encrypted storage is unavailable', async () => {
    state.encryptedAvailable.mockReturnValue(false)
    const mod = await loadHandlers()

    await mod.migratePlaintextApiToken()

    expect(state.readLegacy).not.toHaveBeenCalled()
    expect(state.secureSet).not.toHaveBeenCalled()
    expect(state.removeLegacy).not.toHaveBeenCalled()
    expect(state.send).toHaveBeenCalledWith('credentials:migration-failed', {
      kind: 'plaintext_api_token',
      errorKind: 'encryption_unavailable',
    })
  })

  it('preserves the validated legacy file when encrypted storage rejects the write', async () => {
    const record = { path: 'legacy-api-token', buffer: Buffer.from('synthetic_value'), stat: {} }
    state.readLegacy.mockReturnValueOnce(record)
    state.secureSet.mockResolvedValueOnce({ ok: false, error: 'encryption_unavailable' })
    const mod = await loadHandlers()

    await mod.migratePlaintextApiToken()

    expect(state.removeLegacy).not.toHaveBeenCalled()
    expect(state.send).toHaveBeenCalledWith('credentials:migration-failed', {
      kind: 'plaintext_api_token',
      errorKind: 'encryption_unavailable',
    })
  })

  it('strips a legacy metadata token only after encrypted storage succeeds', async () => {
    const record = {
      path: 'legacy-auth-json',
      buffer: Buffer.from(JSON.stringify({ token: 'synthetic_value', customer_id: 'tenant_ref', email: 'local@example.invalid' })),
      stat: {},
    }
    state.readLegacy.mockImplementation((_root: string, name: string) => name === 'auth.json' ? record : null)
    const mod = await loadHandlers()
    mod.registerIpcHandlers()
    await vi.waitFor(() => expect(state.replaceLegacy).toHaveBeenCalled())

    expect(state.secureSet).toHaveBeenCalledWith('auth_token', 'synthetic_value')
    const replacement = String(state.replaceLegacy.mock.calls[0]?.[1])
    expect(replacement).not.toContain('synthetic_value')
    expect(JSON.parse(replacement)).toEqual({
      customer_id: 'tenant_ref',
      email: 'local@example.invalid',
      migrated: true,
    })
  })
})

describe('hosted credential IPC boundary', () => {
  it.each([undefined, '', '0', 'true', '01'])('performs zero credential and legacy-file I/O for opt-in=%s', async (flag) => {
    if (flag === undefined) delete process.env.AWP_HOSTED_AUTH_OPT_IN
    else process.env.AWP_HOSTED_AUTH_OPT_IN = flag
    const mod = await loadHandlers()
    mod.registerIpcHandlers()
    await Promise.resolve()

    expect(await state.handlers['bridge:save-token']?.({}, 'synthetic_value')).toBe(false)
    expect(await state.handlers['bridge:save-auth']?.({}, 'synthetic_value', 'tenant_ref', 'local@example.invalid')).toBe(false)
    expect(await state.handlers['bridge:get-auth']?.({})).toBeNull()
    expect(state.readLegacy).not.toHaveBeenCalled()
    expect(state.removeLegacy).not.toHaveBeenCalled()
    expect(state.replaceLegacy).not.toHaveBeenCalled()
    expect(state.secureGet).not.toHaveBeenCalled()
    expect(state.secureSet).not.toHaveBeenCalled()
    expect(state.secureDelete).not.toHaveBeenCalled()
    expect(state.exists).not.toHaveBeenCalled()
    expect(state.read).not.toHaveBeenCalled()
    expect(state.write).not.toHaveBeenCalled()
    expect(state.unlink).not.toHaveBeenCalled()
  })

  it('never falls back to a token in legacy metadata', async () => {
    state.exists.mockReturnValue(true)
    state.read.mockReturnValue(JSON.stringify({ token: 'legacy_plain_value', customer_id: 'tenant_ref' }))
    state.secureGet.mockResolvedValue({ ok: false, error: 'decryption_failed' })
    const mod = await loadHandlers()
    mod.registerIpcHandlers()

    const result = await state.handlers['bridge:get-auth']?.({}) as Record<string, unknown>
    expect(result.token).toBe('')
    expect(result.customer_id).toBe('tenant_ref')
    expect(result.credential_error).toBe('decryption_failed')
    expect(JSON.stringify(result)).not.toContain('legacy_plain_value')
  })

  it('writes through encrypted storage and removes only a validated legacy token', async () => {
    const record = { path: 'legacy-api-token', buffer: Buffer.from('legacy_value'), stat: {} }
    state.readLegacy.mockImplementation((_root: string, name: string) => name === 'api_token' ? record : null)
    const mod = await loadHandlers()
    mod.registerIpcHandlers()

    expect(await state.handlers['bridge:save-token']?.({}, 'synthetic_value')).toBe(true)
    expect(state.secureSet).toHaveBeenCalledWith('auth_token', 'synthetic_value')
    expect(state.removeLegacy).toHaveBeenCalledWith(record)
  })

  it('does not inspect or remove a legacy token when encrypted storage rejects the save', async () => {
    state.secureSet.mockResolvedValueOnce({ ok: false, error: 'encryption_unavailable' })
    const mod = await loadHandlers()
    mod.registerIpcHandlers()
    await Promise.resolve()
    state.readLegacy.mockClear()
    state.removeLegacy.mockClear()

    expect(await state.handlers['bridge:save-token']?.({}, 'synthetic_value')).toBe(false)
    expect(state.readLegacy).not.toHaveBeenCalled()
    expect(state.removeLegacy).not.toHaveBeenCalled()
  })
})