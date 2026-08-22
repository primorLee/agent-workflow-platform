import { createServer, request as httpRequest, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const lockMocks = vi.hoisted(() => ({
  deleteLockFile: vi.fn(() => true),
  ensureIdeDir: vi.fn(() => 'synthetic-lock-root'),
  mintAuthToken: vi.fn(() => 't'.repeat(43)),
  writeLockFile: vi.fn(() => 'synthetic-lock-root/lock.json'),
}))

vi.mock('../awp-ide-server/lock-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../awp-ide-server/lock-file')>()
  return { ...actual, ...lockMocks }
})

vi.mock('../awp-ide-server/tools', () => ({
  AWP_IDE_TOOLS: [],
  dispatchAwpIdeTool: vi.fn(async () => ({ content: [] })),
}))

vi.mock('../awp-ide-server/request-context', () => ({
  runWithConvId: async (_id: string, run: () => Promise<unknown>) => run(),
}))

import {
  buildAwpIdeUrl,
  getServerInfo,
  normalizeAwpIdeLoopbackHost,
  startAwpIdeServer,
  stopAwpIdeServer,
} from '../awp-ide-server/server'

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function reservePort(host = '127.0.0.1'): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await closeServer(server)
  return port
}

async function expectImmediatelyRebindable(port: number, host = '127.0.0.1'): Promise<void> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  await closeServer(server)
}

async function postMcp(url: string, token: string, conversation: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'x-awp-conv': conversation,
      },
    }, (res) => {
      res.resume()
      res.once('end', () => resolve(res.statusCode ?? 0))
    })
    req.once('error', reject)
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }))
  })
}

beforeEach(async () => {
  await stopAwpIdeServer()
  vi.clearAllMocks()
  lockMocks.ensureIdeDir.mockReturnValue('synthetic-lock-root')
  lockMocks.mintAuthToken.mockReturnValue('t'.repeat(43))
  lockMocks.writeLockFile.mockReturnValue('synthetic-lock-root/lock.json')
})

afterEach(async () => {
  await stopAwpIdeServer()
})

describe('awp-ide loopback authority', () => {
  it('canonicalizes the full IPv4 loopback block and brackets IPv6 URLs', () => {
    expect(normalizeAwpIdeLoopbackHost('127.0.0.1')).toBe('127.0.0.1')
    expect(normalizeAwpIdeLoopbackHost('127.255.8.9')).toBe('127.255.8.9')
    expect(normalizeAwpIdeLoopbackHost('[::1]')).toBe('::1')
    expect(buildAwpIdeUrl('::1', 43123)).toBe('http://[::1]:43123/mcp')
  })

  it.each([
    'localhost',
    'localhost.evil.invalid',
    '0.0.0.0',
    '10.0.0.1',
    '192.0.2.1',
    '127.0.0.1.evil.invalid',
    '127.00.0.1',
    '127.0.0.1:43123',
    ' user@127.0.0.1',
  ])('rejects ambiguous or non-loopback host %s before touching the lock root', async (host) => {
    await expect(startAwpIdeServer({ desktopVersion: '0.1.0', host }))
      .rejects.toThrow(/host_not_loopback/u)
    expect(lockMocks.ensureIdeDir).not.toHaveBeenCalled()
    expect(getServerInfo()).toEqual({ running: false })
  })

  it('builds an IPv6 loopback endpoint without an ambiguous authority', async () => {
    try {
      const result = await startAwpIdeServer({ desktopVersion: '0.1.0', host: '::1' })
      expect(result.url).toMatch(/^http:\/\/\[::1\]:[1-9][0-9]*\/mcp$/u)
      expect(lockMocks.writeLockFile).toHaveBeenCalledWith(
        expect.objectContaining({ host: '::1', url: result.url }),
        undefined,
      )
    } catch (error) {
      expect(['EADDRNOTAVAIL', 'EAFNOSUPPORT']).toContain((error as NodeJS.ErrnoException).code)
      expect(getServerInfo()).toEqual({ running: false })
    }
  })
})

describe('awp-ide fail-closed startup', () => {
  it('rejects an unsafe lock root before listen and leaves the requested port free', async () => {
    const port = await reservePort()
    lockMocks.ensureIdeDir.mockImplementationOnce(() => {
      throw new Error('ide_lock_root_marker_invalid')
    })

    await expect(startAwpIdeServer({
      desktopVersion: '0.1.0',
      host: '127.0.0.1',
      port,
      appDataRoot: 'synthetic-app-root',
    })).rejects.toThrow(/marker_invalid/u)

    expect(lockMocks.writeLockFile).not.toHaveBeenCalled()
    expect(getServerInfo()).toEqual({ running: false })
    await expectImmediatelyRebindable(port)
  })

  it('closes HTTP and MCP when lock creation fails after bind', async () => {
    const port = await reservePort()
    lockMocks.writeLockFile.mockImplementationOnce(() => {
      throw new Error('synthetic_lock_write_failed')
    })

    await expect(startAwpIdeServer({
      desktopVersion: '0.1.0',
      host: '127.0.0.1',
      port,
      appDataRoot: 'synthetic-app-root',
    })).rejects.toThrow(/lock_write_failed/u)

    expect(lockMocks.ensureIdeDir).toHaveBeenCalledBefore(lockMocks.writeLockFile)
    expect(getServerInfo()).toEqual({ running: false })
    await expectImmediatelyRebindable(port)
  })

  it('logs only context presence, never conversation values or lock paths', async () => {
    const secretConversation = 'conversation-private-fixture'
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const result = await startAwpIdeServer({
        desktopVersion: '0.1.0',
        host: '127.0.0.1',
        appDataRoot: 'synthetic-app-root',
      })
      expect(await postMcp(result.url, result.token, secretConversation)).toBe(200)
      const rendered = JSON.stringify(stderr.mock.calls)
      expect(rendered).toContain('conversation_present')
      expect(rendered).not.toContain(secretConversation)
      expect(rendered).not.toContain(result.lockPath)
      expect(rendered).not.toContain(result.url)
    } finally {
      stderr.mockRestore()
    }
  })
})
