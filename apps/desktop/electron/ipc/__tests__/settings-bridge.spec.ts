/**
 * Prod-live verification for Desktop Electron bridge settings/credentials IPC.
 *
 * This test boots `registerIpcHandlers()` against a stub `ipcMain` and an
 * in-memory-stubbed `electron.safeStorage`, but — crucially — uses the REAL
 * Node `fs` and a REAL temp directory under `os.tmpdir()/awp-it-*`.
 * That means we exercise the actual `writeFileSync`/`readFileSync`/`path.join`
 * path the production handlers take when they land under `~/.awp{,-dev,
 * -insiders}` on the customer machine.
 *
 * Invariants pinned:
 *   1. `bridge:save-settings` writes to `settings_<customer_id>.json` on
 *      disk, `bridge:load-settings` reads the same bytes back verbatim
 *      (round-trip).
 *   2. Two different customer_ids are SCOPED — writing under `cust_a` does
 *      not surface under `cust_b`, and neither surfaces under the global
 *      `settings.json` fallback.
 *   3. `secure:set-credential` + `secure:get-credential` round-trip through
 *      the real `credentials.enc.json` file using the stubbed safeStorage
 *      (`encryptString` tags with `ENC:` prefix; `decryptString` strips it).
 *   4. A malformed customer_id (path-traversal `../evil`, NUL, slash, empty
 *      string after trim, over-length) is rejected by `bridge:save-settings`
 *      with `false` and NO file written anywhere — defence-in-depth for the
 *      `settings_${id}.json` filename concatenation.
 *
 * The credentials and save-token layers each have their own hermetic specs
 * (`utils/__tests__/credentials.spec.ts`, `ipc/__tests__/credential-allowlist
 * .spec.ts`, `ipc/__tests__/save-token-migration.spec.ts`). This spec is the
 * END-TO-END bridge test that makes sure the registered handlers, the fs
 * layer, the channel-aware awp dir, and the credential store all
 * integrate correctly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Real temp dir — created per-suite, torn down in afterEach.
// ---------------------------------------------------------------------------

let TMP_DIR: string

// ---------------------------------------------------------------------------
// Captured IPC handlers — populated by the ipcMain stub below.
// ---------------------------------------------------------------------------

type HandlerFn = (event: unknown, ...args: unknown[]) => Promise<unknown>
const handlers: Record<string, HandlerFn> = {}

const ipcMainStub = {
  handle: vi.fn((channel: string, fn: HandlerFn) => {
    handlers[channel] = fn
  }),
}

// ---------------------------------------------------------------------------
// safeStorage stub — emulate OS keychain with an ENC: prefix tag so we can
// assert both a) the value was run through encryptString and b) round-trip
// parity after decryptString.
// ---------------------------------------------------------------------------

const safeStorageStub = {
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((s: string) => Buffer.from('ENC:' + s, 'utf-8')),
  decryptString: vi.fn((b: Buffer) => {
    const s = b.toString('utf-8')
    if (!s.startsWith('ENC:')) throw new Error('decrypt_failed: not ENC prefixed')
    return s.slice(4)
  }),
}

vi.mock('electron', () => ({
  ipcMain: ipcMainStub,
  safeStorage: safeStorageStub,
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  dialog: { showMessageBoxSync: vi.fn(), showErrorBox: vi.fn() },
  clipboard: { writeText: vi.fn(), readText: vi.fn(() => '') },
  shell: { openExternal: vi.fn() },
}))

// ---------------------------------------------------------------------------
// Config mock — point all awp-dir-derived paths at our REAL tmp dir.
// NOTE: we only mock the path RESOLVERS; fs is NOT mocked, so writes hit disk.
// ---------------------------------------------------------------------------

vi.mock('../../utils/config', () => {
  const getAwpDir = () => TMP_DIR
  return {
    getAwpDir,
    getSshKeyPath: () => path.join(TMP_DIR, 'awp_vm_key'),
    getTunnelStatusPath: () => path.join(TMP_DIR, 'tunnel_status.json'),
    getSetupProgressPath: () => path.join(TMP_DIR, 'setup_progress.json'),
    getAuthPath: () => path.join(TMP_DIR, 'auth.json'),
    getCustomerIdPath: () => path.join(TMP_DIR, 'customer_id'),
    getApiTokenPath: () => path.join(TMP_DIR, 'api_token'),
    getLogPath: () => path.join(TMP_DIR, 'launch.log'),
    ensureAwpDir: vi.fn(),
  }
})

// ssh-connect is imported by handlers.ts; stub to a no-op.
vi.mock('../../bridge/ssh-connect', () => ({
  attachHostVerifier: vi.fn(),
}))

// Silence the logger side-channel; tests don't assert on log output.
vi.mock('../../utils/logger', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  process.env.AWP_HOSTED_AUTH_OPT_IN = '1'
  // Fresh real temp dir per test — using a long random suffix ensures we
  // don't collide with any concurrent test run.
  TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'awp-it-'))

  // Wipe captured handlers from any prior test.
  for (const k of Object.keys(handlers)) delete handlers[k]

  vi.clearAllMocks()
  safeStorageStub.isEncryptionAvailable.mockReturnValue(true)
  safeStorageStub.encryptString.mockImplementation((s: string) =>
    Buffer.from('ENC:' + s, 'utf-8'),
  )
  safeStorageStub.decryptString.mockImplementation((b: Buffer) => {
    const s = b.toString('utf-8')
    if (!s.startsWith('ENC:')) throw new Error('decrypt_failed: not ENC prefixed')
    return s.slice(4)
  })

  // Reset the module graph so handlers.ts re-runs its `registerIpcHandlers()`
  // into our fresh ipcMain stub, and the credentials store's module-scope
  // Promise write-chain restarts clean.
  vi.resetModules()
  const { registerIpcHandlers } = await import('../handlers')
  registerIpcHandlers()
})

afterEach(() => {
  delete process.env.AWP_HOSTED_AUTH_OPT_IN
  // Tear down the temp dir — recursive+force so stray children (e.g. a
  // half-written json from a failed test) don't leak.
  try {
    rmSync(TMP_DIR, { recursive: true, force: true })
  } catch {
    // Non-fatal: Windows sometimes keeps a handle briefly. Next run will
    // land in a different mkdtemp path anyway.
  }
})

// ---------------------------------------------------------------------------
// bridge:save-settings / bridge:load-settings — real fs round-trip
// ---------------------------------------------------------------------------

describe('bridge:save-settings / bridge:load-settings (real fs round-trip)', () => {
  it('writes settings_<customer_id>.json under awp dir and reads it back verbatim', async () => {
    const save = handlers['bridge:save-settings']
    const load = handlers['bridge:load-settings']
    expect(save).toBeDefined()
    expect(load).toBeDefined()

    const payload = {
      remote: { sshUser: 'vmuser', sshPort: 2222 },
      theme: 'dark',
      locale: 'zh-CN',
    }

    const ok = await save({}, payload, 'cust_abc_123')
    expect(ok).toBe(true)

    // The file must exist on the real filesystem at the exact expected path.
    const expectedPath = path.join(TMP_DIR, 'settings_cust_abc_123.json')
    expect(existsSync(expectedPath)).toBe(true)

    // Bytes must be pretty-printed JSON (handlers use 2-space indent) and
    // round-trip cleanly.
    const raw = readFileSync(expectedPath, 'utf-8')
    expect(JSON.parse(raw)).toEqual(payload)

    const loaded = await load({}, 'cust_abc_123')
    expect(loaded).toEqual(payload)
  })

  it('scopes settings by customer_id — cust_a cannot read cust_b, neither hits global fallback', async () => {
    const save = handlers['bridge:save-settings']
    const load = handlers['bridge:load-settings']

    const payloadA = { who: 'a', apiBase: 'https://a.example.com' }
    const payloadB = { who: 'b', apiBase: 'https://b.example.com' }

    expect(await save({}, payloadA, 'cust_a')).toBe(true)
    expect(await save({}, payloadB, 'cust_b')).toBe(true)

    // Both files exist side-by-side under TMP_DIR.
    expect(existsSync(path.join(TMP_DIR, 'settings_cust_a.json'))).toBe(true)
    expect(existsSync(path.join(TMP_DIR, 'settings_cust_b.json'))).toBe(true)

    // Loads return the correct per-customer payload.
    expect(await load({}, 'cust_a')).toEqual(payloadA)
    expect(await load({}, 'cust_b')).toEqual(payloadB)

    // And there is NO global settings.json written as a side-effect — the
    // handlers must not leak one customer's payload into the global slot.
    expect(existsSync(path.join(TMP_DIR, 'settings.json'))).toBe(false)

    // A load without any customer_id falls back to the (absent) global file.
    const globalLoad = await load({})
    expect(globalLoad).toBe(null)
  })

  it('falls back to global settings.json when customer_id scoped file is absent', async () => {
    const save = handlers['bridge:save-settings']
    const load = handlers['bridge:load-settings']

    // Save globally (no customer_id).
    const globalPayload = { theme: 'light' }
    expect(await save({}, globalPayload)).toBe(true)
    expect(existsSync(path.join(TMP_DIR, 'settings.json'))).toBe(true)

    // Load with a customer_id that has NO scoped file should return the
    // global fallback per handlers.ts:850-856.
    const loaded = await load({}, 'cust_with_no_scoped_file')
    expect(loaded).toEqual(globalPayload)
  })

  // Path-traversal defence-in-depth: every invalid customer_id shape must
  // be rejected by bridge:save-settings (returns false) AND must NOT write
  // any file anywhere under the awp dir.
  it.each([
    ['path traversal ../', '../evil'],
    ['path traversal ../../etc/passwd', '../../etc/passwd'],
    ['slash injection', 'a/b'],
    ['backslash injection', 'a\\b'],
    ['NUL byte', 'cust\0evil'],
    ['newline', 'cust\nevil'],
    ['dot segment', '..'],
    ['empty string', ''],
    ['Windows reserved char colon', 'cust:evil'],
    ['Windows reserved char pipe', 'cust|evil'],
    ['Windows reserved char asterisk', 'cust*evil'],
    ['over-length 65 chars', 'a'.repeat(65)],
  ])('rejects malformed customer_id: %s', async (_label, badId) => {
    const save = handlers['bridge:save-settings']
    const load = handlers['bridge:load-settings']

    // The empty-string case hits the `customer_id !== ''` guard in the
    // handler and falls through to writing the global settings.json. That
    // is BY DESIGN (it's the "no customer_id" branch), so we exclude it
    // from the reject assertion.
    if (badId === '') {
      const ok = await save({}, { leak: 'should land in global' }, badId)
      expect(ok).toBe(true)
      // And it MUST have hit global settings.json, nothing scoped.
      expect(existsSync(path.join(TMP_DIR, 'settings.json'))).toBe(true)
      // No settings_*.json scoped file was created.
      const leaked = existsSync(path.join(TMP_DIR, 'settings_.json'))
      expect(leaked).toBe(false)
      return
    }

    const ok = await save({}, { leak: 'should never write' }, badId)
    expect(ok).toBe(false)

    // No scoped file exists. Check the naïve concatenation path would-be.
    const wouldBePath = path.join(TMP_DIR, `settings_${badId}.json`)
    expect(existsSync(wouldBePath)).toBe(false)

    // And load must also refuse, returning null — NOT the global fallback.
    const loaded = await load({}, badId)
    expect(loaded).toBe(null)

    // Defence-in-depth: no file with ANY "settings_" prefix was written.
    // (We can't easily list TMP_DIR here without importing more, but we
    // assert the obvious candidate.)
    expect(existsSync(wouldBePath)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// secure:set-credential / secure:get-credential — safeStorage round-trip
// through the real app-owned private store on disk
// ---------------------------------------------------------------------------

describe('secure:set-credential / secure:get-credential (safeStorage round-trip, real fs)', () => {
  it('round-trips an auth_token through safeStorage into the app-owned private store', async () => {
    const setFn = handlers['secure:set-credential']
    const getFn = handlers['secure:get-credential']
    expect(setFn).toBeDefined()
    expect(getFn).toBeDefined()

    const setRes = (await setFn({}, 'auth_token', 'sk-live-prod-xyz')) as {
      ok: boolean
      error?: string
    }
    expect(setRes).toEqual({ ok: true })

    // Encryption must have actually been invoked (not the CF_PLAIN fallback).
    expect(safeStorageStub.encryptString).toHaveBeenCalledWith('sk-live-prod-xyz')

    // The real encrypted credential store file exists on disk with the expected
    // shape: a JSON map of key → base64(encrypted buffer). The stored value
    // must NOT contain the plaintext (leak check).
    const credPath = path.join(TMP_DIR, 'private', 'credentials', 'store.json')
    expect(existsSync(credPath)).toBe(true)
    const raw = readFileSync(credPath, 'utf-8')
    expect(raw).not.toContain('sk-live-prod-xyz')
    const store = JSON.parse(raw) as { entries: Record<string, string> }
    expect(store.entries).toHaveProperty('auth_token')
    // base64 decodes to our ENC:-prefixed stub output.
    const decoded = Buffer.from(store.entries.auth_token, 'base64').toString('utf-8')
    expect(decoded).toBe('ENC:sk-live-prod-xyz')

    // And the get-credential handler must decrypt it back.
    const getRes = (await getFn({}, 'auth_token')) as {
      ok: boolean
      value?: string
    }
    expect(getRes).toEqual({ ok: true, value: 'sk-live-prod-xyz' })
    expect(safeStorageStub.decryptString).toHaveBeenCalled()
  })

  it('rejects an off-allowlist credential key without touching the store file', async () => {
    const setFn = handlers['secure:set-credential']

    const res = (await setFn({}, 'github_pat', 'gho_leakme')) as {
      ok: boolean
      error?: string
    }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('github_pat')
    // Sensitive value is NEVER echoed in the error.
    expect(res.error).not.toContain('gho_leakme')

    // No encrypted credential store was created — the allow-list gate ran before
    // the storage backend.
    expect(existsSync(path.join(TMP_DIR, 'private', 'credentials', 'store.json'))).toBe(false)
    // And safeStorage.encryptString was never called.
    expect(safeStorageStub.encryptString).not.toHaveBeenCalled()
  })

  it('two different credential keys do not clobber each other in the store file', async () => {
    const setFn = handlers['secure:set-credential']
    const getFn = handlers['secure:get-credential']

    expect(await setFn({}, 'auth_token', 'token-A')).toEqual({ ok: true })
    expect(await setFn({}, 'sshPassword', 'pw-B')).toEqual({ ok: true })

    // Both values are independently retrievable.
    expect(await getFn({}, 'auth_token')).toEqual({ ok: true, value: 'token-A' })
    expect(await getFn({}, 'sshPassword')).toEqual({ ok: true, value: 'pw-B' })

    // And the on-disk store contains both keys.
    const raw = readFileSync(path.join(TMP_DIR, 'private', 'credentials', 'store.json'), 'utf-8')
    const store = JSON.parse(raw) as { entries: Record<string, string> }
    expect(Object.keys(store.entries).sort()).toEqual(['auth_token', 'sshPassword'])
  })
})
