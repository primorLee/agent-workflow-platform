/** Encrypted-only authorization-header boundary. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  secureGet: vi.fn(),
  exists: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  mkdir: vi.fn(),
}))

vi.mock('node:fs', () => {
  const mocked = {
    existsSync: state.exists,
    readFileSync: state.read,
    writeFileSync: state.write,
    mkdirSync: state.mkdir,
  }
  return { ...mocked, default: mocked }
})
vi.mock('../credentials', () => ({
  secureGetCredential: state.secureGet,
  secureSetCredential: vi.fn(),
  secureDeleteCredential: vi.fn(),
}))
vi.mock('../logger', () => ({ log: vi.fn(), logError: vi.fn() }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  process.env.AWP_HOSTED_AUTH_OPT_IN = '1'
  state.secureGet.mockResolvedValue({ ok: true, value: undefined })
})

afterEach(() => {
  delete process.env.AWP_HOSTED_AUTH_OPT_IN
})

describe('getAuthHeaders encrypted-only boundary', () => {
  it.each([undefined, '', '0', 'true', 'yes'])('performs zero credential and filesystem reads unless hosted auth is exact 1: %s', async (flag) => {
    if (flag === undefined) delete process.env.AWP_HOSTED_AUTH_OPT_IN
    else process.env.AWP_HOSTED_AUTH_OPT_IN = flag
    state.secureGet.mockResolvedValue({ ok: true, value: 'synthetic_value' })
    state.exists.mockReturnValue(true)

    const { getAuthHeaders } = await import('../config')
    await expect(getAuthHeaders()).resolves.toEqual({})
    expect(state.secureGet).not.toHaveBeenCalled()
    expect(state.exists).not.toHaveBeenCalled()
    expect(state.read).not.toHaveBeenCalled()
  })

  it('returns a bearer header only from encrypted storage', async () => {
    state.secureGet.mockResolvedValue({ ok: true, value: '  synthetic_value  ' })
    const { getAuthHeaders } = await import('../config')
    await expect(getAuthHeaders()).resolves.toEqual({ Authorization: 'Bearer synthetic_value' })
    expect(state.secureGet).toHaveBeenCalledWith('auth_token')
    expect(state.exists).not.toHaveBeenCalled()
    expect(state.read).not.toHaveBeenCalled()
  })

  it.each([
    { ok: true, value: undefined },
    { ok: true, value: '' },
    { ok: true, value: '   ' },
    { ok: false, error: 'encryption_unavailable' },
    { ok: false, error: 'decryption_failed' },
  ])('fails closed without reading legacy auth metadata: $error$value', async (result) => {
    state.secureGet.mockResolvedValue(result)
    state.exists.mockReturnValue(true)
    state.read.mockReturnValue(JSON.stringify({ token: 'legacy_plain_value' }))
    const { getAuthHeaders } = await import('../config')

    await expect(getAuthHeaders()).resolves.toEqual({})
    expect(state.exists).not.toHaveBeenCalled()
    expect(state.read).not.toHaveBeenCalled()
  })

  it('fails closed when encrypted storage throws', async () => {
    state.secureGet.mockRejectedValue(new Error('synthetic keychain failure'))
    state.exists.mockReturnValue(true)
    const { getAuthHeaders } = await import('../config')

    await expect(getAuthHeaders()).resolves.toEqual({})
    expect(state.exists).not.toHaveBeenCalled()
    expect(state.read).not.toHaveBeenCalled()
  })
})