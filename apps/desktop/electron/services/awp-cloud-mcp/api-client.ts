/**
 * Optional HTTP adapter for a generic project-artifact service.
 *
 * The public control plane in this repository does not implement these
 * endpoints. Operators can point AWP_API_BASE at a compatible service when
 * they want cloud-backed files; the desktop demo works without this adapter.
 */

import { existsSync, readFileSync } from 'node:fs'

export interface CloudClientOpts {
  /** Explicit in-process opt-in. The stdio entry point uses the env opt-in. */
  optIn?: boolean
  apiBase?: string
  apiToken?: string
  tokenPath?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export const CLOUD_API_LIMITS = Object.freeze({
  requestUrlChars: 8_192,
  requestBodyBytes: 24 * 1024 * 1024,
  jsonResponseBytes: 2 * 1024 * 1024,
  errorResponseBytes: 64 * 1024,
  fileResponseBytes: 16 * 1024 * 1024,
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 120_000,
})

export interface FileMeta {
  path: string
  sha256: string
  size: number
  content_type: string
  created_at: string
  updated_at: string
}

export interface ListFilesResponse {
  prefix: string
  files: FileMeta[]
  truncated: boolean
}

export interface SearchHit {
  path: string
  line: number
  text: string
}

export interface SearchResponse {
  query: string
  hits: SearchHit[]
  truncated: boolean
}

export interface PutFileResponse {
  ok: boolean
  path: string
  sha256: string
  size: number
  updated_at: string
}

export class CloudApiError extends Error {
  constructor(public status: number, public detail: string) {
    super(`cloud api ${status}: ${detail}`)
    this.name = 'CloudApiError'
  }
}

export class CloudConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CloudConfigurationError'
  }
}

export class CloudProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CloudProtocolError'
  }
}

