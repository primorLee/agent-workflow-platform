/**
 * Read-only validation for an explicitly provisioned SSH key bundle.
 *
 * The desktop never generates, adopts, migrates, or deletes keys. Operators
 * provision three app-owned files under private/keys: the private key, its
 * comment-free public key, and a closed manifest containing SHA-256 digests.
 */
import { createHash } from 'node:crypto'
import { getAwpDir } from './config'
import { readPrivateFileIfExists } from './private-storage'

const SUBDIR = 'keys'
const PRIVATE_NAME = 'awp_vm_key'
const PUBLIC_NAME = 'awp_vm_key.pub'
const MANIFEST_NAME = 'awp_vm_key.manifest.json'
const PRIVATE_MAX_BYTES = 1024 * 1024
const PUBLIC_MAX_BYTES = 64 * 1024
const MANIFEST_MAX_BYTES = 4096
const HEX_64 = /^[a-f0-9]{64}$/u
const PUBLIC_ALGORITHM = /^(?:ssh-(?:ed25519|rsa)|ecdsa-sha2-[A-Za-z0-9@._+-]{1,48})$/u
const PUBLIC_BODY = /^[A-Za-z0-9+/]{32,16384}={0,2}$/u

interface SshKeyManifest {
  schema: 'awp-ssh-private-key'
  version: 1
  key_id: string
  private_sha256: string
  public_sha256: string
}

export interface ProvisionedSshPrivateKey {
  privateKey: Buffer
  keyId: string
}

export function readProvisionedSshPrivateKey(
  appDataRoot = getAwpDir(),
): ProvisionedSshPrivateKey | null {
  const privateFile = readPrivateFileIfExists(appDataRoot, SUBDIR, PRIVATE_NAME, PRIVATE_MAX_BYTES, 0o600)
  const publicFile = readPrivateFileIfExists(appDataRoot, SUBDIR, PUBLIC_NAME, PUBLIC_MAX_BYTES, 0o644)
  const manifestFile = readPrivateFileIfExists(appDataRoot, SUBDIR, MANIFEST_NAME, MANIFEST_MAX_BYTES, 0o600)

  if (!privateFile && !publicFile && !manifestFile) return null
  if (!privateFile || !publicFile || !manifestFile) throw new Error('ssh_key_bundle_incomplete')

  const manifest = parseManifest(manifestFile.buffer)
  if (sha256(privateFile.buffer) !== manifest.private_sha256) throw new Error('ssh_private_key_integrity_failed')
  if (sha256(publicFile.buffer) !== manifest.public_sha256) throw new Error('ssh_public_key_integrity_failed')
  validatePrivateKey(privateFile.buffer)
  validatePublicKey(publicFile.buffer)

  return { privateKey: Buffer.from(privateFile.buffer), keyId: manifest.key_id }
}

function parseManifest(bytes: Buffer): SshKeyManifest {
  if (bytes.length === 0 || bytes.length > MANIFEST_MAX_BYTES) throw new Error('ssh_key_manifest_invalid')
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('ssh_key_manifest_invalid')
  }
  if (!isPlainRecord(parsed)) throw new Error('ssh_key_manifest_invalid')
  const keys = Object.keys(parsed).sort()
  const expected = ['key_id', 'private_sha256', 'public_sha256', 'schema', 'version']
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error('ssh_key_manifest_invalid')
  }
  if (
    parsed.schema !== 'awp-ssh-private-key'
    || parsed.version !== 1
    || typeof parsed.key_id !== 'string'
    || typeof parsed.private_sha256 !== 'string'
    || typeof parsed.public_sha256 !== 'string'
    || !HEX_64.test(parsed.key_id)
    || !HEX_64.test(parsed.private_sha256)
    || !HEX_64.test(parsed.public_sha256)
  ) {
    throw new Error('ssh_key_manifest_invalid')
  }
  return parsed as unknown as SshKeyManifest
}

function validatePrivateKey(bytes: Buffer): void {
  if (bytes.length < 64 || bytes.includes(0)) throw new Error('ssh_private_key_invalid')
  const text = bytes.toString('utf8')
  const labels = ['OPENSSH PRIVATE KEY', 'PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY']
  const hasBoundary = labels.some((label) => text.startsWith(['-----BEGIN ', label, '-----'].join('')))
  if (!hasBoundary) throw new Error('ssh_private_key_invalid')
}

function validatePublicKey(bytes: Buffer): void {
  if (bytes.length < 32 || bytes.includes(0)) throw new Error('ssh_public_key_invalid')
  const text = bytes.toString('utf8').trim()
  if (/\r|\n/u.test(text)) throw new Error('ssh_public_key_invalid')
  const parts = text.split(' ')
  if (parts.length !== 2 || !PUBLIC_ALGORITHM.test(parts[0]!) || !PUBLIC_BODY.test(parts[1]!)) {
    throw new Error('ssh_public_key_invalid')
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
