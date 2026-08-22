/**
 * Unit tests for the `secure:*-credential` IPC allow-list — S1 (P0) closeout.
 *
 * Covers two layers:
 *
 *   1. `isCredentialKey` pure type-guard behaviour: known keys accept,
 *      unknown keys (including path-traversal / NUL-injection payloads,
 *      case variants, and non-string inputs) reject.
 *
 *   2. End-to-end IPC handler wiring: the registered `secure:set-credential`
 *      / `secure:get-credential` / `secure:delete-credential` handlers pass
 *      allow-listed keys through to the `secureXxxCredential` helpers, and
 *      reject anything else *before* touching safeStorage. The rejection
 *      error echoes only the (sanitised) key name, never the caller-supplied
 *      value — that is a non-negotiable from the audit.
 *
 * The secureXxxCredential helpers are mocked: we're testing the gate, not
 * the storage backend. The storage backend has its own test file
 * (`utils/__tests__/credentials.spec.ts`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  CREDENTIAL_KEYS,
  isCredentialKey,
} from '../credential-keys'

// ---------------------------------------------------------------------------
// Pure type-guard tests
// ---------------------------------------------------------------------------

describe('isCredentialKey', () => {
  it('accepts every key in CREDENTIAL_KEYS', () => {
    for (const k of CREDENTIAL_KEYS) {
      expect(isCredentialKey(k)).toBe(true)
    }
  })

  it('rejects unknown keys', () => {
    expect(isCredentialKey('github_pat')).toBe(false)
    expect(isCredentialKey('api_key')).toBe(false)
    expect(isCredentialKey('')).toBe(false)
    expect(isCredentialKey('AUTH_TOKEN')).toBe(false) // case-sensitive
  })

  it('rejects path-traversal and injection payloads', () => {
    expect(isCredentialKey('../foo')).toBe(false)
    expect(isCredentialKey('../../etc/passwd')).toBe(false)
    expect(isCredentialKey('auth_token\0evil')).toBe(false)
    expect(isCredentialKey('auth_token\nevil')).toBe(false)
    expect(isCredentialKey('auth_token/../evil')).toBe(false)
    expect(isCredentialKey(' auth_token')).toBe(false) // leading space
    expect(isCredentialKey('auth_token ')).toBe(false) // trailing space
  })

  it('rejects non-string inputs', () => {
    expect(isCredentialKey(42)).toBe(false)
    expect(isCredentialKey(null)).toBe(false)
    expect(isCredentialKey(undefined)).toBe(false)
    expect(isCredentialKey({})).toBe(false)
    expect(isCredentialKey([])).toBe(false)
    expect(isCredentialKey(Symbol('auth_token'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// IPC handler integration — mount handlers.ts with a stub ipcMain, then
// drive each handler through its registered callback.
// ---------------------------------------------------------------------------

// Captured handlers by channel name. Populated via the stub `ipcMain.handle`.
type HandlerFn = (
  event: unknown,
  ...args: unknown[]
) => Promise<unknown>
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

vi.mock('electron', () => ({
  ipcMain: ipcMainStub,
  safeStorage: safeStorageStub,
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  dialog: { showMessageBoxSync: vi.fn(), showErrorBox: vi.fn() },
  clipboard: { writeText: vi.fn(), readText: vi.fn(() => '') },
  shell: { openExternal: vi.fn() },
}))

// Mock the credential helpers so we can observe whether a rejected call
// short-circuits before touching them. The audit mandates: unknown keys
// must NOT reach safeStorage at all.
const secureSetMock = vi.fn(async (_k: string, _v: string) => ({ ok: true }))
const secureGetMock = vi.fn(async (_k: string) => ({ ok: true, value: 'stored' }))
const secureDeleteMock = vi.fn(async (_k: string) => ({ ok: true }))

vi.mock('../../utils/credentials', () => ({
  secureSetCredential: (k: string, v: string) => secureSetMock(k, v),
  secureGetCredential: (k: string) => secureGetMock(k),
  secureDeleteCredential: (k: string) => secureDeleteMock(k),
}))

// The logger is a side-channel we don't care about here; silence it.
const logMock = vi.fn()
vi.mock('../../utils/logger', () => ({
  log: logMock,
  logError: vi.fn(),
}))

// Stub the many config helpers handlers.ts imports. We never hit these
// paths through the credential channels, but the module-load must succeed.
vi.mock('../../utils/config', () => ({
  getAwpDir: () => '/tmp/test-awp',
  getSshKeyPath: () => '/tmp/test-awp/awp_vm_key',
  getTunnelStatusPath: () => '/tmp/test-awp/tunnel_status.json',
  getSetupProgressPath: () => '/tmp/test-awp/setup_progress.json',
  getAuthPath: () => '/tmp/test-awp/auth.json',
  getCustomerIdPath: () => '/tmp/test-awp/customer_id',
  getApiTokenPath: () => '/tmp/test-awp/api_token',
  ensureAwpDir: vi.fn(),
  getSshConfig: () => ({ host: '127.0.0.1', port: 2222, user: 'test' }),
}))

// Stub the ssh-connect bridge import; handlers.ts pulls attachHostVerifier.
vi.mock('../../bridge/ssh-connect', () => ({
  attachHostVerifier: vi.fn(),
}))

// node:fs is only touched by other channels; pin safe defaults.
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  }
})

beforeEach(async () => {
  process.env.AWP_HOSTED_AUTH_OPT_IN = '1'
  for (const k of Object.keys(handlers)) delete handlers[k]
  vi.clearAllMocks()
  safeStorageStub.isEncryptionAvailable.mockReturnValue(true)

  // Reset the module cache so `registerIpcHandlers` re-runs into our fresh
  // ipcMain stub each test.
  vi.resetModules()
  const { registerIpcHandlers } = await import('../handlers')
  registerIpcHandlers()
})



afterEach(() => {
  delete process.env.AWP_HOSTED_AUTH_OPT_IN
})
describe('secure:*-credential IPC allow-list gate', () => {
  describe('secure:set-credential', () => {
    it('passes through an allow-listed key to safeStorage', async () => {
      const fn = handlers['secure:set-credential']
      expect(fn).toBeDefined()

      const res = await fn({}, 'auth_token', 'secret-value')
      expect(res).toEqual({ ok: true })
      expect(secureSetMock).toHaveBeenCalledTimes(1)
      expect(secureSetMock).toHaveBeenCalledWith('auth_token', 'secret-value')
    })

    it('rejects an unknown key and never touches safeStorage', async () => {
      const fn = handlers['secure:set-credential']
      const res = (await fn({}, 'evil_key', 'would-be-overwrite')) as {
        ok: boolean
        error?: string
      }
      expect(res.ok).toBe(false)
      expect(res.error).toContain('evil_key')
      expect(res.error).not.toContain('would-be-overwrite') // never leak value
      expect(secureSetMock).not.toHaveBeenCalled()
    })

    it('rejects path-traversal / NUL-injection keys', async () => {
      const fn = handlers['secure:set-credential']

      const traversalRes = (await fn({}, '../foo', 'x')) as { ok: boolean; error?: string }
      expect(traversalRes.ok).toBe(false)
      expect(traversalRes.error).toContain('../foo')
      // Sensitive value never echoed back.
      expect(traversalRes.error).not.toContain('x')

      const nulRes = (await fn({}, 'auth_token\0evil', 'y')) as { ok: boolean; error?: string }
      expect(nulRes.ok).toBe(false)
      // The NUL byte is scrubbed in the echoed key preview — but the
      // recognisable stub is still there so devs see the issue in logs.
      expect(nulRes.error).toMatch(/auth_token/)

      expect(secureSetMock).not.toHaveBeenCalled()
    })

    it('rejects non-string values even when key is valid', async () => {
      const fn = handlers['secure:set-credential']
      const res = (await fn({}, 'auth_token', 42)) as { ok: boolean; error?: string }
      expect(res.ok).toBe(false)
      expect(res.error).toContain('string')
      expect(secureSetMock).not.toHaveBeenCalled()
    })
  })

  describe('secure:get-credential', () => {
    it('passes through an allow-listed key', async () => {
      const fn = handlers['secure:get-credential']
      const res = await fn({}, 'auth_token')
      expect(res).toEqual({ ok: true, value: 'stored' })
      expect(secureGetMock).toHaveBeenCalledWith('auth_token')
    })

    it('rejects an unknown key with the key name in the error', async () => {
      const fn = handlers['secure:get-credential']
      const res = (await fn({}, 'github_pat')) as { ok: boolean; error?: string }
      expect(res.ok).toBe(false)
      expect(res.error).toContain('github_pat')
      expect(secureGetMock).not.toHaveBeenCalled()
    })

    it('rejects a non-string key (e.g. number)', async () => {
      const fn = handlers['secure:get-credential']
      const res = (await fn({}, 42)) as { ok: boolean; error?: string }
      expect(res.ok).toBe(false)
      expect(secureGetMock).not.toHaveBeenCalled()
    })
  })

  describe('bridge:save-token (S4 routes to safeStorage under auth_token)', () => {
    it('ends up writing under the allow-listed auth_token key — no new keys introduced', async () => {
      const fn = handlers['bridge:save-token']
      expect(fn).toBeDefined()

      const ok = await fn({}, 'sk-value')
      expect(ok).toBe(true)

      // Filter out any unrelated migration calls that also target auth_token.
      const authCalls = secureSetMock.mock.calls.filter(
        (c) => c[0] === 'auth_token' && c[1] === 'sk-value',
      )
      expect(authCalls.length).toBeGreaterThanOrEqual(1)

      // Crucially: no save-token call ever hits an off-list key.
      const offListCalls = secureSetMock.mock.calls.filter(
        (c) => !['auth_token', 'token', 'sshPassword'].includes(c[0] as string),
      )
      expect(offListCalls).toEqual([])
    })
  })

  describe('secure:delete-credential', () => {
    it('passes through the legacy "token" key (still allow-listed for cleanup)', async () => {
      const fn = handlers['secure:delete-credential']
      const res = await fn({}, 'token')
      expect(res).toEqual({ ok: true })
      expect(secureDeleteMock).toHaveBeenCalledWith('token')
    })

    it('rejects an unknown key', async () => {
      const fn = handlers['secure:delete-credential']
      const res = (await fn({}, '../../etc/passwd')) as { ok: boolean; error?: string }
      expect(res.ok).toBe(false)
      expect(res.error).toContain('../../etc/passwd')
      expect(secureDeleteMock).not.toHaveBeenCalled()
    })
  })
})
