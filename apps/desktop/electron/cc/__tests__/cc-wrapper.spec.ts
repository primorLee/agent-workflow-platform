import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const state = vi.hoisted(() => ({
  userData: '',
  endpoint: null as { url: string; token: string } | null,
  managedRuntimePath: null as string | null,
  managedRuntimeVersion: null as string | null,
  recoverManagedRuntime: vi.fn(async () => ({ updated: false })),
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => state.userData,
    getVersion: () => '1.2.3',
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    removeHandler: vi.fn(),
    handle: vi.fn(),
  },
}))

vi.mock('../../utils/config', () => ({
  getAwpDir: () => state.userData,
}))

vi.mock('../../services/awp-ide-server', () => ({
  getServerEndpoint: () => state.endpoint,
}))

vi.mock('../../services/trace-collector', () => ({
  recordEventCapped: vi.fn(),
}))

vi.mock('../cc-runtime-updater', () => ({
  getCliPath: () => state.managedRuntimePath,
  getCurrentVersion: () => state.managedRuntimeVersion,
  recoverFromMissingBinary: state.recoverManagedRuntime,
}))

interface FakeStdin extends EventEmitter {
  write: ReturnType<typeof vi.fn>
  destroyed: boolean
}

interface FakeProc extends EventEmitter {
  stdin: FakeStdin
  stdout: EventEmitter
  stderr: EventEmitter
  exitCode: number | null
  killed: boolean
  pid: number
  kill: ReturnType<typeof vi.fn>
}

function makeFakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc
  const stdin = new EventEmitter() as FakeStdin
  stdin.write = vi.fn().mockReturnValue(true)
  stdin.destroyed = false
  proc.stdin = stdin
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.exitCode = null
  proc.killed = false
  proc.pid = 4242
  proc.kill = vi.fn(() => {
    proc.killed = true
    return true
  })
  return proc
}

let lastSpawn:
  | { command: string; argv: string[]; options: { env?: NodeJS.ProcessEnv } }
  | null = null
let lastProc: FakeProc | null = null
const spawnedProcs: FakeProc[] = []
const spawnMock = vi.fn(
  (
    command: string,
    argv: string[],
    options: { env?: NodeJS.ProcessEnv },
  ): FakeProc => {
    lastSpawn = { command, argv, options }
    lastProc = makeFakeProc()
    return lastProc
  },
)

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const mockedSpawn = (
    command: string,
    argv: string[],
    options: { env?: NodeJS.ProcessEnv },
  ) => spawnMock(command, argv, options)
  return {
    ...actual,
    spawn: mockedSpawn,
    default: { ...actual, spawn: mockedSpawn },
  }
})

import {
  __peekSession,
  __resetForTests,
  buildCcEnv,
  ccEvents,
  getMostRecentCcStderr,
  getSessionStatus,
  sendMessage,
  startSession,
  stopSession,
  translateEvent,
} from '../cc-wrapper'
import type { CcSession } from '../cc-wrapper'

const ENV_KEYS = [
  'AWP_AGENT_CLI_EXECUTABLE',
  'AWP_AGENT_CLI_COMMAND',
  'AWP_AGENT_CLI_ARGS_JSON',
  'AWP_AGENT_CLI_ENV_JSON',
  'AWP_AGENT_CLI_PROTOCOL',
  'AWP_AGENT_CLI_TRACE',
  'AWP_AGENT_TELEMETRY_OPT_IN',
  'AWP_AGENT_REMOTE_API_OPT_IN',
  'AWP_AGENT_REMOTE_MCP_URL',
  'AWP_AGENT_REMOTE_MCP_NAME',
  'AWP_AGENT_REMOTE_MCP_TOKEN',
  'AWP_AGENT_REMOTE_MCP_OPT_IN',
  'AWP_AGENT_ATTACHMENT_URL_TEMPLATE',
  'AWP_AGENT_ATTACHMENT_BEARER_TOKEN',
] as const

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key]
}

