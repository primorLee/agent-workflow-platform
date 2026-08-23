/**
 * Real wire test for the checked-in OpenAI-compatible reference adapter.
 *
 * No provider network or credential is required: a loopback HTTP fixture emits
 * the same streaming Chat Completions frames used by real compatible servers.
 * The test covers Desktop wrapper spawn -> stdin -> HTTP -> streamed renderer
 * events -> durable native session resume.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { removeHandler: () => {}, handle: () => {} },
}))

import {
  __resetForTests,
  ccEvents,
  sendMessage,
  startSession,
  stopAllSessions,
  stopSession,
} from '../cc-wrapper'

interface StreamEnvelope {
  sessionId: string
  event: {
    type?: string
    delta?: string
    done?: boolean
    error?: string
    cc_session_id?: string
    label?: string
    tool?: string
    usage?: { input_tokens?: number; output_tokens?: number }
  }
}

interface ProviderRequest {
  url: string
  authorization: string
  body: {
    model?: string
    messages?: Array<{
      role?: string
      content?: unknown
      tool_calls?: unknown
      tool_call_id?: string
      name?: string
    }>
    stream?: boolean
    tools?: unknown[]
  }
}

interface ControlPlaneRequest {
  method: string
  url: string
  authorization: string
  body?: Record<string, unknown>
}

let fixtureRoot = ''
let server: Server | undefined
let controlPlaneServer: Server | undefined
let providerOrigin = ''
let controlPlaneOrigin = ''
let requests: ProviderRequest[] = []
let controlPlaneRequests: ControlPlaneRequest[] = []
let providerMode: 'text' | 'managed-task' = 'text'
const managedTaskId = '123e4567-e89b-42d3-a456-426614174000'
const managedTaskToken = 'fixture-control-plane-token-32-bytes'

function waitForEvent(
  predicate: (payload: StreamEnvelope) => boolean,
  timeoutMs = 10_000,
): Promise<StreamEnvelope> {
  return new Promise((resolveWait, rejectWait) => {
    const handler = (payload: StreamEnvelope): void => {
      if (!predicate(payload)) return
      clearTimeout(timer)
      ccEvents.off('cc:stream-event', handler)
      resolveWait(payload)
    }
    const timer = setTimeout(() => {
      ccEvents.off('cc:stream-event', handler)
      rejectWait(new Error('timeout waiting for reference-provider stream event'))
    }, timeoutMs)
    ccEvents.on('cc:stream-event', handler)
  })
}

function collectEvents(sessionId: string): { events: StreamEnvelope[]; stop: () => void } {
  const events: StreamEnvelope[] = []
  const handler = (payload: StreamEnvelope): void => {
    if (payload.sessionId === sessionId) events.push(payload)
  }
  ccEvents.on('cc:stream-event', handler)
  return { events, stop: () => ccEvents.off('cc:stream-event', handler) }
}

async function startProviderFixture(): Promise<void> {
  server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ProviderRequest['body']
      requests.push({
        url: request.url ?? '',
        authorization: String(request.headers.authorization ?? ''),
        body,
      })
      const turn = requests.length
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
      })
      if (providerMode === 'managed-task' && turn === 1) {
        response.write(`data: ${JSON.stringify({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call-managed-1',
                type: 'function',
                function: { name: 'awp_run_', arguments: '{"argv":["python3",' },
              }],
            },
          }],
        })}\n\n`)
        response.write(`data: ${JSON.stringify({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                function: {
                  name: 'managed_task',
                  arguments: '"-c","print(\\"managed-ok\\")"],"timeout_seconds":10}',
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        })}\n\n`)
        response.write(`data: ${JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 17, completion_tokens: 3 },
        })}\n\n`)
        response.end('data: [DONE]\n\n')
        return
      }
      if (providerMode === 'managed-task') {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'worker said: managed-ok' } }] })}\n\n`)
        response.write(`data: ${JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 19, completion_tokens: 4 },
        })}\n\n`)
        response.end('data: [DONE]\n\n')
        return
      }
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `real-${turn}-` } }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'model' } }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11 + turn, completion_tokens: 2 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server!.once('error', rejectListen)
    server!.listen(0, '127.0.0.1', () => resolveListen())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('provider fixture did not bind TCP')
  providerOrigin = `http://127.0.0.1:${address.port}`
}

async function startControlPlaneFixture(): Promise<void> {
  let pollCount = 0
  controlPlaneServer = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : undefined
      controlPlaneRequests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: String(request.headers.authorization ?? ''),
        body,
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      if (request.method === 'POST' && request.url === '/v1/tasks') {
        response.end(JSON.stringify({ id: managedTaskId, status: 'pending' }))
        return
      }
      if (request.method === 'GET' && request.url === `/v1/tasks/${managedTaskId}`) {
        pollCount += 1
        if (pollCount === 1) {
          response.end(JSON.stringify({ id: managedTaskId, status: 'running' }))
        } else {
          response.end(JSON.stringify({
            id: managedTaskId,
            status: 'success',
            result: {
              output: { stdout: 'managed-ok\n', stderr: '', exit_code: 0 },
            },
          }))
        }
        return
      }
      response.statusCode = 404
      response.end(JSON.stringify({ error: 'not_found' }))
    })
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    controlPlaneServer!.once('error', rejectListen)
    controlPlaneServer!.listen(0, '127.0.0.1', () => resolveListen())
  })
  const address = controlPlaneServer.address()
  if (!address || typeof address === 'string') throw new Error('control-plane fixture did not bind TCP')
  controlPlaneOrigin = `http://127.0.0.1:${address.port}`
}

beforeEach(async () => {
  __resetForTests()
  requests = []
  controlPlaneRequests = []
  providerMode = 'text'
  fixtureRoot = mkdtempSync(path.join(tmpdir(), 'awp-reference-provider-'))
  await startProviderFixture()
  const testDirectory = path.dirname(fileURLToPath(import.meta.url))
  const adapter = path.resolve(
    testDirectory,
    '../../../../../examples/openai-compatible-agent-cli/awp-agent-cli.mjs',
  )
  process.env.AWP_AGENT_CLI_EXECUTABLE = process.execPath
  process.env.AWP_AGENT_CLI_ARGS_JSON = JSON.stringify([adapter])
  process.env.AWP_AGENT_CLI_PROTOCOL = 'awp-jsonl'
  process.env.AWP_AGENT_CLI_ENV_JSON = JSON.stringify({
    AWP_REFERENCE_API_BASE_URL: `${providerOrigin}/v1`,
    AWP_REFERENCE_API_TOKEN: 'fixture-token',
    AWP_REFERENCE_MODEL: 'fixture-real-model',
    AWP_REFERENCE_STATE_DIR: path.join(fixtureRoot, 'state'),
  })
})

afterEach(async () => {
  await stopAllSessions()
  await new Promise<void>((resolveClose) => server?.close(() => resolveClose()) ?? resolveClose())
  await new Promise<void>(
    (resolveClose) => controlPlaneServer?.close(() => resolveClose()) ?? resolveClose(),
  )
  server = undefined
  controlPlaneServer = undefined
  delete process.env.AWP_AGENT_CLI_EXECUTABLE
  delete process.env.AWP_AGENT_CLI_ARGS_JSON
  delete process.env.AWP_AGENT_CLI_ENV_JSON
  delete process.env.AWP_AGENT_CLI_PROTOCOL
  __resetForTests()
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = ''
})

describe('Desktop wrapper x reference provider CLI', () => {
  it('streams a real compatible response and resumes durable model history', async () => {
    const first = await startSession({
      conversationId: 'reference-provider-conversation',
      model: 'fixture-real-model',
    })
    expect(first).toMatchObject({ ok: true })
    const firstSessionId = first.sessionId!
    const firstTape = collectEvents(firstSessionId)
    expect(await sendMessage({ sessionId: firstSessionId, content: 'first prompt' })).toEqual({ ok: true })
    await waitForEvent((payload) => payload.sessionId === firstSessionId && payload.event.done === true)

    const nativeSessionId = firstTape.events.find(
      (payload) => payload.event.type === 'message_start',
    )?.event.cc_session_id
    expect(nativeSessionId).toMatch(/^[A-Za-z0-9._:-]+$/u)
    expect(firstTape.events.map((payload) => payload.event.delta).filter(Boolean).join('')).toBe('real-1-model')
    expect(firstTape.events.find((payload) => payload.event.done)?.event.usage).toEqual({
      input_tokens: 12,
      output_tokens: 2,
    })
    firstTape.stop()
    await stopSession({ sessionId: firstSessionId })

    const second = await startSession({
      conversationId: 'reference-provider-conversation',
      model: 'fixture-real-model',
      ccSessionId: nativeSessionId,
    })
    expect(second).toMatchObject({ ok: true })
    const secondSessionId = second.sessionId!
    const secondTape = collectEvents(secondSessionId)
    expect(await sendMessage({ sessionId: secondSessionId, content: 'second prompt' })).toEqual({ ok: true })
    await waitForEvent((payload) => payload.sessionId === secondSessionId && payload.event.done === true)
    expect(secondTape.events.map((payload) => payload.event.delta).filter(Boolean).join('')).toBe('real-2-model')
    secondTape.stop()

    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({
      url: '/v1/chat/completions',
      authorization: 'Bearer fixture-token',
      body: {
        model: 'fixture-real-model',
        messages: [{ role: 'user', content: 'first prompt' }],
        stream: true,
      },
    })
    expect(requests[1]!.body.messages).toEqual([
      { role: 'user', content: 'first prompt' },
      { role: 'assistant', content: 'real-1-model' },
      { role: 'user', content: 'second prompt' },
    ])
  }, 30_000)

  it('runs the explicit managed-task tool through the control plane and returns the worker result', async () => {
    providerMode = 'managed-task'
    await startControlPlaneFixture()
    process.env.AWP_AGENT_CLI_ENV_JSON = JSON.stringify({
      AWP_REFERENCE_API_BASE_URL: `${providerOrigin}/v1`,
      AWP_REFERENCE_API_TOKEN: 'fixture-token',
      AWP_REFERENCE_MODEL: 'fixture-real-model',
      AWP_REFERENCE_STATE_DIR: path.join(fixtureRoot, 'managed-state'),
      AWP_REFERENCE_MANAGED_TASKS_OPT_IN: '1',
      AWP_REFERENCE_CONTROL_PLANE_URL: controlPlaneOrigin,
      AWP_REFERENCE_CONTROL_PLANE_TOKEN: managedTaskToken,
    })

    const started = await startSession({
      conversationId: 'reference-managed-task-conversation',
      model: 'fixture-real-model',
    })
    expect(started).toMatchObject({ ok: true })
    const sessionId = started.sessionId!
    const tape = collectEvents(sessionId)
    expect(await sendMessage({ sessionId, content: 'run the managed check' })).toEqual({ ok: true })
    await waitForEvent((payload) => payload.sessionId === sessionId && payload.event.done === true)

    expect(tape.events.some((payload) => (
      payload.event.type === 'cc_status'
      && payload.event.tool === 'awp_run_managed_task'
    ))).toBe(true)
    expect(tape.events.map((payload) => payload.event.delta).filter(Boolean).join('')).toBe(
      'worker said: managed-ok',
    )
    expect(tape.events.find((payload) => payload.event.done)?.event.usage).toEqual({
      input_tokens: 36,
      output_tokens: 7,
    })
    tape.stop()

    expect(controlPlaneRequests).toHaveLength(3)
    expect(controlPlaneRequests[0]).toMatchObject({
      method: 'POST',
      url: '/v1/tasks',
      authorization: `Bearer ${managedTaskToken}`,
      body: {
        task_type: 'command',
        payload: { argv: ['python3', '-c', 'print("managed-ok")'] },
      },
    })
    expect(controlPlaneRequests[0]!.body?.idempotency_key).toMatch(
      /^awp-reference-agent:[0-9a-f]{64}$/u,
    )

    expect(requests).toHaveLength(2)
    expect(requests[0]!.body.tools).toEqual([
      expect.objectContaining({
        type: 'function',
        function: expect.objectContaining({ name: 'awp_run_managed_task' }),
      }),
    ])
    expect(requests[1]!.body.messages?.at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-managed-1',
      name: 'awp_run_managed_task',
    })
    const toolResult = JSON.parse(String(requests[1]!.body.messages?.at(-1)?.content)) as Record<string, unknown>
    expect(toolResult).toMatchObject({
      task_id: managedTaskId,
      status: 'success',
      exit_code: 0,
      stdout: 'managed-ok\n',
      stderr: '',
    })
  }, 30_000)
})
