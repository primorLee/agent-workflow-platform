/**
 * Unit tests for `bridge/ssh-connect.ts` — the unified ssh2 Client helper.
 *
 * Pinned behaviors:
 *   1. Every `sshConnect` result has `hostVerifier` wired up.
 *   2. On the `ready` event, resolves with the Client.
 *   3. On the `error` event, rejects with `SshConnectError` and closes the
 *      client (no leaked sockets).
 *   4. On readyTimeout, rejects AND closes the client.
 *   5. password and privateKey are forwarded; privateKey wins when both set.
 *   6. `attachHostVerifier` installs a verifier on an existing ConnectConfig.
 *
 * We mock the ssh2 Client so tests don't need a real network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter as TopEventEmitter } from 'node:events'

// Hoisted version re-imports EventEmitter inside the factory so the mock
// class has a real base at the time vi.mock() runs (which is BEFORE the
// top-level imports are materialized).
type EE = InstanceType<typeof TopEventEmitter>

interface FakeSshClient extends EE {
  connectOpts: Record<string, unknown> | undefined
  connectThrows: Error | null
  ended: boolean
  connect(opts: Record<string, unknown>): void
  end(): void
}

const H = vi.hoisted(() => {
  const state = {
    lastFakeClient: null as FakeSshClient | null,
    nextConnectThrows: null as Error | null,
  }
  return { state }
})

vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('node:events')
  class MockSSHClient extends EventEmitter {
    connectOpts: Record<string, unknown> | undefined = undefined
    connectThrows: Error | null = null
    ended = false
    constructor() {
      super()
      this.connectThrows = H.state.nextConnectThrows
      H.state.nextConnectThrows = null
      H.state.lastFakeClient = this as unknown as FakeSshClient
    }
    connect(opts: Record<string, unknown>): void {
      this.connectOpts = opts
      if (this.connectThrows) throw this.connectThrows
    }
    end(): void {
      this.ended = true
    }
  }
  return { Client: MockSSHClient }
})

vi.mock('../../utils/logger', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}))

vi.mock('../ssh-known-hosts', () => ({
  makeHostVerifier: vi.fn((host: string, port: number) => {
    const verifier = (_key: Buffer) => true
    ;(verifier as unknown as { __bound: string }).__bound = `${host}:${port}`
    return verifier
  }),
}))

describe('ssh-connect', () => {
  beforeEach(() => {
    H.state.lastFakeClient = null
    H.state.nextConnectThrows = null
    vi.clearAllMocks()
  })

  it('wires hostVerifier bound to host:port and resolves on ready', async () => {
    const { sshConnect } = await import('../ssh-connect')
    const p = sshConnect({ host: 'vm', port: 2222, username: 'vmuser', password: 'x' })
    // simulate successful connect
    H.state.lastFakeClient!.emit('ready')
    const client = await p
    expect(client).toBe(H.state.lastFakeClient)
    const opts = H.state.lastFakeClient!.connectOpts!
    expect(opts.host).toBe('vm')
    expect(opts.port).toBe(2222)
    expect(opts.username).toBe('vmuser')
    expect(opts.password).toBe('x')
    expect(typeof opts.hostVerifier).toBe('function')
    expect((opts.hostVerifier as unknown as { __bound: string }).__bound).toBe('vm:2222')
    // password path: privateKey should NOT be set.
    expect(opts.privateKey).toBeUndefined()
  })

  it('privateKey takes precedence over password', async () => {
    const { sshConnect } = await import('../ssh-connect')
    const key = Buffer.from('PRIV')
    const p = sshConnect({
      host: 'vm', username: 'u', password: 'pw', privateKey: key,
    })
    H.state.lastFakeClient!.emit('ready')
    await p
    const opts = H.state.lastFakeClient!.connectOpts!
    expect(opts.privateKey).toBe(key)
    expect(opts.password).toBeUndefined()
  })

  it('rejects and closes the client on error', async () => {
    const { sshConnect, SshConnectError } = await import('../ssh-connect')
    const p = sshConnect({ host: 'vm', username: 'u', password: 'p' })
    H.state.lastFakeClient!.emit('error', new Error('boom'))
    await expect(p).rejects.toBeInstanceOf(SshConnectError)
    expect(H.state.lastFakeClient!.ended).toBe(true)
  })

  it('rejects and closes the client on readyTimeout', async () => {
    vi.useFakeTimers()
    try {
      const { sshConnect, SshConnectError } = await import('../ssh-connect')
      const p = sshConnect({
        host: 'vm', username: 'u', password: 'p', readyTimeout: 10,
      })
      vi.advanceTimersByTime(11_000)
      await expect(p).rejects.toBeInstanceOf(SshConnectError)
      expect(H.state.lastFakeClient!.ended).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('synchronous .connect() throws are reported as SshConnectError', async () => {
    H.state.nextConnectThrows = new Error('sync-boom')
    const { sshConnect, SshConnectError } = await import('../ssh-connect')
    await expect(
      sshConnect({ host: 'vm', username: 'u', password: 'p' }),
    ).rejects.toBeInstanceOf(SshConnectError)
  })

  it('attachHostVerifier installs a verifier on a ConnectConfig', async () => {
    const { attachHostVerifier } = await import('../ssh-connect')
    const cfg: Record<string, unknown> = { host: 'vm', port: 22, username: 'u' }
    attachHostVerifier(cfg as never, 'vm', 22)
    expect(typeof cfg.hostVerifier).toBe('function')
    expect((cfg.hostVerifier as unknown as { __bound: string }).__bound).toBe('vm:22')
  })
})
