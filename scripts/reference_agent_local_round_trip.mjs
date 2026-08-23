#!/usr/bin/env node

/**
 * Exercise the checked-in reference Agent against the real local Compose stack.
 *
 * A deterministic loopback Chat Completions fixture requests one managed tool;
 * the control plane, queue, worker process, and returned command output are real.
 * The fixture makes this CI-safe and credential-free without pretending that a
 * particular hosted model is part of the repository.
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

const ROOT = resolve(import.meta.dirname, '..')
const COMPOSE_FILE = resolve(ROOT, 'deploy/local/docker-compose.local-dev.yml')
const ADAPTER = resolve(ROOT, 'examples/openai-compatible-agent-cli/awp-agent-cli.mjs')
const CONTROL_PLANE = 'http://127.0.0.1:8100'
const EXPECTED_OUTPUT = 'awp-agent-control-worker-ok'
const MAX_REQUEST_BYTES = 2 * 1024 * 1024

function validateToken(value) {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || Buffer.byteLength(value, 'utf8') < 16
    || Buffer.byteLength(value, 'utf8') > 4096
    || /[\u0000-\u0020\u007f]/u.test(value)
  ) throw new Error('local_control_plane_key_invalid')
  return value
}

function discoverControlPlaneKey() {
  const result = spawnSync(
    'docker',
    [
      'compose',
      '-f',
      COMPOSE_FILE,
      'exec',
      '-T',
      'control-plane',
      'python',
      '-c',
      'from cloud.config import DEV_API_KEY; print(DEV_API_KEY)',
    ],
    { cwd: ROOT, encoding: 'utf8', timeout: 10_000, windowsHide: true },
  )
  if (result.status !== 0) throw new Error('local_control_plane_key_unavailable')
  return validateToken(result.stdout.replace(/\r?\n$/u, ''))
}

async function readJsonRequest(request) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.length
    if (total > MAX_REQUEST_BYTES) throw new Error('provider_request_oversize')
    chunks.push(bytes)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('provider_request_invalid')
  }
  return value
}

function writeSse(response, events) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
  })
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
  response.end('data: [DONE]\n\n')
}

async function startProviderFixture() {
  const requests = []
  let providerFailure = null
  const server = createServer((request, response) => {
    void (async () => {
      try {
        assert.equal(request.method, 'POST')
        assert.equal(request.url, '/v1/chat/completions')
        const body = await readJsonRequest(request)
        requests.push(body)
        if (requests.length === 1) {
          assert.equal(body.model, 'awp-ci-fixture-model')
          assert.equal(body.stream, true)
          assert.equal(body.tools?.[0]?.function?.name, 'awp_run_managed_task')
          writeSse(response, [
            {
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: 'call-compose-round-trip',
                    type: 'function',
                    function: {
                      name: 'awp_run_managed_task',
                      arguments: JSON.stringify({
                        argv: ['python3', '-c', `print('${EXPECTED_OUTPUT}')`],
                        timeout_seconds: 30,
                      }),
                    },
                  }],
                },
                finish_reason: 'tool_calls',
              }],
            },
            { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } },
          ])
          return
        }
        if (requests.length === 2) {
          const messages = Array.isArray(body.messages) ? body.messages : []
          const toolMessage = messages.at(-1)
          assert.equal(toolMessage?.role, 'tool')
          assert.equal(toolMessage?.name, 'awp_run_managed_task')
          const toolResult = JSON.parse(String(toolMessage.content))
          assert.equal(toolResult.status, 'success')
          assert.equal(toolResult.exit_code, 0)
          assert.equal(String(toolResult.stdout).trim(), EXPECTED_OUTPUT)
          writeSse(response, [
            { choices: [{ delta: { content: `verified: ${EXPECTED_OUTPUT}` } }] },
            { choices: [], usage: { prompt_tokens: 18, completion_tokens: 5 } },
          ])
          return
        }
        throw new Error('provider_received_unexpected_round')
      } catch (error) {
        providerFailure = error
        if (!response.headersSent) response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'fixture_rejected_request' }))
      }
    })()
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('provider_fixture_bind_failed')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    failure: () => providerFailure,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  }
}

function minimalChildEnvironment(extra) {
  const environment = {}
  for (const key of [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'SYSTEMROOT',
    'COMSPEC',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
  ]) {
    if (process.env[key]) environment[key] = process.env[key]
  }
  return { ...environment, ...extra }
}

async function runReferenceAgent(providerOrigin, stateDirectory, controlPlaneKey) {
  const child = spawn(process.execPath, [ADAPTER, '--model', 'awp-ci-fixture-model'], {
    cwd: ROOT,
    env: minimalChildEnvironment({
      AWP_REFERENCE_API_BASE_URL: `${providerOrigin}/v1`,
      AWP_REFERENCE_STATE_DIR: stateDirectory,
      AWP_REFERENCE_MANAGED_TASKS_OPT_IN: '1',
      AWP_REFERENCE_CONTROL_PLANE_URL: CONTROL_PLANE,
      AWP_REFERENCE_CONTROL_PLANE_TOKEN: controlPlaneKey,
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const events = []
  let stderr = ''
  child.stdin.on('error', () => {})
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16_384)
  })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })

  try {
    const result = await new Promise((resolveResult, rejectResult) => {
      let settled = false
      const finish = (callback, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        callback(value)
      }
      const timer = setTimeout(
        () => finish(rejectResult, new Error('reference_agent_round_trip_timeout')),
        60_000,
      )
      child.once('error', (error) => finish(rejectResult, error))
      child.once('exit', () => {
        if (!settled) finish(rejectResult, new Error('reference_agent_exited_before_result'))
      })
      lines.on('line', (line) => {
        try {
          const event = JSON.parse(line)
          events.push(event)
          if (event.type === 'result') finish(resolveResult, event)
        } catch (error) {
          finish(rejectResult, error)
        }
      })
      child.stdin.write(`${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'Run the integration marker task.' },
      })}\n`)
    })

    child.stdin.end(`${JSON.stringify({ type: 'shutdown' })}\n`)
    const exitCode = child.exitCode ?? await new Promise((resolveExit, rejectExit) => {
      const timer = setTimeout(() => {
        child.kill()
        rejectExit(new Error('reference_agent_shutdown_timeout'))
      }, 5_000)
      child.once('exit', (code) => {
        clearTimeout(timer)
        resolveExit(code)
      })
    })
    return { result, events, stderr, exitCode }
  } finally {
    lines.close()
    if (child.exitCode === null) {
      child.kill()
      await new Promise((resolveExit) => {
        const timer = setTimeout(resolveExit, 2_000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolveExit()
        })
      })
    }
  }
}

async function main() {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'awp-reference-compose-'))
  let provider
  try {
    const controlPlaneKey = discoverControlPlaneKey()
    provider = await startProviderFixture()
    const outcome = await runReferenceAgent(provider.origin, stateDirectory, controlPlaneKey)
    if (provider.failure()) throw provider.failure()
    assert.equal(provider.requests.length, 2)
    assert.equal(outcome.exitCode, 0)
    assert.equal(outcome.result.type, 'result')
    assert.equal(outcome.result.subtype, 'success')
    assert.equal(outcome.result.is_error, false)
    assert.equal(outcome.result.result, `verified: ${EXPECTED_OUTPUT}`)
    assert.equal(outcome.result.usage?.input_tokens, 28)
    assert.equal(outcome.result.usage?.output_tokens, 9)
    const diagnostics = `${JSON.stringify(outcome.events)}\n${outcome.stderr}`
    assert.equal(diagnostics.includes(controlPlaneKey), false, 'control-plane key leaked into Agent output')
    process.stdout.write('[reference-agent-round-trip] model protocol -> control plane -> real worker -> model protocol passed\n')
  } finally {
    if (provider) await provider.close()
    await rm(stateDirectory, { recursive: true, force: true })
  }
}

main().catch(() => {
  process.stderr.write('[reference-agent-round-trip] FAILED; inspect bounded Compose diagnostics from the CI teardown step\n')
  process.exitCode = 1
})
