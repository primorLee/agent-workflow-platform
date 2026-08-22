/**
 * Unit tests for `runStartupDiagnostic()` in ../startup-diagnostic.
 *
 * Scope (T-CU01):
 *   1. Happy path — all local checks green → ok=true, no failures, no warnings.
 *   2. userData not writable → hard failure surfaced.
 *   3. safeStorage unavailable → soft warning only.
 *   4. /health fetch rejection → soft warning only.
 *
 * Mocks (hermetic; never touches real FS/network/keychain):
 *   - electron: { app, safeStorage, dialog, shell }
 *   - node:fs: in-memory with per-test overrides for writeFileSync
 *   - ../utils/config: canonical paths + SSH config (null by default)
 *   - ../utils/logger: silent log sink
 *   - global.fetch: replaced per-test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Electron mock
// ---------------------------------------------------------------------------

const safeStorageStub = {
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((s: string) => Buffer.from(s, 'utf-8')),
  decryptString: vi.fn((b: Buffer) => b.toString('utf-8')),
}

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((k: string) => `/tmp/test-startup/${k}`),
  },
  safeStorage: safeStorageStub,
  dialog: { showMessageBoxSync: vi.fn(), showErrorBox: vi.fn() },
  shell: { openPath: vi.fn(async () => '') },
}))

// ---------------------------------------------------------------------------
// In-memory fs
// ---------------------------------------------------------------------------

const fakeFs: Record<string, string> = {}
const fsMocks = {
  existsSync: vi.fn((p: string) => p in fakeFs),
  readFileSync: vi.fn((p: string) => {
    if (!(p in fakeFs)) {
      const err = new Error('ENOENT') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    return fakeFs[p]
  }),
  writeFileSync: vi.fn((p: string, content: string) => {
    fakeFs[p] = String(content)
  }),
  unlinkSync: vi.fn((p: string) => {
    delete fakeFs[p]
  }),
  mkdirSync: vi.fn(() => undefined),
  statSync: vi.fn(() => ({
    isFile: () => true,
    mode: 0o600,
  })),
}
vi.mock('node:fs', () => ({ ...fsMocks, default: fsMocks }))

// ---------------------------------------------------------------------------
// Config + logger stubs
// ---------------------------------------------------------------------------

const AWP_DIR = '/tmp/test-startup/awp'
const sshConfigMock = vi.fn<() => { host: string; port: number; user: string } | null>(() => null)

vi.mock('../../utils/config', () => ({
  getAwpDir: () => AWP_DIR,
  getSshConfig: () => sshConfigMock(),
}))
const provisionedKeyMock = vi.fn<() => { privateKey: Buffer; keyId: string } | null>(
  () => ({ privateKey: Buffer.from('synthetic-key'), keyId: 'a'.repeat(64) }),
)
vi.mock('../../utils/ssh-private-key', () => ({
  readProvisionedSshPrivateKey: () => provisionedKeyMock(),
}))

vi.mock('../../utils/logger', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}))

// ---------------------------------------------------------------------------
// fetch — per-test override
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  for (const k of Object.keys(fakeFs)) delete fakeFs[k]
  vi.clearAllMocks()
  safeStorageStub.isEncryptionAvailable.mockReturnValue(true)
  sshConfigMock.mockReturnValue(null)
  provisionedKeyMock.mockReturnValue({ privateKey: Buffer.from('synthetic-key'), keyId: 'a'.repeat(64) })
  fsMocks.writeFileSync.mockImplementation((p: string, c: string) => {
    fakeFs[p] = String(c)
  })
  fsMocks.existsSync.mockImplementation((p: string) => p in fakeFs)

  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runStartupDiagnostic', () => {
  it('returns ok=true when all checks pass', async () => {
    const { runStartupDiagnostic } = await import('../startup-diagnostic')
    const res = await runStartupDiagnostic()

    expect(res.ok).toBe(true)
    expect(res.failures).toEqual([])
    expect(res.warnings).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns failure on userData not writable', async () => {
    // First writeFileSync (the marker roundtrip in checkUserDataWritable)
    // throws EACCES; subsequent writes (logger self-test etc.) pass through.
    let firstCall = true
    fsMocks.writeFileSync.mockImplementation((p: string, c: string) => {
      if (firstCall) {
        firstCall = false
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException
        err.code = 'EACCES'
        throw err
      }
      fakeFs[p] = String(c)
    })

    const { runStartupDiagnostic } = await import('../startup-diagnostic')
    const res = await runStartupDiagnostic()

    expect(res.ok).toBe(false)
    expect(res.failures.some((f) => f.includes('userData'))).toBe(true)
  })

  it('warning on safeStorage unavailable', async () => {
    safeStorageStub.isEncryptionAvailable.mockReturnValue(false)

    const { runStartupDiagnostic } = await import('../startup-diagnostic')
    const res = await runStartupDiagnostic()

    expect(res.warnings.length).toBeGreaterThan(0)
    expect(res.warnings.some((w) => w.includes('凭据存储已禁用'))).toBe(true)
    expect(res.warnings.join(' ')).toContain('绝不会降级为明文存储')
    expect(res.warnings.join(' ')).not.toContain('fallback')
    expect(res.failures).toEqual([])
  })

  it('fails closed without exposing a key path when SSH is configured but no bundle exists', async () => {
    sshConfigMock.mockReturnValue({ host: '127.0.0.1', port: 2222, user: 'test' })
    provisionedKeyMock.mockReturnValue(null)
    const { runStartupDiagnostic } = await import('../startup-diagnostic')
    const result = await runStartupDiagnostic()
    expect(result.ok).toBe(false)
    expect(result.failures.join(' ')).toContain('清单显式配置')
    expect(result.failures.join(' ')).not.toContain(AWP_DIR)
  })

  it('never performs a network request during automatic startup diagnostics', async () => {
    fetchMock.mockRejectedValue(new Error('network must remain unused'))
    const { runStartupDiagnostic } = await import('../startup-diagnostic')
    const result = await runStartupDiagnostic()
    expect(result.failures).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
