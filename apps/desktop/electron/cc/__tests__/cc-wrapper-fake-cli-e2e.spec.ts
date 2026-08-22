/**
 * Real-process wire tests for the provider-neutral CLI wrapper.
 *
 * The fixture runs through the same spawn, stream parsing, translation,
 * broadcast, oversize guard, cancel, resume, and idempotency paths used by the
 * desktop runtime. Executable and argv are configured separately, so paths
 * containing spaces never require a shell.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as path from 'node:path'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

// Mock electron before importing cc-wrapper so BrowserWindow/ipcMain
// don't blow up in node-only vitest. ccEvents still fires locally.
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    removeHandler: () => {},
    handle: () => {},
  },
}))

// NOTE: do NOT mock node:child_process — we want real spawn().

import {
  startSession,
  sendMessage,
  stopSession,
  stopAllSessions,
  ccEvents,
  __resetForTests,
  __peekSession,
  getSessionStatus,
} from '../cc-wrapper'

let fakeCliDir = ''
let fakeCliPath = ''

function createFakeCli(): void {
  fakeCliDir = mkdtempSync(path.join(tmpdir(), 'awp-fake-cli-'))
  fakeCliPath = path.join(fakeCliDir, 'fake-agent-cli.js')
  writeFileSync(
    fakeCliPath,
    [
      "'use strict'",
      "const mode = process.env.AWP_FAKE_CC_MODE || 'normal'",
      "process.stdin.setEncoding('utf8')",
      "process.stdin.on('data', (chunk) => {",
      "  if (chunk.includes('\\\"type\\\":\\\"shutdown\\\"')) process.exit(0)",
      "})",
      "process.on('SIGTERM', () => process.exit(0))",
      "if (mode === 'hang') {",
      "  process.stdin.resume()",
      "} else if (mode === 'flood') {",
      "  process.stdout.write('x'.repeat(10 * 1024 * 1024))",
      "  process.stdin.resume()",
      "} else {",
      "  const events = [",
      "    { type: 'message_start', message: { model: 'fixture-model' } },",
      "    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },",
      "    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },",
      "    { type: 'content_block_stop', index: 0 },",
      "    { type: 'message_delta', usage: { input_tokens: 15, output_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 } },",
      "    { type: 'message_stop' }",
      "  ]",
      "  let index = 0",
      "  const timer = setInterval(() => {",
      "    process.stdout.write(JSON.stringify(events[index]) + '\\n')",
      "    index += 1",
      "    if (index === events.length) {",
      "      clearInterval(timer)",
      "      setTimeout(() => process.exit(0), 100)",
      "    }",
      "  }, 50)",
      "}",
    ].join('\n'),
    'utf-8',
  )
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface StreamEnvelope {
  sessionId: string
  event: {
    type?: string
    delta?: string
    done?: boolean
    error?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
    conversation_id?: string
    model?: string
    label?: string
    tool?: string
  }
}

interface ExitEnvelope {
  sessionId: string
  code: number | null
  signal: string | null
  error?: string
}

/**
 * Await an event predicate on ccEvents. Rejects on timeout. The handler is
 * unsubscribed in both paths so we don't leak listeners across tests.
 */
function waitForStreamEvent(
  predicate: (p: StreamEnvelope) => boolean,
  timeoutMs: number,
  label: string,
): Promise<StreamEnvelope> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ccEvents.off('cc:stream-event', handler)
      reject(new Error(`timeout waiting for ${label} after ${timeoutMs}ms`))
    }, timeoutMs)
    const handler = (p: StreamEnvelope) => {
      if (predicate(p)) {
        clearTimeout(timer)
        ccEvents.off('cc:stream-event', handler)
        resolve(p)
      }
    }
    ccEvents.on('cc:stream-event', handler)
  })
}

function waitForSessionExit(
  sessionId: string,
  timeoutMs: number,
): Promise<ExitEnvelope> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ccEvents.off('cc:session-exit', handler)
      reject(new Error(`timeout waiting for session-exit ${sessionId} after ${timeoutMs}ms`))
    }, timeoutMs)
    const handler = (p: ExitEnvelope) => {
      if (p.sessionId === sessionId) {
        clearTimeout(timer)
        ccEvents.off('cc:session-exit', handler)
        resolve(p)
      }
    }
    ccEvents.on('cc:session-exit', handler)
  })
}

/** Collect every stream event for a given session into an array; returns a
 *  stop() closure that unsubscribes. */
