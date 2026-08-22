import { createHash } from 'node:crypto'
import { existsSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  atomicWritePrivateFile,
  createExclusivePrivateFile,
  ensurePrivateStorageSubdir,
} from '../private-storage'
import { readProvisionedSshPrivateKey } from '../ssh-private-key'

const roots: string[] = []
const sha256 = (value: Buffer): string => createHash('sha256').update(value).digest('hex')
const privateFixture = Buffer.from(
  ['-----BEGIN ', 'OPENSSH PRIVATE KEY', '-----', '\n', 'synthetic-fixture-'.repeat(8), '\n', '-----END ', 'OPENSSH PRIVATE KEY', '-----', '\n'].join(''),
  'utf8',
)
const publicFixture = Buffer.from(`ssh-ed25519 ${Buffer.alloc(32, 7).toString('base64')}\n`, 'utf8')

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'awp-ssh-key-'))
  roots.push(root)
  return root
}

function manifest(privateKey = privateFixture, publicKey = publicFixture): string {
  return `${JSON.stringify({
    schema: 'awp-ssh-private-key',
    version: 1,
    key_id: 'a'.repeat(64),
    private_sha256: sha256(privateKey),
    public_sha256: sha256(publicKey),
  })}\n`
}

function provision(root: string, options: { privateKey?: Buffer; publicKey?: Buffer; omitPublic?: boolean } = {}): void {
  const privateKey = options.privateKey ?? privateFixture
  const publicKey = options.publicKey ?? publicFixture
  createExclusivePrivateFile(root, 'keys', 'awp_vm_key', privateKey, 1024 * 1024, 0o600)
  if (!options.omitPublic) {
    createExclusivePrivateFile(root, 'keys', 'awp_vm_key.pub', publicKey, 64 * 1024, 0o644)
  }
  createExclusivePrivateFile(root, 'keys', 'awp_vm_key.manifest.json', manifest(privateKey, publicKey), 4096, 0o600)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('explicit provisioned SSH private key', () => {
  it('returns null without creating a private tree when no bundle exists', async () => {
    const root = await makeRoot()
    expect(readProvisionedSshPrivateKey(root)).toBeNull()
    expect(existsSync(join(root, 'private'))).toBe(false)
  })

  it('accepts only a complete marked bundle with matching hashes', async () => {
    const root = await makeRoot()
    provision(root)
    const result = readProvisionedSshPrivateKey(root)
    expect(result?.keyId).toBe('a'.repeat(64))
    expect(result?.privateKey.equals(privateFixture)).toBe(true)
  })

  it('refuses an incomplete bundle instead of silently adopting the private key', async () => {
    const root = await makeRoot()
    provision(root, { omitPublic: true })
    expect(() => readProvisionedSshPrivateKey(root)).toThrow('ssh_key_bundle_incomplete')
  })

  it('refuses a key replaced after the manifest was provisioned', async () => {
    const root = await makeRoot()
    provision(root)
    const replacement = Buffer.from(privateFixture.toString('utf8').replace('synthetic-fixture-', 'replacement-fixture-'))
    atomicWritePrivateFile(root, 'keys', 'awp_vm_key', replacement, 1024 * 1024, 0o600)
    expect(() => readProvisionedSshPrivateKey(root)).toThrow('ssh_private_key_integrity_failed')
  })

  it.skipIf(process.platform === 'win32')('refuses a symlinked private key without deleting it', async () => {
    const root = await makeRoot()
    const outside = join(root, 'outside-key')
    writeFileSync(outside, privateFixture, { mode: 0o600 })
    const keys = ensurePrivateStorageSubdir(root, 'keys')
    symlinkSync(outside, join(keys, 'awp_vm_key'))
    createExclusivePrivateFile(root, 'keys', 'awp_vm_key.pub', publicFixture, 64 * 1024, 0o644)
    createExclusivePrivateFile(root, 'keys', 'awp_vm_key.manifest.json', manifest(), 4096, 0o600)
    expect(() => readProvisionedSshPrivateKey(root)).toThrow(/unsafe_type|redirected/u)
    expect(existsSync(outside)).toBe(true)
  })

  it('uses structural error codes that do not expose local paths or machine identity', async () => {
    const root = await makeRoot()
    provision(root)
    atomicWritePrivateFile(root, 'keys', 'awp_vm_key.manifest.json', '{"bad":true}\n', 4096, 0o600)
    let message = ''
    try { readProvisionedSshPrivateKey(root) } catch (error) { message = (error as Error).message }
    expect(message).toBe('ssh_key_manifest_invalid')
    expect(message).not.toContain(root)
  })
})
