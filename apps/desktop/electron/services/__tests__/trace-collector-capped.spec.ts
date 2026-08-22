import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

let temporaryDirectory = ''
const originalEnvironment = { ...process.env }

async function loadModule() {
  vi.resetModules()
  return await import('../trace-collector')
}

function tracesDirectory(): string {
  return path.join(temporaryDirectory, 'traces')
}

function currentTraceFile(): string {
  return path.join(tracesDirectory(), 'current.jsonl')
}

function readJsonl(): Array<Record<string, unknown>> {
  if (!existsSync(currentTraceFile())) return []
  return readFileSync(currentTraceFile(), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

beforeEach(() => {
  temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'awp-local-trace-'))
  process.env.AWP_USER_DATA_DIR = temporaryDirectory
  process.env.AWP_TEST_USER_DATA_DIR_OPT_IN = '1'
  delete process.env.AWP_ENABLE_LOCAL_TRACE
})

afterEach(() => {
  try { rmSync(temporaryDirectory, { recursive: true, force: true }) } catch { /* best effort */ }
  process.env = { ...originalEnvironment }
  vi.restoreAllMocks()
})

describe('local trace exact opt-in', () => {
  it('creates no directory or file by default and does not inspect dispatch values', async () => {
    const trace = await loadModule()
    const sensitiveArgs = new Proxy({ value: 'not-read' }, {
      ownKeys: () => { throw new Error('arguments were inspected') },
    })
    const result = await trace.wrapDispatch(
      'local-tool',
      sensitiveArgs,
      async () => ({ ok: true }),
    )
    trace.recordEvent('local.event', { value: 'not-written' })
    trace.recordEventCapped('local.failure', { value: 'not-written' })

    expect(result).toEqual({ ok: true })
    expect(trace.isLocalTraceEnabled()).toBe(false)
    expect(existsSync(tracesDirectory())).toBe(false)
  })

  it.each(['', '0', 'true', 'yes', 'TRUE'])('treats non-exact opt-in %j as disabled', async (value) => {
    process.env.AWP_ENABLE_LOCAL_TRACE = value
    const trace = await loadModule()
    trace.recordEvent('local.event', { value })
    expect(trace.isLocalTraceEnabled()).toBe(false)
    expect(existsSync(tracesDirectory())).toBe(false)
  })

  it('appends local events only for exact opt-in', async () => {
    process.env.AWP_ENABLE_LOCAL_TRACE = '1'
    const trace = await loadModule()
    trace.recordEventCapped('runtime_start_failed', {
      code: 'synthetic_failure',
      retryCount: 1,
    }, { convId: 'conversation-fixture' })

    expect(trace.isLocalTraceEnabled()).toBe(true)
    const events = readJsonl()
    expect(events).toHaveLength(1)
    expect(events[0].source).toBe('desktop')
    expect(events[0].kind).toBe('runtime_start_failed')
    expect(events[0].conv_id).toBe('conversation-fixture')
    expect((events[0].payload as Record<string, unknown>).emit_seq).toBe(1)
  })

  it('wraps arguments and results locally only after exact opt-in', async () => {
    process.env.AWP_ENABLE_LOCAL_TRACE = '1'
    const trace = await loadModule()
    const result = await trace.wrapDispatch(
      'local-tool',
      { input: 'fixture-input' },
      async () => ({ output: 'fixture-output' }),
      'conversation-fixture',
    )

    expect(result).toEqual({ output: 'fixture-output' })
    const events = readJsonl()
    expect(events.map((event) => event.kind)).toEqual(['desktop.tool.start', 'desktop.tool.end'])
    expect(events[0].payload).toEqual({ tool: 'local-tool', args: { input: 'fixture-input' } })
    expect(events[1].payload).toMatchObject({
      tool: 'local-tool',
      result: { output: 'fixture-output' },
    })
  })

  it('recursively scrubs secrets, query values, cycles, depth, and oversized arrays', async () => {
    process.env.AWP_ENABLE_LOCAL_TRACE = '1'
    const trace = await loadModule()
    const apiSecret = ['sk', 'syntheticvalue123456789'].join('-')
    const bearerSecret = ['Bearer', 'synthetic-session-value'].join(' ')
    const jwtSecret = [
      'eySyntheticHeader',
      'SyntheticPayload123',
      'SyntheticSignature456',
    ].join('.')
    const privateMarker = ['-----BEGIN ', 'PRIVATE KEY-----'].join('')
    const cyclic: Record<string, unknown> = {
      password: 'fixture-password',
      nested: { api_key: apiSecret, note: `https://example.test/path?token=${jwtSecret}` },
      values: Array.from({ length: 75 }, (_, index) => index),
      private_material: `${privateMarker}\nsynthetic`,
    }
    cyclic.self = cyclic

    await trace.wrapDispatch(
      'safe-tool-name',
      { authorization: bearerSecret, cyclic },
      async () => ({ credential: jwtSecret, summary: 'safe-summary' }),
    )
    await expect(trace.wrapDispatch(
      'failing-tool',
      {},
      async () => { throw new Error(`failed at https://example.test/cb?access_token=${apiSecret}`) },
    )).rejects.toThrow()

    const raw = readFileSync(currentTraceFile(), 'utf8')
    for (const secret of [
      apiSecret,
      bearerSecret,
      jwtSecret,
      'fixture-password',
      privateMarker,
    ]) {
      expect(raw).not.toContain(secret)
    }
    expect(raw).not.toContain('access_token=' + apiSecret)
    expect(raw).toContain('[REDACTED]')
    expect(raw).toContain('[CIRCULAR]')
    expect(raw).toContain('_truncated_items')
    expect(raw).toContain('safe-tool-name')
    expect(raw).toContain('safe-summary')
  })
  it('rotates the local JSONL file and retains a fresh active file', async () => {
    process.env.AWP_ENABLE_LOCAL_TRACE = '1'
    const trace = await loadModule()
    trace.recordEvent('rotation.before', { fixture: true })
    truncateSync(currentTraceFile(), 8 * 1024 * 1024)

    trace.recordEvent('rotation.after', { fixture: true })

    const backups = readdirSync(tracesDirectory())
      .filter((name) => name.startsWith('current.jsonl.') && name.endsWith('.bak'))
    expect(backups).toHaveLength(1)
    expect(readJsonl()).toHaveLength(1)
    expect(readJsonl()[0].kind).toBe('rotation.after')
  })

  it('caps the same kind at ten local events per process session', async () => {
    process.env.AWP_ENABLE_LOCAL_TRACE = '1'
    const trace = await loadModule()
    for (let index = 0; index < 25; index += 1) {
      trace.recordEventCapped('runtime_retry', { index })
    }
    expect(readJsonl()).toHaveLength(10)
    expect(readJsonl().map((event) => (event.payload as Record<string, unknown>).emit_seq))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('contains no remote upload, account lookup, cursor, or timer lifecycle', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), 'electron/services/trace-collector.ts'),
      'utf8',
    )
    const mainSource = readFileSync(path.resolve(process.cwd(), 'electron/main.ts'), 'utf8')
    const retiredRoute = ['/v1', 'trace', 'upload'].join('/')
    const accountField = ['customer', 'id'].join('_')

    expect(source).not.toContain(retiredRoute)
    expect(source.toLowerCase()).not.toContain(accountField)
    expect(source).not.toMatch(/\bfetch\s*\(/u)
    expect(source).not.toContain('cursorFile')
    expect(source).not.toContain('setInterval')
    expect(mainSource).not.toContain('startTraceCollector')
    expect(mainSource).not.toContain('stopTraceCollector')
  })
})
