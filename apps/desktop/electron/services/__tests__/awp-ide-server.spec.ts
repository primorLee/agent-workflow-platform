/**
 * Focused tests for the app-owned awp-ide discovery lock and local MCP config.
 * The lock contract deliberately has no ambient directory override and never
 * scans or deletes unknown, stale, corrupt, replaced, or symlinked paths.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  deleteLockFile,
  ensureIdeDir,
  ideDir,
  mintAuthToken,
  writeLockFile,
  type IdeLockInput,
  type IdeLockPayload,
} from '../awp-ide-server/lock-file'
import {
  buildIdeOnlyConfig,
  defaultMcpConfigPath,
  writeMcpConfig,
} from '../awp-ide-server/mcp-config'
import * as mcpConfigApi from '../awp-ide-server/mcp-config'

let tmp: string
let originalAmbientDir: string | undefined

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'awp-ide-test-'))
  originalAmbientDir = process.env.AWP_IDE_DIR
  process.env.AWP_IDE_DIR = join(tmp, 'ambient-must-not-be-used')
})

afterEach(() => {
  if (originalAmbientDir === undefined) delete process.env.AWP_IDE_DIR
  else process.env.AWP_IDE_DIR = originalAmbientDir
  rmSync(tmp, { recursive: true, force: true })
})

function sampleInput(port = 51247): IdeLockInput {
  return {
    pid: process.pid,
    host: '127.0.0.1',
    port,
    token: mintAuthToken(),
    url: 'http://127.0.0.1:' + port + '/mcp',
    started_at: '2026-08-22T12:34:56.789Z',
    desktop_version: '0.1.0',
  }
}

describe('app-owned ide lock root', () => {
  it('uses only the explicit app data root and ignores the retired ambient override', () => {
    expect(ideDir(tmp)).toBe(join(tmp, 'ide'))
    expect(existsSync(process.env.AWP_IDE_DIR || '')).toBe(false)
  })

  it('creates a marked private directory', () => {
    const root = ensureIdeDir(tmp)
    expect(root).toBe(join(tmp, 'ide'))
    const marker = JSON.parse(readFileSync(join(root, '.awp-ide-root.json'), 'utf8'))
    expect(marker).toEqual({ schema: 'awp-ide-lock-root', version: 1 })
    if (process.platform !== 'win32') {
      expect(statSync(root).mode & 0o777).toBe(0o700)
      expect(statSync(join(root, '.awp-ide-root.json')).mode & 0o777).toBe(0o600)
    }
  })
})

describe('awp-ide lock capability', () => {
  it('mints unique 32-byte base64url tokens', () => {
    const first = mintAuthToken()
    const second = mintAuthToken()
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(first).not.toBe(second)
  })

  it('writes exact schema plus a random lock_id using an exclusive private file', () => {
    const input = sampleInput()
    const firstPath = writeLockFile(input, tmp)
    const first = JSON.parse(readFileSync(firstPath, 'utf8')) as IdeLockPayload
    const secondPath = writeLockFile(sampleInput(51248), tmp)
    const second = JSON.parse(readFileSync(secondPath, 'utf8')) as IdeLockPayload

    expect(first).toMatchObject({
      schema: 'awp-ide-lock',
      version: 1,
      ...input,
    })
    expect(first.lock_id).toMatch(/^[a-f0-9]{32}$/u)
    expect(second.lock_id).toMatch(/^[a-f0-9]{32}$/u)
    expect(second.lock_id).not.toBe(first.lock_id)
    if (process.platform !== 'win32') {
      expect(statSync(firstPath).mode & 0o777).toBe(0o600)
    }
  })

  it('deletes only the exact lock path owned by this module instance', () => {
    const path = writeLockFile(sampleInput(), tmp)
    expect(deleteLockFile(path)).toBe(true)
    expect(deleteLockFile(path)).toBe(false)
    expect(deleteLockFile(join(tmp, 'unknown-lock.json'))).toBe(false)
  })

  it('does not delete a replaced file at a formerly owned path', () => {
    const path = writeLockFile(sampleInput(), tmp)
    rmSync(path)
    writeFileSync(path, 'replacement sentinel', { encoding: 'utf8', mode: 0o600 })
    if (process.platform !== 'win32') chmodSync(path, 0o600)
    expect(deleteLockFile(path)).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('replacement sentinel')
  })

  it('does not follow or delete a symlink replacement', () => {
    const path = writeLockFile(sampleInput(), tmp)
    const sentinel = join(tmp, 'sentinel.json')
    writeFileSync(sentinel, 'do not delete', { encoding: 'utf8', mode: 0o600 })
    rmSync(path)
    try {
      symlinkSync(sentinel, path, 'file')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return
      throw error
    }
    expect(lstatSync(path).isSymbolicLink()).toBe(true)
    expect(() => deleteLockFile(path)).toThrow(/unsafe_type/u)
    expect(readFileSync(sentinel, 'utf8')).toBe('do not delete')
  })

  it('refuses to create a lock for another process instead of adopting stale ownership', () => {
    expect(() => writeLockFile({ ...sampleInput(), pid: process.pid + 1 }, tmp))
      .toThrow(/pid_must_match_process/u)
  })
})
// 5. buildIdeOnlyConfig
// ---------------------------------------------------------------------------

describe('buildIdeOnlyConfig', () => {
  it('emits a single awp-ide HTTP server with Bearer auth', () => {
    const cfg = buildIdeOnlyConfig({
      ideUrl: 'http://127.0.0.1:51247/mcp',
      ideToken: 'abc123',
    })
    expect(cfg.mcpServers['awp-ide']).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:51247/mcp',
      headers: { authorization: 'Bearer abc123' },
    })
    expect(Object.keys(cfg.mcpServers)).toEqual(['awp-ide'])
  })

  it('does not expose implicit remote MCP composition', () => {
    expect(mcpConfigApi).not.toHaveProperty('buildFullConfig')
    expect(mcpConfigApi).not.toHaveProperty('BuildFullConfigOpts')
  })
})

// ---------------------------------------------------------------------------
// 6. writeMcpConfig
// ---------------------------------------------------------------------------

describe('writeMcpConfig', () => {
  it('writes a 0600 file that JSON-parses back to the input config', () => {
    const cfg = buildIdeOnlyConfig({
      ideUrl: 'http://127.0.0.1:51247/mcp',
      ideToken: 'abc123',
    })
    const path = join(tmp, 'awp-ide-mcp-config.json')
    writeMcpConfig(cfg, path)
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    expect(parsed).toEqual(cfg)
    if (process.platform !== 'win32') {
      const mode = statSync(path).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })

  it('uses ~/.awp/awp-ide-mcp-config.json as the default path', () => {
    expect(defaultMcpConfigPath()).toMatch(
      /[\\/]\.awp[\\/]awp-ide-mcp-config\.json$/,
    )
  })
})