function contentLength(response: Response): number | null {
  const raw = response.headers.get('content-length')
  if (raw === null) return null
  if (!/^\d+$/u.test(raw)) {
    throw new CloudProtocolError('cloud API response has an invalid content length')
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) {
    throw new CloudProtocolError('cloud API response exceeds the configured size limit')
  }
  return value
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = contentLength(response)
  if (declaredLength !== null && declaredLength > maxBytes) {
    throw new CloudProtocolError('cloud API response exceeds the configured size limit')
  }
  if (!response.body) return Buffer.alloc(0)

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new CloudProtocolError('cloud API response exceeds the configured size limit')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

function isJsonContentType(response: Response): boolean {
  const mediaType = (response.headers.get('content-type') || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
  return mediaType === 'application/json' || mediaType.endsWith('+json')
}

async function readLimitedJson<T>(response: Response, maxBytes: number): Promise<T> {
  if (!isJsonContentType(response)) {
    throw new CloudProtocolError('cloud API response must be JSON')
  }
  const bytes = await readLimitedBody(response, maxBytes)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new CloudProtocolError('cloud API response is not valid UTF-8 JSON')
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new CloudProtocolError('cloud API response contains invalid JSON')
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  return host === 'localhost'
    || host.endsWith('.localhost')
    || host === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(host)
}

function requireApiBase(value: string | undefined): string {
  const raw = value?.trim()
  if (!raw) {
    throw new CloudConfigurationError('cloud artifact API base is required; configure AWP_API_BASE explicitly')
  }
  if (
    raw.length > 2_048 ||
    raw !== value ||
    /[\u0000-\u001f\u007f\\]/u.test(raw) ||
    /%(?![0-9a-fA-F]{2})/u.test(raw)
  ) {
    throw new CloudConfigurationError('cloud artifact API base must be a strict absolute HTTP(S) URL')
  }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new CloudConfigurationError('cloud artifact API base must be an absolute HTTP(S) URL')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CloudConfigurationError('cloud artifact API base must use HTTP(S)')
  }
  if (parsed.username || parsed.password) {
    throw new CloudConfigurationError('cloud artifact API base must not contain credentials')
  }
  if (parsed.search || parsed.hash) {
    throw new CloudConfigurationError('cloud artifact API base must not contain a query or fragment')
  }
  if (parsed.protocol !== 'https:' && !isLoopbackHost(parsed.hostname)) {
    throw new CloudConfigurationError('non-loopback cloud artifact API base must use HTTPS')
  }

  return parsed.toString().replace(/\/+$/, '')
}

export class CloudClient {
  private readonly apiBase: string
  private readonly apiToken: string | null
  private readonly tokenPath: string | null
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(opts: CloudClientOpts = {}) {
    const optedIn = opts.optIn ?? process.env.AWP_CLOUD_ARTIFACT_MCP_OPT_IN === '1'
    if (!optedIn) {
      throw new CloudConfigurationError(
        'cloud artifact MCP is disabled; set AWP_CLOUD_ARTIFACT_MCP_OPT_IN=1 to enable it explicitly',
      )
    }

    this.apiBase = requireApiBase(opts.apiBase ?? process.env.AWP_API_BASE)

    const optionToken = opts.apiToken?.trim()
    const optionTokenPath = opts.tokenPath?.trim()
    const envToken = process.env.AWP_API_TOKEN?.trim()
    const envTokenPath = process.env.AWP_API_TOKEN_PATH?.trim()
    if (opts.apiToken !== undefined) {
      if (!optionToken) throw new CloudConfigurationError('configured cloud artifact API token is empty')
      this.apiToken = optionToken
      this.tokenPath = null
    } else if (opts.tokenPath !== undefined) {
      if (!optionTokenPath) throw new CloudConfigurationError('configured cloud artifact token path is empty')
      this.apiToken = null
      this.tokenPath = optionTokenPath
    } else if (envToken) {
      this.apiToken = envToken
      this.tokenPath = null
    } else if (envTokenPath) {
      this.apiToken = null
      this.tokenPath = envTokenPath
    } else {
      throw new CloudConfigurationError(
        'cloud artifact authentication is required; configure AWP_API_TOKEN or AWP_API_TOKEN_PATH explicitly',
      )
    }

    this.fetchImpl = opts.fetchImpl ?? fetch
    const timeoutMs = opts.timeoutMs ?? CLOUD_API_LIMITS.defaultTimeoutMs
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CLOUD_API_LIMITS.maxTimeoutMs) {
      throw new CloudConfigurationError('cloud artifact timeout is outside the allowed range')
    }
    this.timeoutMs = timeoutMs
  }

  private readToken(): string {
    if (this.apiToken) return this.apiToken
    if (!this.tokenPath || !existsSync(this.tokenPath)) {
      throw new CloudConfigurationError('configured cloud artifact token file is missing')
    }
    let token: string
    try {
      token = readFileSync(this.tokenPath, 'utf-8').trim()
    } catch {
      throw new CloudConfigurationError('configured cloud artifact token file cannot be read')
    }
    if (!token) throw new CloudConfigurationError('configured cloud artifact token file is empty')
    return token
  }

  /** Validate credentials before a stdio server advertises any tools. */
  assertReady(): void {
    this.readToken()
  }

  private requestUrl(path: string): string {
    const url = `${this.apiBase}${path}`
    if (url.length > CLOUD_API_LIMITS.requestUrlChars) {
      throw new CloudProtocolError('cloud API request URL exceeds the configured size limit')
    }
    return url
  }

  private async withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new CloudApiError(0, 'request timed out'))
      }, this.timeoutMs)
      timer.unref?.()
    })

    try {
      return await Promise.race([operation(controller.signal), timeout])
    } catch (error) {
      if (
        error instanceof CloudApiError ||
        error instanceof CloudConfigurationError ||
        error instanceof CloudProtocolError
      ) {
        throw error
      }
      throw new CloudApiError(0, controller.signal.aborted ? 'request timed out' : 'request failed')
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private async rejectApiError(response: Response): Promise<never> {
    try {
      await readLimitedJson<unknown>(response, CLOUD_API_LIMITS.errorResponseBytes)
    } catch {
      // The remote body is untrusted and may contain credentials or URLs.
      // Consume it only under the cap; never reflect it into an error.
    }
    throw new CloudApiError(response.status, 'request rejected')
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    let encodedBody: string | undefined
    if (body !== undefined) {
      try {
        encodedBody = JSON.stringify(body)
      } catch {
        throw new CloudProtocolError('cloud API request could not be encoded')
      }
      if (Buffer.byteLength(encodedBody, 'utf-8') > CLOUD_API_LIMITS.requestBodyBytes) {
        throw new CloudProtocolError('cloud API request exceeds the configured size limit')
      }
    }

    return this.withDeadline(async (signal) => {
      const res = await this.fetchImpl(this.requestUrl(path), {
        method,
        headers: {
          authorization: `Bearer ${this.readToken()}`,
          ...(encodedBody === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: encodedBody,
        signal,
        redirect: 'error',
      })
      if (!res.ok) return this.rejectApiError(res)
      return readLimitedJson<T>(res, CLOUD_API_LIMITS.jsonResponseBytes)
    })
  }

  async getFile(path: string): Promise<{ content: string; encoding: 'utf-8' | 'base64'; meta: FileMeta }> {
    return this.withDeadline(async (signal) => {
      const res = await this.fetchImpl(
        this.requestUrl(`/v1/project/files/get?path=${encodeURIComponent(path)}`),
        {
          method: 'GET',
          headers: { authorization: `Bearer ${this.readToken()}` },
          signal,
          redirect: 'error',
        },
      )
      if (!res.ok) return this.rejectApiError(res)
      const bytes = await readLimitedBody(res, CLOUD_API_LIMITS.fileResponseBytes)
      const contentType = res.headers.get('content-type') || 'application/octet-stream'
      const normalizedContentType = contentType.toLowerCase()
      const isText = normalizedContentType.startsWith('text/')
        || normalizedContentType.includes('json')
        || normalizedContentType.includes('xml')
      return {
        content: isText ? bytes.toString('utf-8') : bytes.toString('base64'),
        encoding: isText ? 'utf-8' : 'base64',
        meta: {
          path,
          sha256: res.headers.get('x-file-sha256') || '',
          size: bytes.length,
          content_type: contentType.split(';')[0].trim(),
          created_at: '',
          updated_at: res.headers.get('x-file-updated-at') || '',
        },
      }
    })
  }

  async putFile(path: string, content: string | Buffer, contentType = 'text/plain'): Promise<PutFileResponse> {
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content
    return this.req<PutFileResponse>('PUT', '/v1/project/files/put', {
      path,
      content_b64: bytes.toString('base64'),
      content_type: contentType,
    })
  }

  async deleteFile(path: string): Promise<{ ok: boolean; deleted: string }> {
    return this.req('DELETE', `/v1/project/files/delete?path=${encodeURIComponent(path)}`)
  }

  async listFiles(prefix = '/', limit = 200): Promise<ListFilesResponse> {
    return this.req('GET', `/v1/project/files/list?prefix=${encodeURIComponent(prefix)}&limit=${limit}`)
  }

  async searchFiles(query: string, limit = 50): Promise<SearchResponse> {
    return this.req('GET', `/v1/project/files/search?q=${encodeURIComponent(query)}&limit=${limit}`)
  }

  async statFile(path: string): Promise<FileMeta> {
    return this.req('GET', `/v1/project/files/stat?path=${encodeURIComponent(path)}`)
  }
}
