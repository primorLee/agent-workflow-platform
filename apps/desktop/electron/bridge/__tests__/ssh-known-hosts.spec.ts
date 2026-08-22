/** Strict app-owned known-hosts regression tests. */
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  root: '',
  send: vi.fn(),
  log: vi.fn(),
}))

vi.mock('../../utils/config', () => ({ getAwpDir: () => state.root }))
vi.mock('../../utils/logger', () => ({ log: state.log, logError: vi.fn() }))
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: state.send } }],
  },
}))

import {
  clearKnownHost,
  createKnownHostId,
  getKnownHostsPath,
  isKnownHostId,
  makeHostVerifier,
  verifyHostKey,
} from '../ssh-known-hosts'

const keyA = Buffer.alloc(32, 0x11)
const keyB = Buffer.alloc(32, 0x22)

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'awp-known-hosts-'))
  vi.clearAllMocks()
})

afterEach(() => {
  if (state.root) rmSync(state.root, { recursive: true, force: true })
})

function readStore(): { schema: string; version: number; entries: Record<string, string> } {
  return JSON.parse(readFileSync(getKnownHostsPath(), 'utf8'))
}

describe('strict known-host storage', () => {
  it('creates a marked private store on first TOFU and accepts the same key', () => {
    const hostId = createKnownHostId('localhost', 2222)
    expect(isKnownHostId(hostId)).toBe(true)
    expect(verifyHostKey(hostId, keyA)).toBe(true)
    expect(verifyHostKey(hostId, keyA)).toBe(true)

    const store = readStore()
    expect(store.schema).toBe('awp-known-hosts')
    expect(store.version).toBe(1)
    expect(Object.keys(store.entries)).toEqual([hostId])
    expect(store.entries[hostId]).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(join(state.root, 'private', '.awp-private-root.json'), 'utf8')).toContain('awp-private-storage-root')
    if (process.platform !== 'win32') {
      expect(lstatSync(getKnownHostsPath()).mode & 0o777).toBe(0o600)
    }
  })

  it('refuses a changed key and preserves the stored fingerprint', () => {
    const hostId = createKnownHostId('127.0.0.1', 22)
    expect(verifyHostKey(hostId, keyA)).toBe(true)
    const before = readFileSync(getKnownHostsPath())
    expect(verifyHostKey(hostId, keyB, { notifyOnMismatch: false })).toBe(false)
    expect(readFileSync(getKnownHostsPath())).toEqual(before)
  })

  it('uses an opaque host reference and binds the configured port', () => {
    const verifier = makeHostVerifier('localhost', 2200)
    expect(verifier(keyA)).toBe(true)
    const [hostId] = Object.keys(readStore().entries)
    expect(hostId).toBe(createKnownHostId('localhost', 2200))
    expect(hostId).not.toContain('localhost')
    expect(hostId).not.toContain('2200')
  })

  it('preserves invalid JSON evidence and refuses the connection', () => {
    const hostId = createKnownHostId('localhost', 22)
    expect(verifyHostKey(hostId, keyA)).toBe(true)
    const invalid = '{invalid-json'
    writeFileSync(getKnownHostsPath(), invalid, 'utf8')
    if (process.platform !== 'win32') chmodSync(getKnownHostsPath(), 0o600)

    expect(verifyHostKey(hostId, keyB)).toBe(false)
    expect(readFileSync(getKnownHostsPath(), 'utf8')).toBe(invalid)
  })

  it('preserves an oversized store and refuses the connection', () => {
    const hostId = createKnownHostId('localhost', 22)
    expect(verifyHostKey(hostId, keyA)).toBe(true)
    const oversized = 'x'.repeat(129 * 1024)
    writeFileSync(getKnownHostsPath(), oversized, 'utf8')
    if (process.platform !== 'win32') chmodSync(getKnownHostsPath(), 0o600)

    expect(verifyHostKey(hostId, keyB)).toBe(false)
    expect(readFileSync(getKnownHostsPath(), 'utf8')).toBe(oversized)
  })

  it('rejects a symlinked store without replacing or deleting its target', () => {
    if (process.platform === 'win32') return
    const hostId = createKnownHostId('localhost', 22)
    expect(verifyHostKey(hostId, keyA)).toBe(true)
    const target = join(state.root, 'evidence.json')
    writeFileSync(target, 'evidence', 'utf8')
    unlinkSync(getKnownHostsPath())
    symlinkSync(target, getKnownHostsPath())

    expect(verifyHostKey(hostId, keyB)).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe('evidence')
  })

  it('clears exactly one existing opaque reference and rejects clear-all input', () => {
    const first = createKnownHostId('localhost', 22)
    const second = createKnownHostId('localhost', 23)
    expect(verifyHostKey(first, keyA)).toBe(true)
    expect(verifyHostKey(second, keyB)).toBe(true)

    expect(clearKnownHost(first)).toBe(1)
    expect(clearKnownHost(first)).toBe(0)
    expect(Object.keys(readStore().entries)).toEqual([second])
    expect(() => clearKnownHost('')).toThrow('invalid_host_reference')
    expect(() => clearKnownHost('constructor')).toThrow('invalid_host_reference')
  })

  it('sends only the opaque reference and short fingerprint fragments on mismatch', () => {
    const hostId = createKnownHostId('localhost', 22)
    expect(verifyHostKey(hostId, keyA)).toBe(true)
    expect(verifyHostKey(hostId, keyB)).toBe(false)

    const [channel, payload] = state.send.mock.calls.at(-1) as [string, Record<string, string>]
    expect(channel).toBe('transport:host-key-mismatch')
    expect(payload.hostId).toBe(hostId)
    expect(payload.stored_fp).toHaveLength(12)
    expect(payload.received_fp).toHaveLength(12)
    expect(payload).not.toHaveProperty('known_hosts_path')
    expect(JSON.stringify(payload)).not.toContain('localhost')
    expect(JSON.stringify(payload)).not.toContain(state.root)
  })
})