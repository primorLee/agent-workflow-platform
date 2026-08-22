/**
 * Failure-flywheel coverage for the Agent CLI subprocess adapter.
 *
 * Hosted telemetry is disabled by default. With the explicit opt-in enabled,
 * already-failed local process paths emit capped diagnostic events through the
 * trace collector without changing session control flow.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

interface TelemetryEvent {
  kind: string
  conv_id?: string
  payload: Record<string, unknown>
}

const telemetryState = vi.hoisted(() => ({
  events: [] as TelemetryEvent[],
}))

vi.mock('../../services/trace-collector', () => ({
  recordEventCapped: vi.fn(
    (kind: string, payload: Record<string, unknown>, options?: { convId?: string }) => {
      telemetryState.events.push({
        kind,
        payload,
        conv_id: options?.convId,
      })
    },
  ),
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.AWP_USER_DATA_DIR ?? process.cwd(),
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    removeHandler: vi.fn(),
    handle: vi.fn(),
  },
}))

interface FakeProc extends EventEmitter {
  stdin: { write: ReturnType<typeof vi.fn>; destroyed: boolean; on: ReturnType<typeof vi.fn> }
  stdout: EventEmitter
  stderr: EventEmitter
  pid: number
  kill: ReturnType<typeof vi.fn>
}

function makeFakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc
  proc.stdin = {
    write: vi.fn().mockReturnValue(true),
    destroyed: false,
    on: vi.fn(),
  }
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.pid = 4242
  proc.kill = vi.fn()
  return proc
}

let lastProc: FakeProc | null = null
const spawnMock = vi.fn(() => {
  lastProc = makeFakeProc()
  return lastProc
})

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      void args
      return spawnMock()
    },
    default: {
      ...actual,
      spawn: (...args: unknown[]) => {
        void args
        return spawnMock()
      },
    },
  }
})

vi.mock('../../utils/config', () => ({
  getAwpDir: () => process.env.AWP_USER_DATA_DIR ?? process.cwd(),
}))

let tempDir = ''
const originalEnv = { ...process.env }

async function loadWrapper() {
  vi.resetModules()
  return await import('../cc-wrapper')
}

function eventsOf(kind: string): TelemetryEvent[] {
  return telemetryState.events.filter((event) => event.kind === kind)
}

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'awp-cc-telemetry-'))
  process.env.AWP_USER_DATA_DIR = tempDir
  process.env.AWP_AGENT_CLI_EXECUTABLE = process.execPath
  process.env.AWP_AGENT_CLI_ARGS_JSON = JSON.stringify(['fake-agent-cli.js'])
  process.env.AWP_AGENT_TELEMETRY_OPT_IN = '1'
  telemetryState.events.length = 0
  lastProc = null
  spawnMock.mockClear()
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('unexpected network request')
  }))
})

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup of test-owned data.
  }
  process.env = { ...originalEnv }
  vi.unstubAllGlobals()
})

describe('cc-wrapper failure telemetry', () => {
  it('does not report or contact the network without explicit telemetry opt-in', async () => {
    delete process.env.AWP_AGENT_TELEMETRY_OPT_IN
    const cc = await loadWrapper()
    await cc.startSession({ conversationId: 'conv-default-private' })
    lastProc!.emit('exit', 1, null)
    await settle()

    expect(telemetryState.events).toEqual([])
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('reports a local spawn failure when telemetry is explicitly enabled', async () => {
    const cc = await loadWrapper()
    const result = await cc.startSession({ conversationId: 'conv-spawn-error' })
    expect(result.ok).toBe(true)

    const error = Object.assign(new Error('spawn failed'), { code: 'EFTYPE', errno: -4068 })
    lastProc!.emit('error', error)
    await settle(80)

    const spawnFailed = eventsOf('cc_spawn_failed')
    expect(spawnFailed).toHaveLength(1)
    expect(spawnFailed[0].payload).toMatchObject({
      stage: 'proc_error',
      code: 'EFTYPE',
      errno: -4068,
      retryCount: 1,
      isBadBinary: true,
    })
    expect(spawnFailed[0].conv_id).toBe('conv-spawn-error')
    expect('cliVersion' in spawnFailed[0].payload).toBe(true)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('classifies an immediate nonzero exit with no stream events', async () => {
    const cc = await loadWrapper()
    await cc.startSession({ conversationId: 'conv-early-exit' })
    lastProc!.emit('exit', 1, null)
    await settle()

    const spawnFailed = eventsOf('cc_spawn_failed')
    expect(spawnFailed).toHaveLength(1)
    expect(spawnFailed[0].payload).toMatchObject({ stage: 'early_exit', code: 1 })
    expect(eventsOf('cc_stream_abnormal_end')).toHaveLength(0)
  })

  it('classifies a transport error that exits in the middle of a turn', async () => {
    const cc = await loadWrapper()
    const result = await cc.startSession({ conversationId: 'conv-abnormal-end' })
    await cc.sendMessage({ sessionId: result.sessionId!, content: 'summarize this file' })

    lastProc!.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-1' }) + '\n'),
    )
    lastProc!.stderr.emit('data', Buffer.from('API Error: simulated transport failure\n'))
    lastProc!.emit('exit', 1, null)
    await settle()

    const abnormalEnd = eventsOf('cc_stream_abnormal_end')
    expect(abnormalEnd).toHaveLength(1)
    const reasons = String(abnormalEnd[0].payload.reasons)
    expect(reasons).toContain('stderr_api_error')
    expect(reasons).toContain('exit_mid_turn')
    expect(reasons).toContain('nonzero_exit')
    expect(abnormalEnd[0].payload.lastEventType).toBe('system')
    expect(abnormalEnd[0].payload.exitCode).toBe(1)
    expect(abnormalEnd[0].conv_id).toBe('conv-abnormal-end')
    expect(eventsOf('cc_spawn_failed')).toHaveLength(0)
  })

  it('does not emit failure events for a clean completed turn', async () => {
    const cc = await loadWrapper()
    const result = await cc.startSession({ conversationId: 'conv-clean' })
    await cc.sendMessage({ sessionId: result.sessionId!, content: 'hi' })

    lastProc!.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-2' }) + '\n'
        + JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) + '\n',
      ),
    )
    lastProc!.emit('exit', 0, null)
    await settle()

    expect(eventsOf('cc_spawn_failed')).toHaveLength(0)
    expect(eventsOf('cc_stream_abnormal_end')).toHaveLength(0)
  })

  it('counts malformed stdout without recording its content', async () => {
    const cc = await loadWrapper()
    const result = await cc.startSession({ conversationId: 'conv-malformed' })
    await cc.sendMessage({ sessionId: result.sessionId!, content: 'hi' })

    lastProc!.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-3' }) + '\n'
        + '{"type":"assistant","message":{"content":[truncated\n'
        + JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) + '\n',
      ),
    )
    lastProc!.emit('exit', 0, null)
    await settle()

    const abnormalEnd = eventsOf('cc_stream_abnormal_end')
    expect(abnormalEnd).toHaveLength(1)
    expect(String(abnormalEnd[0].payload.reasons)).toContain('stdout_json_parse_error')
    expect(abnormalEnd[0].payload.malformedLines).toBe(1)
    expect(String(abnormalEnd[0].payload.reasons)).not.toContain('exit_mid_turn')
  })
})