import { beforeEach, describe, expect, it, vi } from 'vitest'

const safeStorageStub = {
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(`sealed:${value}`, 'utf8')),
  decryptString: vi.fn((value: Buffer) => value.toString('utf8').replace(/^sealed:/u, '')),
}

vi.mock('electron', () => ({ safeStorage: safeStorageStub }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
  safeStorageStub.isEncryptionAvailable.mockReturnValue(true)
  safeStorageStub.encryptString.mockImplementation((value) => Buffer.from(`sealed:${value}`, 'utf8'))
  safeStorageStub.decryptString.mockImplementation((value) => value.toString('utf8').replace(/^sealed:/u, ''))
})

describe('safe-storage-compat encrypted-only boundary', () => {
  it('encrypts and decrypts only through the OS keychain', async () => {
    const { decryptOrPlain, encryptOrPlain } = await import('../safe-storage-compat')
    const sealed = encryptOrPlain('example-secret')
    expect(safeStorageStub.encryptString).toHaveBeenCalledWith('example-secret')
    expect(decryptOrPlain(sealed)).toBe('example-secret')
    expect(safeStorageStub.decryptString).toHaveBeenCalledWith(sealed)
  })

  it('fails with the stable error and no encryption call when unavailable', async () => {
    safeStorageStub.isEncryptionAvailable.mockReturnValue(false)
    const { encryptOrPlain } = await import('../safe-storage-compat')
    expect(() => encryptOrPlain('example-secret')).toThrowError('encryption_unavailable')
    expect(safeStorageStub.encryptString).not.toHaveBeenCalled()
  })

  it('maps encryption exceptions to encryption_unavailable without leaking details', async () => {
    safeStorageStub.encryptString.mockImplementation(() => {
      throw new Error('secret-bearing operating-system error')
    })
    const { encryptOrPlain } = await import('../safe-storage-compat')
    expect(() => encryptOrPlain('example-secret')).toThrowError('encryption_unavailable')
  })

  it('fails decryption when the keychain is unavailable', async () => {
    safeStorageStub.isEncryptionAvailable.mockReturnValue(false)
    const { decryptOrPlain } = await import('../safe-storage-compat')
    expect(() => decryptOrPlain(Buffer.from('ciphertext'))).toThrowError('encryption_unavailable')
    expect(safeStorageStub.decryptString).not.toHaveBeenCalled()
  })

  it('never decodes a legacy plaintext-tagged buffer', async () => {
    safeStorageStub.decryptString.mockImplementation(() => {
      throw new Error('not ciphertext')
    })
    const { decryptOrPlain } = await import('../safe-storage-compat')
    const legacy = Buffer.from(['CF', 'PLAIN'].join('_') + ':' + 'seeded-value', 'utf8')
    expect(() => decryptOrPlain(legacy)).toThrowError('decryption_failed')
  })

  it('reports encryption availability without throwing', async () => {
    const { isEncryptedStorage } = await import('../safe-storage-compat')
    expect(isEncryptedStorage()).toBe(true)
    safeStorageStub.isEncryptionAvailable.mockImplementation(() => { throw new Error('unavailable') })
    expect(isEncryptedStorage()).toBe(false)
  })
})