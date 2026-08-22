/**
 * Unit tests for the optional external artifact MCP adapter.
 *
 * Scope: fail-closed configuration, CloudClient wire format, authentication,
 * and dispatch routing. No real network is used. This repository intentionally
 * does not implement the external /v1/project/files compatibility API.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CLOUD_API_LIMITS,
  CloudApiError,
  CloudClient,
  CloudConfigurationError,
  CloudProtocolError,
  type CloudClientOpts,
} from '../awp-cloud-mcp/api-client'
import {
  dispatchCloudTool,
  initializeCloudToolClient,
  _setClientForTesting,
} from '../awp-cloud-mcp/tools'

const REMOTE_API_BASE = 'https://artifacts.example.test'
const JSON_HEADERS = { 'content-type': 'application/json' }
const ENV_KEYS = [
  'AWP_CLOUD_ARTIFACT_MCP_OPT_IN',
  'AWP_API_BASE',
  'AWP_API_TOKEN',
  'AWP_API_TOKEN_PATH',
] as const

let tmp: string
let tokenPath: string
let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>

beforeEach(() => {
  originalEnv = {}
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key]
    delete process.env[key]
  }

  tmp = mkdtempSync(join(tmpdir(), 'awp-cloud-mcp-test-'))
  tokenPath = join(tmp, 'api_token')
  writeFileSync(tokenPath, 'synthetic-demo-token', 'utf-8')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  _setClientForTesting(null)
  for (const key of ENV_KEYS) {
    const previous = originalEnv[key]
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
})

function configuredClient(overrides: Partial<CloudClientOpts> = {}): CloudClient {
  return new CloudClient({
    optIn: true,
    apiBase: REMOTE_API_BASE,
    tokenPath,
    ...overrides,
  })
}

describe('CloudClient fail-closed configuration', () => {
  it('rejects configuration without the explicit cloud artifact opt-in', () => {
    const fetchMock = vi.fn()
    expect(() => new CloudClient({
      apiBase: REMOTE_API_BASE,
      tokenPath,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })).toThrow(/disabled.*OPT_IN=1/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects opt-in without an explicit API base', () => {
    expect(() => new CloudClient({ optIn: true, tokenPath })).toThrow(/API base is required/i)
  })

  it('rejects opt-in without explicit authentication', () => {
    expect(() => new CloudClient({ optIn: true, apiBase: REMOTE_API_BASE })).toThrow(/authentication is required/i)
  })

  it('rejects plaintext HTTP for a non-loopback API', () => {
    expect(() => new CloudClient({
      optIn: true,
      apiBase: 'http://artifacts.example.test',
      tokenPath,
    })).toThrow(/non-loopback.*HTTPS/i)
  })

  const credentialUrl = new URL(REMOTE_API_BASE)
  credentialUrl.username = ['invalid', 'user', 'fixture'].join('-')
  credentialUrl.password = ['invalid', 'credential', 'fixture'].join('-')

  it.each([
    'ftp://artifacts.example.test',
    credentialUrl.toString(),
    'https://artifacts.example.test?target=other',
    'https://artifacts.example.test#fragment',
  ])('rejects unsafe API base %s', (apiBase) => {
    expect(() => new CloudClient({ optIn: true, apiBase, tokenPath })).toThrow(CloudConfigurationError)
  })

  it('allows explicit loopback HTTP without making it a default', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ prefix: '/', files: [], truncated: false }), { status: 200, headers: JSON_HEADERS }),
    )
    const client = configuredClient({
      apiBase: 'http://127.0.0.1:8787',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    await client.listFiles()
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8787/v1/project/files/list?prefix=%2F&limit=200')
  })

  it('accepts all required settings from the environment', async () => {
    process.env.AWP_CLOUD_ARTIFACT_MCP_OPT_IN = '1'
    process.env.AWP_API_BASE = REMOTE_API_BASE
    process.env.AWP_API_TOKEN_PATH = tokenPath
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ prefix: '/', files: [], truncated: false }), { status: 200, headers: JSON_HEADERS }),
    )
    const client = new CloudClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    client.assertReady()
    await client.listFiles()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('validates the token file before the stdio server can advertise tools', () => {
    process.env.AWP_CLOUD_ARTIFACT_MCP_OPT_IN = '1'
    process.env.AWP_API_BASE = REMOTE_API_BASE
    process.env.AWP_API_TOKEN_PATH = join(tmp, 'does-not-exist')

    expect(() => initializeCloudToolClient()).toThrow(/token file is missing/i)
  })

  it('dispatch fails closed without configuration and never calls fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const result = await dispatchCloudTool('cloud_read_file', { path: '/artifact.txt' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/disabled.*OPT_IN=1/i)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})

describe('CloudClient.getFile', () => {
  it('sends a Bearer header and decodes text as UTF-8', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(Buffer.from('hello!', 'utf-8'), {
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'x-file-sha256': 'deadbeef',
          'x-file-size': '6',
          'x-file-updated-at': '2026-05-18T00:00:00Z',
        },
      }),
    )
    const client = configuredClient({ fetchImpl: fetchMock as unknown as typeof fetch })
    const result = await client.getFile('/workspace/demo/y.txt')

    expect(result.content).toBe('hello!')
    expect(result.encoding).toBe('utf-8')
    expect(result.meta.sha256).toBe('deadbeef')
    expect(result.meta.size).toBe(6)
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${REMOTE_API_BASE}/v1/project/files/get?path=%2Fworkspace%2Fdemo%2Fy.txt`,
    )
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      authorization: 'Bearer synthetic-demo-token',
    })
  })

  it('returns base64 for a binary content type', async () => {
    const bin = Buffer.from([0x00, 0x01, 0xff])
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(bin, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      }),
    )
    const client = configuredClient({ fetchImpl: fetchMock as unknown as typeof fetch })
    const result = await client.getFile('/workspace/demo/bin.dat')

    expect(result.encoding).toBe('base64')
    expect(Buffer.from(result.content, 'base64').equals(bin)).toBe(true)
  })

  it('throws a bounded generic CloudApiError on a 4xx response', async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ detail: 'not found: /x/y' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const client = configuredClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    await expect(client.getFile('/x/y')).rejects.toBeInstanceOf(CloudApiError)
    try {
      await client.getFile('/x/y')
    } catch (error) {
      expect((error as CloudApiError).status).toBe(404)
      expect((error as CloudApiError).detail).toBe('request rejected')
    }
  })

  it('throws before fetch when the configured token file is missing', async () => {
    const fetchMock = vi.fn()
    const client = configuredClient({
      tokenPath: join(tmp, 'does-not-exist'),
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    await expect(client.getFile('/x')).rejects.toThrow(/token file is missing/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('CloudClient.putFile', () => {
  it('base64-encodes string content and sends JSON with PUT', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, path: '/workspace/demo/y', sha256: 'abc', size: 5, updated_at: 'now' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    const client = configuredClient({ fetchImpl: fetchMock as unknown as typeof fetch })
    const result = await client.putFile('/workspace/demo/y', 'hello', 'text/plain')

    expect(result.ok).toBe(true)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({
      path: '/workspace/demo/y',
      content_b64: Buffer.from('hello').toString('base64'),
      content_type: 'text/plain',
    })
  })
})

describe('CloudClient list/search/delete paths', () => {
  it('preserves the external project/files wire contract', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/list')) {
        return Promise.resolve(new Response(JSON.stringify({ prefix: '/', files: [], truncated: false }), { status: 200, headers: JSON_HEADERS }))
      }
      if (url.includes('/search')) {
        return Promise.resolve(new Response(JSON.stringify({ query: 'q', hits: [], truncated: false }), { status: 200, headers: JSON_HEADERS }))
      }
      if (url.includes('/delete')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, deleted: '/x' }), { status: 200, headers: JSON_HEADERS }))
      }
      return Promise.resolve(new Response('{}', { status: 200, headers: JSON_HEADERS }))
    })
    const client = configuredClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    await client.listFiles('/workspace/demo', 50)
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${REMOTE_API_BASE}/v1/project/files/list?prefix=%2Fworkspace%2Fdemo&limit=50`,
    )
    await client.searchFiles('needle', 10)
    expect(fetchMock.mock.calls[1][0]).toBe(
      `${REMOTE_API_BASE}/v1/project/files/search?q=needle&limit=10`,
    )
    await client.deleteFile('/workspace/demo/y')
    expect(fetchMock.mock.calls[2][0]).toBe(
      `${REMOTE_API_BASE}/v1/project/files/delete?path=%2Fworkspace%2Fdemo%2Fy`,
    )
  })
})

describe('CloudClient bounded authenticated transport', () => {
  it('rejects out-of-range timeouts before any request', () => {
    expect(() => configuredClient({ timeoutMs: 0 })).toThrow(CloudConfigurationError)
    expect(() => configuredClient({ timeoutMs: CLOUD_API_LIMITS.maxTimeoutMs + 1 }))
      .toThrow(CloudConfigurationError)
  })

  it('sets redirect=error and a deadline signal on authenticated JSON requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ prefix: '/', files: [], truncated: false }), {
        status: 200,
        headers: JSON_HEADERS,
      }),
    )
    const client = configuredClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    await client.listFiles()
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('sets redirect=error on authenticated file downloads', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }),
    )
    const client = configuredClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    await client.getFile('/safe.txt')
    expect((fetchMock.mock.calls[0][1] as RequestInit).redirect).toBe('error')
  })

  it('rejects an oversized JSON request before fetch', async () => {
    const fetchMock = vi.fn()
    const bytes = Buffer.alloc(Math.floor(CLOUD_API_LIMITS.requestBodyBytes * 3 / 4) + 1)
    const client = configuredClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    await expect(client.putFile('/oversized.bin', bytes)).rejects.toBeInstanceOf(CloudProtocolError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects non-JSON and oversized JSON responses', async () => {
    const nonJsonFetch = vi.fn().mockResolvedValue(
      new Response('not-json', { status: 200, headers: { 'content-type': 'text/plain' } }),
    )
    await expect(configuredClient({
      fetchImpl: nonJsonFetch as unknown as typeof fetch,
    }).listFiles()).rejects.toThrow(/must be JSON/i)

    const oversizedFetch = vi.fn().mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: {
          ...JSON_HEADERS,
          'content-length': String(CLOUD_API_LIMITS.jsonResponseBytes + 1),
        },
      }),
    )
    await expect(configuredClient({
      fetchImpl: oversizedFetch as unknown as typeof fetch,
    }).listFiles()).rejects.toThrow(/size limit/i)
  })

  it('enforces the JSON cap while streaming without Content-Length', async () => {
    const chunk = new Uint8Array(1024 * 1024)
    let remaining = 3
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining-- > 0) controller.enqueue(chunk)
        else controller.close()
      },
    })
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(body, { status: 200, headers: JSON_HEADERS }),
    )

    await expect(configuredClient({
      fetchImpl: fetchMock as unknown as typeof fetch,
    }).listFiles()).rejects.toThrow(/size limit/i)
  })

  it('streams file bytes under a hard cap instead of using arrayBuffer', async () => {
    const chunk = new Uint8Array(1024 * 1024)
    let remaining = 17
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining-- > 0) controller.enqueue(chunk)
        else controller.close()
      },
    })
    const response = new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    })
    const arrayBufferSpy = vi.spyOn(response, 'arrayBuffer')
    const fetchMock = vi.fn().mockResolvedValue(response)

    await expect(configuredClient({
      fetchImpl: fetchMock as unknown as typeof fetch,
    }).getFile('/oversized.bin')).rejects.toThrow(/size limit/i)
    expect(arrayBufferSpy).not.toHaveBeenCalled()
  })

  it('times out even when an injected fetch ignores AbortSignal', async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined))
    const client = configuredClient({
      fetchImpl: fetchMock as unknown as typeof fetch,
      timeoutMs: 10,
    })

    await expect(client.listFiles()).rejects.toMatchObject({
      status: 0,
      detail: 'request timed out',
    })
  })

  it('does not reflect transport, URL, token, or error-body secrets', async () => {
    const secretToken = 'synthetic-sensitive-token'
    const secretUrl = 'https://private.example.test/hidden'
    const transportFetch = vi.fn().mockRejectedValue(
      new Error('failed ' + secretUrl + ' bearer ' + secretToken),
    )
    const transportClient = configuredClient({
      apiToken: secretToken,
      tokenPath: undefined,
      fetchImpl: transportFetch as unknown as typeof fetch,
    })

    let transportMessage = ''
    try {
      await transportClient.listFiles()
    } catch (error) {
      transportMessage = error instanceof Error ? error.message : String(error)
    }
    expect(transportMessage).toContain('request failed')
    expect(transportMessage).not.toContain(secretToken)
    expect(transportMessage).not.toContain(secretUrl)

    const errorFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: secretToken + ' ' + secretUrl }), {
        status: 502,
        headers: {
          ...JSON_HEADERS,
          'content-length': String(CLOUD_API_LIMITS.errorResponseBytes + 1),
        },
      }),
    )
    let responseMessage = ''
    try {
      await configuredClient({
        apiToken: secretToken,
        tokenPath: undefined,
        fetchImpl: errorFetch as unknown as typeof fetch,
      }).listFiles()
    } catch (error) {
      responseMessage = error instanceof Error ? error.message : String(error)
    }
    expect(responseMessage).toContain('request rejected')
    expect(responseMessage).not.toContain(secretToken)
    expect(responseMessage).not.toContain(secretUrl)
  })
})
describe('dispatchCloudTool', () => {
  function makeFakeClient(impl: Partial<CloudClient>): CloudClient {
    return Object.assign(configuredClient({ fetchImpl: vi.fn() as unknown as typeof fetch }), impl)
  }

  it('routes cloud_read_file to getFile', async () => {
    const getFile = vi.fn().mockResolvedValue({
      content: 'data',
      encoding: 'utf-8',
      meta: { path: '/x', sha256: 'abc', size: 4, content_type: 'text/plain', created_at: '', updated_at: '' },
    })
    _setClientForTesting(makeFakeClient({ getFile }))

    const result = await dispatchCloudTool('cloud_read_file', { path: '/workspace/demo/y' })
    expect(result.isError).toBeFalsy()
    expect(getFile).toHaveBeenCalledWith('/workspace/demo/y')
    expect(result.content[0].text).toContain('"content": "data"')
  })

  it('rejects a missing path', async () => {
    _setClientForTesting(makeFakeClient({}))
    const result = await dispatchCloudTool('cloud_read_file', {})

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('path is required')
  })

  it('surfaces CloudApiError as an MCP error result', async () => {
    const getFile = vi.fn().mockRejectedValue(new CloudApiError(403, 'forbidden'))
    _setClientForTesting(makeFakeClient({ getFile }))
    const result = await dispatchCloudTool('cloud_read_file', { path: '/x' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('cloud api error 403: forbidden')
  })

  it('returns an MCP error for an unknown tool', async () => {
    _setClientForTesting(makeFakeClient({}))
    const result = await dispatchCloudTool('cloud_does_not_exist', {})
    expect(result.isError).toBe(true)
  })

  it('routes cloud_write_file with content and content type', async () => {
    const putFile = vi.fn().mockResolvedValue({ ok: true, path: '/x', sha256: 'a', size: 1, updated_at: 'now' })
    _setClientForTesting(makeFakeClient({ putFile }))

    await dispatchCloudTool('cloud_write_file', {
      path: '/workspace/demo/y',
      content: 'hello',
      content_type: 'text/plain',
    })
    expect(putFile).toHaveBeenCalledWith('/workspace/demo/y', 'hello', 'text/plain')
  })
})