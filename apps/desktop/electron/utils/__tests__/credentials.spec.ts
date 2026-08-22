import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const H = vi.hoisted(() => ({ root: '' }))
const safeStorageMock = {
  isEncryptionAvailable: vi.fn<() => boolean>(),
  encryptString: vi.fn<(value: string) => Buffer>(),
  decryptString: vi.fn<(value: Buffer) => string>(),
}
const logMock = vi.fn()

vi.mock('electron', () => ({ safeStorage: safeStorageMock }))
vi.mock('../logger', () => ({ log: logMock, logError: vi.fn() }))
vi.mock('../config', () => ({ getAwpDir: () => H.root }))

function storePath(): string {
  return path.join(H.root, 'private', 'credentials', 'store.json')
}

function privateRoot(): string {
  return path.join(H.root, 'private')
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  H.root = mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'awp-credentials-'))
  safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
  safeStorageMock.encryptString.mockImplementation((value) => Buffer.from(`sealed:${value}`, 'utf8'))
  safeStorageMock.decryptString.mockImplementation((value) => value.toString('utf8').replace(/^sealed:/u, ''))
})

afterEach(() => {
  if (H.root) rmSync(H.root, { recursive: true, force: true })
})

describe('encrypted credential storage', () => {
  it.each(['auth_token', 'sshPassword'])('has zero filesystem side effects for unavailable encryption: %s', async (key) => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const { secureGetCredential, secureSetCredential } = await import('../credentials')

    await expect(secureSetCredential(key, 'seeded-secret')).resolves.toEqual({
      ok: false,
      error: 'encryption_unavailable',
    })
    await expect(secureGetCredential(key)).resolves.toEqual({
      ok: false,
      error: 'encryption_unavailable',
    })
    expect(existsSync(privateRoot())).toBe(false)
    expect(safeStorageMock.encryptString).not.toHaveBeenCalled()
  })

  it('has zero filesystem side effects when OS encryption throws', async () => {
    safeStorageMock.encryptString.mockImplementation(() => {
      throw new Error('secret-bearing keychain error')
    })
    const { secureSetCredential } = await import('../credentials')
    await expect(secureSetCredential('auth_token', 'seeded-secret')).resolves.toEqual({
      ok: false,
      error: 'encryption_unavailable',
    })
    expect(existsSync(privateRoot())).toBe(false)
    expect(logMock.mock.calls.flat().join(' ')).not.toContain('seeded-secret')
  })

  it('round-trips both allow-listed credential classes in a marked private store', async () => {
    const { secureGetCredential, secureSetCredential } = await import('../credentials')
    expect(await secureSetCredential('auth_token', 'hosted-secret')).toEqual({ ok: true })
    expect(await secureSetCredential('sshPassword', 'ssh-secret')).toEqual({ ok: true })
    expect(await secureGetCredential('auth_token')).toEqual({ ok: true, value: 'hosted-secret' })
    expect(await secureGetCredential('sshPassword')).toEqual({ ok: true, value: 'ssh-secret' })

    const stored = JSON.parse(readFileSync(storePath(), 'utf8')) as Record<string, unknown>
    expect(stored).toMatchObject({ schema: 'awp-encrypted-credentials', version: 1 })
    expect(readFileSync(path.join(privateRoot(), '.awp-private-root.json'), 'utf8')).toContain(
      'awp-private-storage-root',
    )
    expect(readFileSync(storePath(), 'utf8')).not.toContain('hosted-secret')
    expect(readFileSync(storePath(), 'utf8')).not.toContain('ssh-secret')
  })

  it('serializes concurrent writes without losing entries', async () => {
    const { secureGetCredential, secureSetCredential } = await import('../credentials')
    const entries = Array.from({ length: 8 }, (_, index) => [`key_${index}`, `value-${index}`] as const)
    const results = await Promise.all(entries.map(([key, value]) => secureSetCredential(key, value)))
    expect(results.every((result) => result.ok)).toBe(true)
    for (const [key, value] of entries) {
      expect(await secureGetCredential(key)).toEqual({ ok: true, value })
    }
  })

  it('preserves an undecryptable legacy plaintext record and never returns it', async () => {
    const { secureGetCredential, secureSetCredential } = await import('../credentials')
    expect(await secureSetCredential('auth_token', 'initial')).toEqual({ ok: true })
    const parsed = JSON.parse(readFileSync(storePath(), 'utf8')) as {
      entries: Record<string, string>
    }
    const legacy = Buffer.from(['CF', 'PLAIN'].join('_') + ':' + 'seeded-secret', 'utf8')
    parsed.entries.auth_token = legacy.toString('base64')
    writeFileSync(storePath(), `${JSON.stringify(parsed, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    if (process.platform !== 'win32') chmodSync(storePath(), 0o600)
    const before = readFileSync(storePath())
    safeStorageMock.decryptString.mockImplementation(() => { throw new Error('not ciphertext') })

    expect(await secureGetCredential('auth_token')).toEqual({ ok: false, error: 'decryption_failed' })
    expect(readFileSync(storePath())).toEqual(before)
    expect(logMock.mock.calls.flat().join(' ')).not.toContain('seeded-secret')
  })

  it('preserves invalid JSON instead of treating it as an empty store', async () => {
    const { secureGetCredential, secureSetCredential } = await import('../credentials')
    expect(await secureSetCredential('auth_token', 'initial')).toEqual({ ok: true })
    writeFileSync(storePath(), '{invalid', { encoding: 'utf8', mode: 0o600 })
    if (process.platform !== 'win32') chmodSync(storePath(), 0o600)
    const before = readFileSync(storePath())
    expect(await secureGetCredential('auth_token')).toEqual({ ok: false, error: 'credential_store_invalid' })
    expect(readFileSync(storePath())).toEqual(before)
  })

  it('rejects a symlinked credential file and does not modify its target', async () => {
    const { secureGetCredential, secureSetCredential } = await import('../credentials')
    expect(await secureSetCredential('auth_token', 'initial')).toEqual({ ok: true })
    const outside = path.join(H.root, 'outside.json')
    writeFileSync(outside, 'outside-evidence', 'utf8')
    rmSync(storePath())
    try {
      symlinkSync(outside, storePath(), 'file')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return
      throw error
    }
    const result = await secureGetCredential('auth_token')
    expect(result.ok).toBe(false)
    expect(readFileSync(outside, 'utf8')).toBe('outside-evidence')
  })

  it('deletes one key atomically and removes an empty store', async () => {
    const { secureDeleteCredential, secureGetCredential, secureSetCredential } = await import('../credentials')
    await secureSetCredential('auth_token', 'one')
    await secureSetCredential('sshPassword', 'two')
    expect(await secureDeleteCredential('auth_token')).toEqual({ ok: true })
    expect(await secureGetCredential('sshPassword')).toEqual({ ok: true, value: 'two' })
    expect(await secureDeleteCredential('sshPassword')).toEqual({ ok: true })
    expect(existsSync(storePath())).toBe(false)
  })
})