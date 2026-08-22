/**
 * Electron safeStorage boundary.
 *
 * Credentials are encrypted with the operating-system keychain or are not
 * persisted at all. Earlier plaintext-tagged records are intentionally not
 * decoded here: safeStorage will reject them, the encrypted store is preserved
 * as evidence, and the caller can ask the user to repair the keychain and sign
 * in again.
 */

import { safeStorage } from 'electron'

export function encryptOrPlain(value: string): Buffer {
  if (!isEncryptedStorage()) throw new Error('encryption_unavailable')
  try {
    return safeStorage.encryptString(value)
  } catch {
    throw new Error('encryption_unavailable')
  }
}

export function decryptOrPlain(buffer: Buffer): string {
  if (!isEncryptedStorage()) throw new Error('encryption_unavailable')
  try {
    return safeStorage.decryptString(buffer)
  } catch {
    throw new Error('decryption_failed')
  }
}

export function isEncryptedStorage(): boolean {
  try {
    return safeStorage.isEncryptionAvailable() === true
  } catch {
    return false
  }
}