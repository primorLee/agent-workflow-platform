import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEMO_LIMITS,
  isDemoRouteImplemented,
  startDemoControlPlane,
} from './demo-control-plane.mjs'

function assertObject(value, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), label + ' must be an object')
  return value
}

function requestOptions(runtime, options = {}) {
  const { demoToken = runtime.token, ...fetchOptions } = options
  const headers = new Headers(fetchOptions.headers)
  headers.delete('x-awp-demo-token')
  if (demoToken !== null) headers.set('X-AWP-Demo-Token', demoToken)
  return { ...fetchOptions, headers }
}

async function rawRequest(runtime, path, options = {}) {
  return fetch(runtime.url + path, requestOptions(runtime, options))
}

async function jsonRequest(runtime, path, options = {}) {
  const response = await rawRequest(runtime, path, options)
  const contentType = response.headers.get('content-type') || ''
  assert.match(contentType, /application\/json/u, path + ' must return JSON')
  return { response, body: await response.json() }
}

function multipartBody(filename, bytes, conversationId) {
  const boundary = 'awp-demo-contract-boundary'
  const parts = []
  if (conversationId) {
    parts.push(Buffer.from(
      '--' + boundary + '\r\nContent-Disposition: form-data; name="conversation_id"\r\n\r\n'
        + conversationId + '\r\n',
      'utf8',
    ))
  }
  parts.push(Buffer.from(
    '--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="'
      + filename + '"\r\nContent-Type: text/plain\r\n\r\n',
    'utf8',
  ))
  parts.push(Buffer.from(bytes))
  parts.push(Buffer.from('\r\n--' + boundary + '--\r\n', 'utf8'))
  return {
    body: Buffer.concat(parts),
    contentType: 'multipart/form-data; boundary=' + boundary,
  }
}

async function uploadRequest(runtime, filename, bytes, conversationId) {
  const multipart = multipartBody(filename, bytes, conversationId)
  return jsonRequest(runtime, '/v1/chat/upload', {
    method: 'POST',
    headers: { 'content-type': multipart.contentType },
    body: multipart.body,
  })
}

async function expectNotFound(runtime, path, options = {}) {
  const { response, body } = await jsonRequest(runtime, path, options)
  assert.equal(response.status, 404)
  assert.deepEqual(assertObject(body, path + ' response'), { error: 'not found' })
}

async function closeRuntime(runtime) {
  if (!runtime) return
  const closing = runtime.close()
  runtime.server.closeAllConnections?.()
  await closing
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'awp-desktop-contract-'))
const stateFile = join(temporaryDirectory, 'sessions.json')
const allowedOrigin = 'http://127.0.0.1:5173'
let runtime
let hostedRuntime