function sessionFixture(): CcSession {
  return {
    sessionId: 'session-fixture',
    conversationId: 'conversation-fixture',
    proc: {} as CcSession['proc'],
    cwd: process.cwd(),
    model: 'test-model',
    phase: 'idle',
    stdoutBuffer: '',
    stderrBuffer: '',
    decoder: new TextDecoder('utf-8', { fatal: false }),
    pendingToolInput: new Map(),
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
  }
}

beforeEach(() => {
  state.userData = mkdtempSync(path.join(tmpdir(), 'awp-wrapper-test-'))
  state.endpoint = null
  state.managedRuntimePath = null
  state.managedRuntimeVersion = null
  state.recoverManagedRuntime.mockClear()
  clearEnv()
  process.env.AWP_AGENT_CLI_EXECUTABLE = process.execPath
  process.env.AWP_AGENT_CLI_ARGS_JSON = '[]'
  __resetForTests()
  ccEvents.removeAllListeners()
  spawnMock.mockClear()
  lastSpawn = null
  lastProc = null
})

afterEach(async () => {
  for (const proc of spawnedProcs) {
    if (proc.exitCode === null) proc.emit('exit', 0, null)
  }
  await new Promise((resolve) => setTimeout(resolve, 10))
  __resetForTests()
  ccEvents.removeAllListeners()
  clearEnv()
  vi.unstubAllGlobals()
  rmSync(state.userData, { recursive: true, force: true })
})

