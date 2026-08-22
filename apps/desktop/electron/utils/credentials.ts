/**
 * OS-keychain encrypted credential store.
 *
 * Ciphertext lives in the marked app-owned private storage tree. The store is
 * closed-schema, size bounded, and atomically replaced. Keychain failures are
 * fail-closed: no plaintext fallback, no automatic purge, and no raw filesystem
 * or cryptography errors in logs or IPC results.
 */

import { getAwpDir } from './config'
import { log } from './logger'
import {
  atomicWritePrivateFile,
  readPrivateFileIfExists,
  removePrivateFile,
} from './private-storage'
import { decryptOrPlain, encryptOrPlain, isEncryptedStorage } from './safe-storage-compat'

const STORE_SUBDIR = 'credentials'
const STORE_FILENAME = 'store.json'
const STORE_SCHEMA = 'awp-encrypted-credentials'
const STORE_MAX_BYTES = 512 * 1024
const MAX_ENTRIES = 64
const MAX_CIPHERTEXT_BYTES = 64 * 1024
const KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u

interface CredentialStore {
  schema: typeof STORE_SCHEMA
  version: 1
  entries: Record<string, string>
}

let credentialWriteChain: Promise<unknown> = Promise.resolve()

async function serializeCredentialWrite<T>(fn: () => Promise<T>): Promise<T> {
  const next = credentialWriteChain.then(fn, fn)
  credentialWriteChain = next.catch(() => undefined)
  return next
}

function emptyStore(): CredentialStore {
  return { schema: STORE_SCHEMA, version: 1, entries: Object.create(null) as Record<string, string> }
}

function validateKey(key: string): void {
  if (!KEY_RE.test(key)) throw new Error('credential_key_invalid')
}

function readCredentialStore(): CredentialStore | null {
  const found = readPrivateFileIfExists(
    getAwpDir(),
    STORE_SUBDIR,
    STORE_FILENAME,
    STORE_MAX_BYTES,
  )
  if (!found) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(found.buffer.toString('utf8'))
  } catch {
    throw new Error('credential_store_invalid')
  }
  if (!isPlainRecord(parsed)) throw new Error('credential_store_invalid')
  const topKeys = Object.keys(parsed).sort()
  if (
    topKeys.length !== 3
    || topKeys[0] !== 'entries'
    || topKeys[1] !== 'schema'
    || topKeys[2] !== 'version'
    || parsed.schema !== STORE_SCHEMA
    || parsed.version !== 1
    || !isPlainRecord(parsed.entries)
  ) {
    throw new Error('credential_store_invalid')
  }

  const entryKeys = Object.keys(parsed.entries)
  if (entryKeys.length > MAX_ENTRIES) throw new Error('credential_store_invalid')
  const entries = Object.create(null) as Record<string, string>
  for (const key of entryKeys) {
    validateKey(key)
    const encoded = parsed.entries[key]
    if (typeof encoded !== 'string' || encoded.length === 0) {
      throw new Error('credential_store_invalid')
    }
    const ciphertext = Buffer.from(encoded, 'base64')
    if (
      ciphertext.length === 0
      || ciphertext.length > MAX_CIPHERTEXT_BYTES
      || ciphertext.toString('base64') !== encoded
    ) {
      throw new Error('credential_store_invalid')
    }
    entries[key] = encoded
  }
  return { schema: STORE_SCHEMA, version: 1, entries }
}

function writeCredentialStore(store: CredentialStore): void {
  atomicWritePrivateFile(
    getAwpDir(),
    STORE_SUBDIR,
    STORE_FILENAME,
    `${JSON.stringify(store, null, 2)}\n`,
    STORE_MAX_BYTES,
  )
}

function safeErrorKind(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (/^[a-z][a-z0-9_]{0,63}$/u.test(message)) return message
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (typeof code === 'string' && /^[A-Z0-9_]{1,32}$/u.test(code)) return code.toLowerCase()
  return 'credential_operation_failed'
}

function fail(operation: string, key: string, error: unknown): { ok: false; error: string } {
  const kind = safeErrorKind(error)
  log(`[credentials] operation=${operation} key=${key} error_kind=${kind}`)
  return { ok: false, error: kind }
}

export async function secureSetCredential(
  key: string,
  value: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    validateKey(key)
    if (!isEncryptedStorage()) return { ok: false, error: 'encryption_unavailable' }
    // Encrypt before touching the filesystem. Keychain failure therefore has
    // zero read/write/mkdir side effects.
    const encrypted = encryptOrPlain(value)
    if (encrypted.length === 0 || encrypted.length > MAX_CIPHERTEXT_BYTES) {
      throw new Error('encrypted_value_invalid')
    }
    return serializeCredentialWrite(async () => {
      try {
        const store = readCredentialStore() ?? emptyStore()
        if (!(key in store.entries) && Object.keys(store.entries).length >= MAX_ENTRIES) {
          throw new Error('credential_store_full')
        }
        store.entries[key] = encrypted.toString('base64')
        writeCredentialStore(store)
        return { ok: true }
      } catch (error) {
        return fail('set', key, error)
      }
    })
  } catch (error) {
    return fail('set', typeof key === 'string' && KEY_RE.test(key) ? key : 'invalid', error)
  }
}

export async function secureGetCredential(
  key: string,
): Promise<{ ok: boolean; value?: string; error?: string }> {
  try {
    validateKey(key)
    if (!isEncryptedStorage()) return { ok: false, error: 'encryption_unavailable' }
    const store = readCredentialStore()
    if (!store || !(key in store.entries)) return { ok: true, value: undefined }
    const encrypted = Buffer.from(store.entries[key], 'base64')
    const value = decryptOrPlain(encrypted)
    return { ok: true, value }
  } catch (error) {
    return fail('get', typeof key === 'string' && KEY_RE.test(key) ? key : 'invalid', error)
  }
}

export async function secureDeleteCredential(
  key: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    validateKey(key)
    return serializeCredentialWrite(async () => {
      try {
        const store = readCredentialStore()
        if (!store || !(key in store.entries)) return { ok: true }
        delete store.entries[key]
        if (Object.keys(store.entries).length === 0) {
          removePrivateFile(getAwpDir(), STORE_SUBDIR, STORE_FILENAME, STORE_MAX_BYTES)
        } else {
          writeCredentialStore(store)
        }
        return { ok: true }
      } catch (error) {
        return fail('delete', key, error)
      }
    })
  } catch (error) {
    return fail('delete', typeof key === 'string' && KEY_RE.test(key) ? key : 'invalid', error)
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}