/**
 * `bridge:get-auth` must surface
 * safeStorage decrypt failures instead of silently returning an empty token.
 *
 * Before this fix, installations with a broken safeStorage (OS keyring
 * migration, Electron major-version DPAPI drift, profile corruption)
 * saw "每次登录都要重来" — the renderer got `token: ''` with zero log
 * trail on the main side, impossible to diagnose from a support bundle.
 *
 * Current contract:
 *   1. Raw decrypt details are never logged or returned whenever
 *      `secureGetCredential` returns `{ ok: false, error }`.
 *   2. The AuthData returned to the renderer carries a bounded
 *      `credential_error` field so the UI knows to force a re-login
 *      rather than treating the empty token as a fresh install.
 *   3. Token value NEVER appears in any log line.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AuthData } from '../types'

type HandlerFn = (event: unknown, ...args: unknown[]) => Promise<unknown>
const handlers: Record<string, HandlerFn> = {}

const ipcMainStub = {
  handle: vi.fn((channel: string, fn: HandlerFn) => {
    handlers[channel] = fn
  }),
}

const safeStorageStub = {
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((s: string) => Buffer.from(s, 'utf-8')),
  decryptString: vi.fn((b: Buffer) => b.toString('utf-8')),
}

const browserWindowStub = {
  getAllWindows: vi.fn(() => []),
}

vi.mock('electron', () => ({
  ipcMain: ipcMainStub,
  safeStorage: safeStorageStub,
  BrowserWindow: browserWindowStub,
  dialog: { showMessageBoxSync: vi.fn(), showErrorBox: vi.fn() },
  clipboard: { writeText: vi.fn(), readText: vi.fn(() => '') },
  shell: { openExternal: vi.fn() },
}))

// In-memory fs keyed by absolute path.
const fakeFs: Record<string, string> = {}
const fsMocks = {
  constants: {
    O_NOFOLLOW: 0,
    O_RDONLY: 0,
    O_WRONLY: 1,
    O_CREAT: 0x100,
    O_EXCL: 0x400,
  },
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
    fakeFs[p] = content
  }),
  unlinkSync: vi.fn((p: string) => {
    if (!(p in fakeFs)) {
      const err = new Error('ENOENT') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    delete fakeFs[p]
  }),
  mkdirSync: vi.fn(),
}
vi.mock('node:fs', () => ({
  ...fsMocks,
  default: fsMocks,
}))

const logMock = vi.fn()
const logErrorMock = vi.fn()
vi.mock('../../utils/logger', () => ({
  log: logMock,
  logError: logErrorMock,
}))

const AUTH_PATH = '/tmp/test-awp/auth.json'
const API_TOKEN_PATH = '/tmp/test-awp/api_token'

vi.mock('../../utils/config', () => ({
  getAwpDir: () => '/tmp/test-awp',
  getSshKeyPath: () => '/tmp/test-awp/awp_vm_key',
  getTunnelStatusPath: () => '/tmp/test-awp/tunnel_status.json',
  getSetupProgressPath: () => '/tmp/test-awp/setup_progress.json',
  getAuthPath: () => AUTH_PATH,
  getCustomerIdPath: () => '/tmp/test-awp/customer_id',
  getApiTokenPath: () => API_TOKEN_PATH,
  ensureAwpDir: vi.fn(),
  getSshConfig: () => ({ host: '127.0.0.1', port: 2222, user: 'test' }),
}))

const secureSetMock = vi.fn(async (_k: string, _v: string): Promise<{ ok: boolean; error?: string }> => ({ ok: true }))
const secureGetMock = vi.fn(async (_k: string): Promise<{ ok: boolean; value?: string; error?: string }> => ({ ok: true, value: undefined }))
const secureDeleteMock = vi.fn(async (_k: string): Promise<{ ok: boolean; error?: string }> => ({ ok: true }))

vi.mock('../../utils/credentials', () => ({
  secureSetCredential: (k: string, v: string) => secureSetMock(k, v),
  secureGetCredential: (k: string) => secureGetMock(k),
  secureDeleteCredential: (k: string) => secureDeleteMock(k),
}))

vi.mock('../../bridge/ssh-connect', () => ({
  attachHostVerifier: vi.fn(),
}))

beforeEach(async () => {
  process.env.AWP_HOSTED_AUTH_OPT_IN = '1'
  for (const k of Object.keys(handlers)) delete handlers[k]
  for (const k of Object.keys(fakeFs)) delete fakeFs[k]
  vi.clearAllMocks()
  safeStorageStub.isEncryptionAvailable.mockReturnValue(true)
  secureGetMock.mockImplementation(async () => ({ ok: true, value: undefined }))
  vi.resetModules()
  const { registerIpcHandlers } = await import('../handlers')
  registerIpcHandlers()
})



afterEach(() => {
  delete process.env.AWP_HOSTED_AUTH_OPT_IN
})
describe('bridge:get-auth credential-error redaction', () => {
  it('returns a sanitized error kind without logging raw decrypt details', async () => {
    secureGetMock.mockImplementation(async () => ({
      ok: false,
      error: 'decrypt_failed: OSStatus -25293',
    }))
    // Give auth.json something readable so the handler doesn't early-return null.
    fakeFs[AUTH_PATH] = JSON.stringify({ customer_id: 'cust_abc', email: 'user@example.com', migrated: true })

    const fn = handlers['bridge:get-auth']
    expect(fn).toBeDefined()

    const res = (await fn({})) as AuthData

    // Raw keychain details are not copied into logs.
    const msgs = logMock.mock.calls.map((c) => String(c[0]))
    expect(msgs.join('\\n')).not.toContain('OSStatus -25293')

    // Renderer gets a bounded failure kind via credential_error.
    expect(res).not.toBeNull()
    expect(res.credential_error).toBe('migration_failed')
    expect(res.token).toBe('')
    expect(res.customer_id).toBe('cust_abc')
  })

  it('returns a result (not null) even when auth.json is missing, so renderer sees credential_error', async () => {
    secureGetMock.mockImplementation(async () => ({
      ok: false,
      error: 'encryption_unavailable',
    }))
    // No AUTH_PATH entry in fakeFs — auth.json is absent.

    const fn = handlers['bridge:get-auth']
    const res = (await fn({})) as AuthData | null

    expect(res).not.toBeNull()
    expect(res?.credential_error).toBe('encryption_unavailable')
    expect(res?.token).toBe('')
  })

  it('does not log WARN on successful empty read (no token yet, fresh install)', async () => {
    secureGetMock.mockImplementation(async () => ({ ok: true, value: undefined }))

    const fn = handlers['bridge:get-auth']
    const res = await fn({})

    expect(res).toBeNull()
    const warnLines = logMock.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('[get-auth]') && m.includes('WARN'))
    expect(warnLines).toEqual([])
  })

  it('never leaks the token value into logs, even when decrypt succeeds', async () => {
    secureGetMock.mockImplementation(async () => ({ ok: true, value: 'sk-SECRET-VALUE' }))
    fakeFs[AUTH_PATH] = JSON.stringify({ customer_id: 'cust_abc', email: 'u@e.com', migrated: true })

    const fn = handlers['bridge:get-auth']
    await fn({})

    for (const call of logMock.mock.calls) {
      expect(String(call[0])).not.toContain('sk-SECRET-VALUE')
    }
  })
})