try {
  for (const host of ['0.0.0.0', '192.168.1.10', '127.0.0.1.evil.invalid', 'localhost.evil.invalid']) {
    await assert.rejects(
      startDemoControlPlane({ host, port: 0, stateFile: join(temporaryDirectory, 'rejected.json') }),
      /demo_host_must_be_loopback/u,
    )
  }

  runtime = await startDemoControlPlane({
    host: '127.0.0.1',
    port: 0,
    stateFile,
    hostedAuthOptIn: '0',
    allowedOrigins: [allowedOrigin],
  })
  assert.equal(runtime.hostedAuthEnabled, false)
  assert.match(runtime.token, /^[A-Za-z0-9_-]{43}$/u)
  assert.equal(Object.keys(runtime).includes('token'), false)
  assert.match(runtime.url, /^http:\/\/127\.0\.0\.1:\d+$/u)
  const boundAddress = runtime.server.address()
  assert.ok(boundAddress && typeof boundAddress === 'object')
  assert.equal(boundAddress.address, '127.0.0.1')

  {
    const health = await rawRequest(runtime, '/health', { demoToken: null })
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { status: 'ok', version: 'demo' })

    for (const demoToken of [null, 'wrong-token']) {
      const denied = await jsonRequest(runtime, '/api/health', { demoToken })
      assert.equal(denied.response.status, 401)
      assert.deepEqual(denied.body, { error: 'unauthorized' })
      assert.doesNotMatch(JSON.stringify(denied.body), /wrong-token/u)
    }

    const evil = await jsonRequest(runtime, '/v1/chat/history', {
      headers: { Origin: 'https://evil.invalid' },
    })
    assert.equal(evil.response.status, 403)
    assert.equal(evil.response.headers.get('access-control-allow-origin'), null)
    assert.deepEqual(evil.body, { error: 'forbidden' })

    const evilPreflight = await fetch(runtime.url + '/v1/chat/history', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.invalid',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'X-AWP-Demo-Token',
      },
    })
    assert.equal(evilPreflight.status, 403)
    assert.equal(evilPreflight.headers.get('access-control-allow-origin'), null)

    const allowedPreflight = await fetch(runtime.url + '/v1/chat/history', {
      method: 'OPTIONS',
      headers: {
        Origin: allowedOrigin,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'X-AWP-Demo-Token',
      },
    })
    assert.equal(allowedPreflight.status, 204)
    assert.equal(allowedPreflight.headers.get('access-control-allow-origin'), allowedOrigin)
    assert.equal(allowedPreflight.headers.get('access-control-allow-methods'), 'GET')

    const browser = await jsonRequest(runtime, '/v1/chat/history', {
      headers: { Origin: allowedOrigin },
    })
    assert.equal(browser.response.status, 200)
    assert.equal(browser.response.headers.get('access-control-allow-origin'), allowedOrigin)

    const electron = await jsonRequest(runtime, '/v1/chat/history', {
      headers: { Origin: 'null' },
    })
    assert.equal(electron.response.status, 200)
    assert.equal(electron.response.headers.get('access-control-allow-origin'), 'null')
  }

  assert.equal(isDemoRouteImplemented('GET', '/v1/maintenance'), true)
  assert.equal(isDemoRouteImplemented('POST', '/v1/chat/upload'), true)
  assert.equal(isDemoRouteImplemented('GET', '/v1/chat/artifacts/example/download'), true)
  assert.equal(isDemoRouteImplemented('POST', '/v1/auth/refresh-key'), false)

  for (const path of ['/v1/auth/validate', '/v1/auth/login', '/v1/auth/register', '/v1/auth/logout']) {
    const method = path.endsWith('/validate') ? 'GET' : 'POST'
    await expectNotFound(runtime, path, { method })
  }
  await expectNotFound(runtime, '/v1/auth/refresh-key', { method: 'POST' })

  hostedRuntime = await startDemoControlPlane({
    host: '127.0.0.1',
    port: 0,
    stateFile: join(temporaryDirectory, 'hosted.json'),
    hostedAuthOptIn: '1',
  })
  assert.equal(hostedRuntime.hostedAuthEnabled, true)
  const hostedMissingToken = await jsonRequest(hostedRuntime, '/v1/auth/validate', { demoToken: null })
  assert.equal(hostedMissingToken.response.status, 401)
  const validate = await jsonRequest(hostedRuntime, '/v1/auth/validate')
  assert.equal(validate.response.status, 200)
  assert.equal(validate.body.valid, true)
  for (const path of ['/v1/auth/login', '/v1/auth/register']) {
    const response = await jsonRequest(hostedRuntime, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(response.response.status, 200)
  }
  const logout = await jsonRequest(hostedRuntime, '/v1/auth/logout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(logout.response.status, 200)
  await expectNotFound(hostedRuntime, '/v1/auth/refresh-key', { method: 'POST' })
  await closeRuntime(hostedRuntime)
  hostedRuntime = undefined

  const conversationId = 'contract-conversation'
  const prompt = 'prove durable SSE history'
  const artifactBytes = Buffer.from('deterministic local artifact\n', 'utf8')
  const upload = await uploadRequest(runtime, 'workflow-notes.txt', artifactBytes, conversationId)
  assert.equal(upload.response.status, 200)
  const artifactId = upload.body.path
  assert.match(artifactId, /^[0-9a-f-]{36}$/iu)

  const listed = await jsonRequest(runtime, '/v1/chat/artifacts?conversation_id=' + conversationId)
  assert.equal(listed.response.status, 200)
  assert.equal(listed.body.artifacts.length, 1)
  assert.equal(listed.body.artifacts[0].id, artifactId)

  const download = await rawRequest(runtime, '/v1/chat/artifacts/' + artifactId + '/download')
  assert.equal(download.status, 200)
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), artifactBytes)

  const completion = await rawRequest(runtime, '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'awp-demo',
      conversation_id: conversationId,
      stream: true,
      messages: [{ id: 'contract-user-1', role: 'user', content: prompt }],
    }),
  })
  assert.equal(completion.status, 200)
  assert.match(completion.headers.get('content-type') || '', /text\/event-stream/u)
  const rawStream = await completion.text()
  assert.match(rawStream, /\[DONE\]/u)
  const streamedText = rawStream.split(/\r?\n/u)
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)))
    .map((event) => typeof event.delta === 'string' ? event.delta : '')
    .join('')
  assert.match(streamedText, /prove durable SSE history/u)

  const history = await jsonRequest(runtime, '/v1/chat/history/' + conversationId)
  assert.equal(history.response.status, 200)
  assert.equal(history.body.messages.length, 2)

  const pollutionKey = ['__', 'proto', '__'].join('')
  const pollution = await jsonRequest(runtime, '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"' + pollutionKey + '":{"polluted":true},"messages":[]}',
  })
  assert.equal(pollution.response.status, 400)
  assert.equal(Object.prototype.polluted, undefined)
  for (const reserved of ['__proto__', 'constructor', 'prototype']) {
    const badId = await jsonRequest(runtime, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversation_id: reserved, messages: [] }),
    })
    assert.equal(badId.response.status, 400)
  }

  const traversal = await uploadRequest(runtime, '../escape.txt', Buffer.from('blocked'), conversationId)
  assert.equal(traversal.response.status, 400)
  const oversized = await uploadRequest(
    runtime,
    'too-large.txt',
    Buffer.alloc(DEMO_LIMITS.artifactBytes + 1, 0x61),
    conversationId,
  )
  assert.equal(oversized.response.status, 413)
  for (let index = 1; index < DEMO_LIMITS.conversations; index++) {
    const response = await rawRequest(runtime, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversation_id: 'capacity-conversation-' + index,
        messages: [{
          id: 'capacity-message-' + index,
          role: 'user',
          content: 'bounded message ' + index,
        }],
      }),
    })
    assert.equal(response.status, 200)
    await response.text()
  }
  const stateAtConversationLimit = await readFile(stateFile, 'utf8')
  const conversationOverflow = await jsonRequest(runtime, '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      conversation_id: 'capacity-overflow',
      messages: [{ id: 'overflow-message', role: 'user', content: 'must not persist' }],
    }),
  })
  assert.equal(conversationOverflow.response.status, 413)
  assert.deepEqual(conversationOverflow.body, { error: 'capacity exceeded' })
  assert.equal(await readFile(stateFile, 'utf8'), stateAtConversationLimit)

  for (let index = 1; index < DEMO_LIMITS.artifacts; index++) {
    const response = await uploadRequest(runtime, 'bounded-' + index + '.txt', Buffer.from('x'), conversationId)
    assert.equal(response.response.status, 200)
  }
  const stateAtArtifactLimit = await readFile(stateFile, 'utf8')
  const filesAtArtifactLimit = (await readdir(join(temporaryDirectory, 'attachments'))).sort()
  assert.equal(filesAtArtifactLimit.length, DEMO_LIMITS.artifacts)
  assert.equal(filesAtArtifactLimit.some((name) => name.endsWith('.tmp')), false)

  const artifactOverflow = await uploadRequest(runtime, 'artifact-overflow.txt', Buffer.from('must-not-persist'), conversationId)
  assert.equal(artifactOverflow.response.status, 413)
  assert.deepEqual(artifactOverflow.body, { error: 'capacity exceeded' })
  assert.equal(await readFile(stateFile, 'utf8'), stateAtArtifactLimit)
  assert.deepEqual((await readdir(join(temporaryDirectory, 'attachments'))).sort(), filesAtArtifactLimit)

  const oldToken = runtime.token
  await closeRuntime(runtime)
  runtime = undefined

  runtime = await startDemoControlPlane({
    host: '127.0.0.1',
    port: 0,
    stateFile,
    hostedAuthOptIn: '0',
    allowedOrigins: [allowedOrigin],
  })
  assert.notEqual(runtime.token, oldToken)
  const staleCapability = await jsonRequest(runtime, '/v1/chat/history', { demoToken: oldToken })
  assert.equal(staleCapability.response.status, 401)

  const restored = await jsonRequest(runtime, '/v1/chat/history/' + conversationId)
  assert.equal(restored.response.status, 200)
  assert.equal(restored.body.messages.length, 2)
  const restoredArtifacts = await jsonRequest(runtime, '/v1/chat/artifacts?conversation_id=' + conversationId)
  assert.equal(restoredArtifacts.response.status, 200)
  assert.equal(restoredArtifacts.body.artifacts.length, DEMO_LIMITS.artifacts)

  const postRestartConversationOverflow = await jsonRequest(runtime, '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      conversation_id: 'restart-overflow',
      messages: [{ id: 'restart-message', role: 'user', content: 'must not persist' }],
    }),
  })
  assert.equal(postRestartConversationOverflow.response.status, 413)
  const postRestartArtifactOverflow = await uploadRequest(
    runtime,
    'restart-overflow.txt',
    Buffer.from('must-not-persist'),
    conversationId,
  )
  assert.equal(postRestartArtifactOverflow.response.status, 413)
  assert.equal(await readFile(stateFile, 'utf8'), stateAtArtifactLimit)

  await expectNotFound(runtime, '/v1/admin')
  await expectNotFound(runtime, '/v1/auth/refresh-key', { method: 'POST' })
  await expectNotFound(runtime, '/v1/chat/history/missing/messages/extra')

  const invalidStateFile = join(temporaryDirectory, 'invalid-state.json')
  const invalidState = '{"version":1,"conversations":{"constructor":{}},"artifacts":{}}\n'
  await writeFile(invalidStateFile, invalidState, 'utf8')
  await assert.rejects(
    startDemoControlPlane({ host: '127.0.0.1', port: 0, stateFile: invalidStateFile }),
    /invalid_state/u,
  )
  assert.equal(await readFile(invalidStateFile, 'utf8'), invalidState)

  const oversizedStateFile = join(temporaryDirectory, 'oversized-state.json')
  const oversizedState = 'x'.repeat(DEMO_LIMITS.stateBytes + 1)
  await writeFile(oversizedStateFile, oversizedState, 'utf8')
  await assert.rejects(
    startDemoControlPlane({ host: '127.0.0.1', port: 0, stateFile: oversizedStateFile }),
    /invalid_state_file/u,
  )
  assert.equal((await readFile(oversizedStateFile)).length, oversizedState.length)

  process.stdout.write(
    '[demo-contract] loopback bind, ephemeral capability, strict CORS, opaque IDs, bounded atomic state/artifacts, restart persistence, and retired-route checks passed\n',
  )
} finally {
  await closeRuntime(hostedRuntime).catch(() => {})
  await closeRuntime(runtime).catch(() => {})
  await rm(temporaryDirectory, { recursive: true, force: true })
}