function collectStreamEvents(sessionId: string): {
  events: StreamEnvelope[]
  stop: () => void
} {
  const events: StreamEnvelope[] = []
  const handler = (p: StreamEnvelope) => {
    if (p.sessionId === sessionId) events.push(p)
  }
  ccEvents.on('cc:stream-event', handler)
  return {
    events,
    stop: () => ccEvents.off('cc:stream-event', handler),
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  __resetForTests()
  createFakeCli()
  // Explicit executable plus JSON argv preserves paths with spaces without a shell.
  process.env.AWP_AGENT_CLI_EXECUTABLE = process.execPath
  process.env.AWP_AGENT_CLI_ARGS_JSON = JSON.stringify([fakeCliPath])
  process.env.AWP_AGENT_CLI_ENV_JSON = '{}'
})

afterEach(async () => {
  await stopAllSessions()
  delete process.env.AWP_AGENT_CLI_EXECUTABLE
  delete process.env.AWP_AGENT_CLI_ARGS_JSON
  delete process.env.AWP_AGENT_CLI_ENV_JSON
  __resetForTests()
  if (fakeCliDir) rmSync(fakeCliDir, { recursive: true, force: true })
  fakeCliDir = ''
  fakeCliPath = ''
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cc-wrapper x fake-cc-cli E2E', () => {
  it('normal mode: emits the full 6-event stream and closes with done:true', async () => {
    const start = await startSession({
      conversationId: 'conv-e2e-normal',
      model: 'user-selected-model',
    })
    expect(start.ok).toBe(true)
    expect(start.sessionId).toBeTruthy()
    const sessionId = start.sessionId!

    const collector = collectStreamEvents(sessionId)

    // Exercise the stdin write path even though fake-cli ignores it. This
    // catches regressions where sendMessage fails on EPIPE / stdin closed
    // races.
    const send = await sendMessage({ sessionId, content: 'hi' })
    expect(send.ok).toBe(true)

    // Wait for the terminal done:true chunk. Fake-cli's 100ms startup +
    // 50ms * 6 events ~= 400ms; 8s gives headroom for Windows spawn cost.
    const doneEvt = await waitForStreamEvent(
      (p) => p.sessionId === sessionId && p.event.done === true,
      8_000,
      'done:true (message_stop)',
    )
    expect(doneEvt.event.done).toBe(true)

    // Wait for the process to actually exit so we can assert the full tape.
    await waitForSessionExit(sessionId, 4_000)
    collector.stop()

    // Event tape assertions — the full translated sequence that
    // stores/chat.ts consumes.
    const tape = collector.events.map((e) => e.event)

    // 1. message_start with conversation_id + model
    const msgStart = tape.find((e) => e.type === 'message_start')
    expect(msgStart).toBeDefined()
    expect(msgStart!.conversation_id).toBe('conv-e2e-normal')
    expect(msgStart!.model).toEqual(expect.any(String))

    // 2. text delta 'ok' (from content_block_delta/text_delta)
    const okDelta = tape.find((e) => e.delta === 'ok')
    expect(okDelta).toBeDefined()

    // 3. usage block matches fake-cli's fixture
    const usageEvt = tape.find((e) => e.usage)
    expect(usageEvt).toBeDefined()
    expect(usageEvt!.usage).toEqual({
      input_tokens: 15,
      output_tokens: 1,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    })

    // 4. terminal done:true
    const doneTail = tape.find((e) => e.done === true)
    expect(doneTail).toBeDefined()

    // Ordering sanity: message_start precedes delta precedes done.
    const iStart = tape.findIndex((e) => e.type === 'message_start')
    const iDelta = tape.findIndex((e) => e.delta === 'ok')
    const iDone = tape.findIndex((e) => e.done === true)
    expect(iStart).toBeGreaterThanOrEqual(0)
    expect(iDelta).toBeGreaterThan(iStart)
    expect(iDone).toBeGreaterThan(iDelta)

    // Session has been cleaned up.
    const status = getSessionStatus({ sessionId })
    expect(status.phase).toBe('exited')
  }, 15_000)

  it('flood mode: stdout >4 MiB triggers runtime_output_oversize chunk', async () => {
    process.env.AWP_AGENT_CLI_ENV_JSON = JSON.stringify({ AWP_FAKE_CC_MODE: 'flood' })
    const start = await startSession({ conversationId: 'conv-e2e-flood' })
    expect(start.ok).toBe(true)
    const sessionId = start.sessionId!

    const collector = collectStreamEvents(sessionId)

    // Wait for the oversize error chunk. Fake-cli writes 10 MiB in 64 KiB
    // chunks without newlines — cc-wrapper's STDOUT_OVERSIZE_LIMIT (4 MiB)
    // should trip within a few hundred ms on most hosts, but Windows
    // stdio can be slow; give 8 s.
    const err = await waitForStreamEvent(
      (p) =>
        p.sessionId === sessionId &&
        p.event.error === 'runtime_output_oversize',
      8_000,
      'runtime_output_oversize',
    )
    expect(err.event.error).toBe('runtime_output_oversize')
    expect(err.event.done).toBe(true)

    // The wrapper immediately calls stopSession() internally on oversize.
    // Wait for the child to actually die — SIGTERM + 3s grace + possible
    // SIGKILL. Windows TerminateProcess is near-instant.
    await waitForSessionExit(sessionId, 6_000)
    collector.stop()

    expect(getSessionStatus({ sessionId }).phase).toBe('exited')
  }, 15_000)

  it('hang mode: explicit stopSession terminates the child within the grace window', async () => {
    process.env.AWP_AGENT_CLI_ENV_JSON = JSON.stringify({ AWP_FAKE_CC_MODE: 'hang' })
    const start = await startSession({ conversationId: 'conv-e2e-hang' })
    expect(start.ok).toBe(true)
    const sessionId = start.sessionId!

    // Confirm the process is actually alive before we try to stop it.
    // Use a deterministic wait: poll __peekSession until phase != 'spawning'
    // (cc-wrapper flips to 'idle' synchronously after spawn — so this is
    // effectively a check that the session object got created).
    const peek = __peekSession(sessionId)
    expect(peek).toBeDefined()
    expect(peek!.phase).not.toBe('exited')
    expect(peek!.proc.pid).toBeGreaterThan(0)

    // Kick off stop + exit-waiter in parallel. stopSession's own timeout
    // budget is: (win-only) 500ms soft-shutdown + 3000ms SIGTERM grace +
    // SIGKILL. We give waitForSessionExit 6s which covers all of that
    // plus Windows spawn/kill jitter.
    const exitP = waitForSessionExit(sessionId, 6_000)
    const stopRes = await stopSession({ sessionId })
    expect(stopRes.ok).toBe(true)

    const exitEvt = await exitP
    expect(exitEvt.sessionId).toBe(sessionId)

    expect(getSessionStatus({ sessionId }).phase).toBe('exited')
  }, 15_000)

  it('idempotent start: same conversationId returns the same sessionId, single spawn', async () => {
    const r1 = await startSession({ conversationId: 'conv-e2e-idem' })
    expect(r1.ok).toBe(true)
    const sessionId = r1.sessionId!

    const r2 = await startSession({ conversationId: 'conv-e2e-idem' })
    expect(r2.ok).toBe(true)
    expect(r2.sessionId).toBe(sessionId)

    // Only one session registered for this conversation.
    const peek = __peekSession(sessionId)
    expect(peek).toBeDefined()
    expect(peek!.conversationId).toBe('conv-e2e-idem')

    // Let the normal-mode stream drain so the process exits cleanly before
    // afterEach tears down. Otherwise vitest's --forks may hold onto the
    // child until process.exit.
    await waitForStreamEvent(
      (p) => p.sessionId === sessionId && p.event.done === true,
      8_000,
      'done:true',
    )
    await waitForSessionExit(sessionId, 4_000)
  }, 15_000)
  it('resume mode: a real fake CLI receives the resume id and completes its event stream', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'awp-fake-resume-'))
    const scriptPath = path.join(dir, 'fake-resume-cli.js')
    const argvPath = path.join(dir, 'argv.json')
    writeFileSync(
      scriptPath,
      [
        "'use strict'",
        "const fs = require('node:fs')",
        "fs.writeFileSync(process.env.AWP_TEST_ARGV_FILE, JSON.stringify(process.argv.slice(2)))",
        "process.stdin.resume()",
        "setTimeout(() => {",
        "  process.stdout.write(JSON.stringify({ type: 'message_start', message: { model: 'fake-model' } }) + '\\n')",
        "  process.stdout.write(JSON.stringify({ type: 'message_stop' }) + '\\n')",
        "  setTimeout(() => process.exit(0), 50)",
        "}, 100)",
      ].join('\n'),
      'utf-8',
    )
    process.env.AWP_AGENT_CLI_ARGS_JSON = JSON.stringify([scriptPath])
    process.env.AWP_AGENT_CLI_ENV_JSON = JSON.stringify({
      AWP_TEST_ARGV_FILE: argvPath,
    })

    try {
      const started = await startSession({
        conversationId: 'conv-e2e-resume',
        ccSessionId: 'resume-id-42',
      })
      expect(started.ok).toBe(true)
      await waitForStreamEvent(
        (event) => event.sessionId === started.sessionId && event.event.done === true,
        4_000,
        'resume done:true',
      )
      await waitForSessionExit(started.sessionId!, 4_000)

      const argv = JSON.parse(readFileSync(argvPath, 'utf-8')) as string[]
      const resumeIndex = argv.indexOf('--resume')
      expect(resumeIndex).toBeGreaterThanOrEqual(0)
      expect(argv[resumeIndex + 1]).toBe('resume-id-42')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 10_000)
})