describe('opt-in local CLI diagnostics', () => {
  it.each([undefined, '', '0', 'true', '01'])('creates no diagnostic file when opt-in is %s', async (value) => {
    if (value === undefined) delete process.env.AWP_AGENT_CLI_TRACE
    else process.env.AWP_AGENT_CLI_TRACE = value

    const result = await startSession({ conversationId: 'diagnostic-default-off' })
    expect(result.ok).toBe(true)
    lastProc!.stderr.emit('data', Buffer.from('private prompt and credential-shaped stderr'))
    lastProc!.emit('exit', 1, null)

    expect(existsSync(path.join(state.userData, 'agent-cli-diagnostics'))).toBe(false)
    expect(existsSync(path.join(state.userData, 'agent-cli-trace.jsonl'))).toBe(false)
    expect(getMostRecentCcStderr()).toBeNull()
  })

  it('persists only bounded structural summaries after exact opt-in', async () => {
    process.env.AWP_AGENT_CLI_TRACE = '1'
    const seededPrompt = ['never', 'persist', 'this', 'prompt'].join(' ')
    const seededToken = ['fixture', 'token', 'private', 'value'].join('-')
    const seededPath = path.join(state.userData, 'private-workspace', 'input.txt')

    const first = await startSession({ conversationId: seededPrompt })
    expect(first.ok).toBe(true)
    lastProc!.stderr.emit('data', Buffer.from(
      `API Error prompt=${seededPrompt} token=${seededToken} path=${seededPath}`,
    ))
    lastProc!.emit('exit', 2, 'SIGTERM')

    for (let index = 0; index < 7; index += 1) {
      const result = await startSession({ conversationId: `rotation-${index}` })
      expect(result.ok).toBe(true)
      lastProc!.stderr.emit('data', Buffer.from(`${seededPrompt} ${seededToken} ${seededPath}`))
      lastProc!.emit('exit', 0, null)
    }

    const dir = path.join(state.userData, 'agent-cli-diagnostics')
    const files = readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
    expect(files.length).toBeLessThanOrEqual(5)
    const persisted = [
      ...files.map((name) => readFileSync(path.join(dir, name), 'utf-8')),
      readFileSync(path.join(state.userData, 'agent-cli-trace.jsonl'), 'utf-8'),
    ].join('\n')
    expect(persisted).not.toContain(seededPrompt)
    expect(persisted).not.toContain(seededToken)
    expect(persisted).not.toContain(seededPath)
    expect(persisted).toContain('"type":"stderr"')
    expect(files.every((name) => statSync(path.join(dir, name)).size <= 64 * 1024)).toBe(true)
    expect(statSync(path.join(state.userData, 'agent-cli-trace.jsonl')).size).toBeLessThanOrEqual(128 * 1024)
    expect(getMostRecentCcStderr()?.content).not.toContain(seededPrompt)
  })
})
describe('startSession provider-neutral defaults', () => {
  it('spawns the explicitly configured CLI without host, token, model, MCP, or unsafe flags', async () => {
    process.env.UNRELATED_TEST_SECRET = 'must-not-reach-child'
    try {
      const result = await startSession({ conversationId: 'conv-default' })
      expect(result.ok).toBe(true)
      expect(spawnMock).toHaveBeenCalledTimes(1)
      expect(lastSpawn!.command).toBe(process.execPath)
      expect(lastSpawn!.argv).toEqual([
        '--output-format', 'stream-json',
        '--input-format', 'stream-json',
        '--print',
        '--verbose',
      ])

      const serializedArgs = JSON.stringify(lastSpawn!.argv)
      expect(serializedArgs).not.toMatch(
        new RegExp(['danger', 'ously|skip-permissions|allow-danger', 'ously|Web', 'Fetch|Web', 'Search|--model|--mcp-config'].join(''), 'i'),
      )
      const env = lastSpawn!.options.env ?? {}
      expect(env.UNRELATED_TEST_SECRET).toBeUndefined()
      expect(Object.values(env)).not.toContain('must-not-reach-child')
      expect(Object.keys(env).some((key) => /TOKEN|API_KEY|BASE_URL/i.test(key))).toBe(false)
    } finally {
      delete process.env.UNRELATED_TEST_SECRET
    }
  })

  it('adds a model and resume id only when the caller explicitly supplies them', async () => {
    const result = await startSession({
      conversationId: 'conv-explicit',
      model: 'user-selected-model',
      ccSessionId: 'resume-session-1',
    })
    expect(result.ok).toBe(true)
    expect(lastSpawn!.argv).toContain('--model')
    expect(lastSpawn!.argv).toContain('user-selected-model')
    expect(lastSpawn!.argv).toContain('--resume')
    expect(lastSpawn!.argv).toContain('resume-session-1')
  })

  it('rejects malformed start options before spawning', async () => {
    await expect(
      startSession(undefined as unknown as Parameters<typeof startSession>[0]),
    ).resolves.toEqual({ ok: false, error: 'invalid_start_options' })
    await expect(startSession({ conversationId: ' ' })).resolves.toEqual({
      ok: false,
      error: 'invalid_conversation_id',
    })
    await expect(startSession({ conversationId: 'x'.repeat(513) })).resolves.toEqual({
      ok: false,
      error: 'invalid_conversation_id',
    })
    await expect(
      startSession({ conversationId: 'conv-invalid-cwd', cwd: 'bad\u0000cwd' }),
    ).resolves.toEqual({ ok: false, error: 'invalid_working_directory' })
    await expect(
      startSession({ conversationId: 'conv-invalid-model', model: 'bad\nmodel' }),
    ).resolves.toEqual({ ok: false, error: 'invalid_model' })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('returns runtime_unavailable instead of falling back to a vendor executable', async () => {
    delete process.env.AWP_AGENT_CLI_EXECUTABLE
    const result = await startSession({ conversationId: 'conv-unavailable' })
    expect(result).toEqual({ ok: false, error: 'runtime_unavailable' })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('runs recovery only for the signed managed runtime, never a user executable', async () => {
    let result = await startSession({ conversationId: 'conv-external-error' })
    lastProc!.emit('error', Object.assign(new Error('bad external binary'), { code: 'EFTYPE' }))
    await Promise.resolve()
    expect(result.ok).toBe(true)
    expect(state.recoverManagedRuntime).not.toHaveBeenCalled()

    delete process.env.AWP_AGENT_CLI_EXECUTABLE
    state.managedRuntimePath = process.execPath
    result = await startSession({ conversationId: 'conv-managed-error' })
    lastProc!.emit('error', Object.assign(new Error('bad managed binary'), { code: 'EFTYPE' }))
    await Promise.resolve()
    expect(result.ok).toBe(true)
    expect(state.recoverManagedRuntime).toHaveBeenCalledTimes(1)
  })

  it('is idempotent per conversation', async () => {
    const first = await startSession({ conversationId: 'conv-idempotent' })
    const second = await startSession({ conversationId: 'conv-idempotent' })
    expect(first.ok).toBe(true)
    expect(second.sessionId).toBe(first.sessionId)
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })
})

describe('explicit environment and MCP boundaries', () => {
  it('forwards only explicitly configured CLI environment values', async () => {
    process.env.AWP_AGENT_CLI_ENV_JSON = JSON.stringify({
      USER_CONFIGURED_VALUE: 'on',
    })
    const env = await buildCcEnv()
    expect(env.USER_CONFIGURED_VALUE).toBe('on')
    expect(env.AWP_AGENT_CLI_ENV_JSON).toBeUndefined()
  })

  it('requires a second opt-in when explicit CLI env contains a remote URL', async () => {
    process.env.AWP_AGENT_CLI_ENV_JSON = JSON.stringify({
      USER_CONFIGURED_ENDPOINT: 'https://api.example.test/v1',
      USER_CONFIGURED_TOKEN: 'test-token',
    })

    let result = await startSession({ conversationId: 'conv-remote-denied' })
    expect(result).toEqual({
      ok: false,
      error: 'remote_api_requires_explicit_opt_in',
    })
    expect(spawnMock).not.toHaveBeenCalled()

    process.env.AWP_AGENT_REMOTE_API_OPT_IN = '1'
    result = await startSession({ conversationId: 'conv-remote-allowed' })
    expect(result.ok).toBe(true)
    expect(lastSpawn!.options.env).toMatchObject({
      USER_CONFIGURED_ENDPOINT: 'https://api.example.test/v1',
      USER_CONFIGURED_TOKEN: 'test-token',
    })
  })

  it('requires a second opt-in when explicit CLI arguments contain a remote URL', async () => {
    process.env.AWP_AGENT_CLI_ARGS_JSON = JSON.stringify([
      '--endpoint',
      'https://api.example.test/v1',
    ])

    let result = await startSession({ conversationId: 'conv-remote-args-denied' })
    expect(result).toEqual({
      ok: false,
      error: 'remote_api_requires_explicit_opt_in',
    })
    expect(spawnMock).not.toHaveBeenCalled()

    process.env.AWP_AGENT_REMOTE_API_OPT_IN = '1'
    result = await startSession({ conversationId: 'conv-remote-args-allowed' })
    expect(result.ok).toBe(true)
    expect(lastSpawn!.argv).toEqual(expect.arrayContaining([
      '--endpoint',
      'https://api.example.test/v1',
    ]))
  })

  it('rejects remote MCP configuration until the operator opts in', async () => {
    process.env.AWP_AGENT_REMOTE_MCP_URL = 'https://mcp.example.test/rpc'
    process.env.AWP_AGENT_REMOTE_MCP_NAME = 'user-remote'

    let result = await startSession({ conversationId: 'conv-mcp-denied' })
    expect(result).toEqual({ ok: false, error: 'mcp_config_render_failed' })
    expect(spawnMock).not.toHaveBeenCalled()

    process.env.AWP_AGENT_REMOTE_MCP_OPT_IN = '1'
    result = await startSession({ conversationId: 'conv-mcp-allowed' })
    expect(result.ok).toBe(true)
    const index = lastSpawn!.argv.indexOf('--mcp-config')
    const config = JSON.parse(readFileSync(lastSpawn!.argv[index + 1], 'utf-8'))
    expect(Object.keys(config.mcpServers)).toEqual(['user-remote'])
  })
})

describe('stream parsing and lifecycle', () => {
  it('translates message, delta, usage, and done events', () => {
    const session = sessionFixture()
    expect(
      translateEvent(
        { type: 'message_start', message: { model: 'event-model' } },
        session,
      ),
    ).toEqual({
      type: 'message_start',
      conversation_id: 'conversation-fixture',
      model: 'event-model',
    })
    expect(
      translateEvent(
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hello' },
        },
        session,
      ),
    ).toEqual({ delta: 'hello' })
    expect(
      translateEvent(
        {
          type: 'message_delta',
          usage: { input_tokens: 2, output_tokens: 3 },
        },
        session,
      ),
    ).toEqual({ usage: { input_tokens: 2, output_tokens: 3 } })
    expect(translateEvent({ type: 'message_stop' }, session)).toEqual({ done: true })
  })

  it('reassembles a JSON line split across stdout chunks', async () => {
    const events: unknown[] = []
    ccEvents.on('cc:stream-event', (payload) => events.push(payload.event))
    const result = await startSession({ conversationId: 'conv-split' })
    expect(result.ok).toBe(true)

    const line = JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'split-ok' },
    })
    lastProc!.stdout.emit('data', Buffer.from(line.slice(0, 20)))
    expect(events).toHaveLength(0)
    lastProc!.stdout.emit('data', Buffer.from(line.slice(20) + '\n'))
    expect(events).toEqual([{ delta: 'split-ok' }])
  })

  it('flushes a final JSON event without a trailing newline on process exit', async () => {
    const events: unknown[] = []
    ccEvents.on('cc:stream-event', (payload) => events.push(payload.event))
    const result = await startSession({ conversationId: 'conv-final-line' })
    expect(result.ok).toBe(true)

    lastProc!.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ type: 'message_stop' })),
    )
    expect(events).toEqual([])

    lastProc!.exitCode = 0
    lastProc!.emit('exit', 0, null)
    expect(events).toEqual([{ done: true }])
  })

  it('writes stream-json messages and rejects unknown sessions', async () => {
    const result = await startSession({ conversationId: 'conv-send' })
    const sent = await sendMessage({
      sessionId: result.sessionId!,
      content: 'hello agent',
    })
    expect(sent.ok).toBe(true)
    const payload = JSON.parse(lastProc!.stdin.write.mock.calls[0][0])
    expect(payload).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'hello agent' }],
      },
    })
    await expect(
      sendMessage({ sessionId: 'missing', content: 'x' }),
    ).resolves.toEqual({ ok: false, error: 'unknown_session' })
  })

  it('does not retrieve a remote attachment without the remote API opt-in', async () => {
    process.env.AWP_AGENT_ATTACHMENT_URL_TEMPLATE =
      'https://attachments.example.test/files/{id}'
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await startSession({ conversationId: 'conv-attachment-private' })

    await expect(
      sendMessage({
        sessionId: result.sessionId!,
        content: 'inspect',
        attachments: [{ path: 'abcdef_file.txt', filename: 'file.txt' }],
      }),
    ).resolves.toEqual({ ok: true })

    expect(fetchMock).not.toHaveBeenCalled()
    const payload = JSON.parse(lastProc!.stdin.write.mock.calls[0][0])
    expect(payload.message.content[0]).toEqual({
      type: 'text',
      text: '[Attachment unavailable: file.txt]',
    })
  })

  it('rejects an oversized opted-in remote attachment before buffering it', async () => {
    process.env.AWP_AGENT_ATTACHMENT_URL_TEMPLATE =
      'https://attachments.example.test/files/{id}'
    process.env.AWP_AGENT_REMOTE_API_OPT_IN = '1'
    const fetchMock = vi.fn(async () =>
      new Response('x', {
        status: 200,
        headers: { 'content-length': String(25 * 1024 * 1024 + 1) },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const result = await startSession({ conversationId: 'conv-attachment-large' })

    await expect(
      sendMessage({
        sessionId: result.sessionId!,
        content: 'inspect',
        attachments: [{ path: 'abcdef_file.txt', filename: 'file.txt' }],
      }),
    ).resolves.toEqual({ ok: true })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(lastProc!.stdin.write.mock.calls[0][0])
    expect(payload.message.content[0].text).toBe('[Attachment unavailable: file.txt]')
  })

  it('reports session state and handles an unknown stop idempotently', async () => {
    const result = await startSession({
      conversationId: 'conv-status',
      model: 'explicit-model',
    })
    expect(getSessionStatus({ sessionId: result.sessionId! })).toMatchObject({
      phase: 'idle',
      pid: 4242,
      model: 'explicit-model',
      conversationId: 'conv-status',
    })
    expect(__peekSession(result.sessionId!)).toBeDefined()
    await expect(stopSession({ sessionId: 'missing' })).resolves.toEqual({ ok: true })
  })
})
