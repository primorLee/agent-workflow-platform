import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sshBehavior = { mode: 'ok' as 'ok' | 'fail' | 'hang' }
class ConfigurableSshClient extends EventEmitter {
  connect(_options: unknown): void {
    if (sshBehavior.mode === 'ok') setImmediate(() => this.emit('ready'))
    else if (sshBehavior.mode === 'fail') setImmediate(() => this.emit('error', new Error('failed')))
  }
  end(): void { /* noop */ }
}
vi.mock('ssh2', () => ({ Client: ConfigurableSshClient }))


const sshConfigMock = vi.fn<() => { host: string; port: number; user: string } | null>(
  () => ({ host: '127.0.0.1', port: 2222, user: 'test' }),
)
vi.mock('../../utils/config', () => ({
  getAwpDir: () => 'C:\\Users\\Example\\AppData\\Roaming\\awp',
  getSshConfig: () => sshConfigMock(),
}))
const keyBundleMock = vi.fn<() => { privateKey: Buffer; keyId: string } | null>(
  () => ({ privateKey: Buffer.from('synthetic-key'), keyId: 'a'.repeat(64) }),
)
vi.mock('../../utils/ssh-private-key', () => ({
  readProvisionedSshPrivateKey: () => keyBundleMock(),
}))
vi.mock('../../utils/logger', () => ({ log: vi.fn(), logError: vi.fn() }))

const originalFetch = globalThis.fetch
let originalControlPlane: string | undefined
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
  originalControlPlane = process.env.AWP_CONTROL_PLANE_URL
  delete process.env.AWP_CONTROL_PLANE_URL
  sshConfigMock.mockReturnValue({ host: '127.0.0.1', port: 2222, user: 'test' })
  sshBehavior.mode = 'ok'
  keyBundleMock.mockReturnValue({ privateKey: Buffer.from('synthetic-key'), keyId: 'a'.repeat(64) })
  fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }))
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalControlPlane === undefined) delete process.env.AWP_CONTROL_PLANE_URL
  else process.env.AWP_CONTROL_PLANE_URL = originalControlPlane
})

describe('runConnectivityCheck', () => {
  it('performs no network request by default and still checks configured SSH', async () => {
    const { runConnectivityCheck } = await import('../connectivity-check')
    const result = await runConnectivityCheck()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.cloud_http).toBe('skipped')
    expect(result.cloud_sse).toBe('skipped')
    expect(result.vm_ssh).toBe('ok')
  })

  it('probes only an explicit validated control plane and denies redirects', async () => {
    process.env.AWP_CONTROL_PLANE_URL = 'http://127.0.0.1:8100'
    const { runConnectivityCheck } = await import('../connectivity-check')
    const result = await runConnectivityCheck()
    expect(result.cloud_http).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8100/v1/health/ready')
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe('error')
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Authorization')
  })

  it('fails closed without fetch for an unsafe HTTP service', async () => {
    process.env.AWP_CONTROL_PLANE_URL = 'http://example.test'
    const { runConnectivityCheck } = await import('../connectivity-check')
    const result = await runConnectivityCheck()
    expect(result.cloud_http).toBe('fail')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails without opening SSH when an explicit key bundle is absent', async () => {
    keyBundleMock.mockReturnValue(null)
    const { runConnectivityCheck } = await import('../connectivity-check')
    const result = await runConnectivityCheck()
    expect(result.vm_ssh).toBe('fail')
    expect(result.details.vm_ssh).toMatch(/not explicitly provisioned/i)
  })

  it('skips SSH when no workspace is configured', async () => {
    sshConfigMock.mockReturnValue(null)
    const { runConnectivityCheck } = await import('../connectivity-check')
    const result = await runConnectivityCheck()
    expect(result.vm_ssh).toBe('skipped')
    expect(result.details.vm_ssh).toMatch(/not configured/i)
  })

  it('caches the exact most recent result object', async () => {
    const module = await import('../connectivity-check')
    expect(module.getLastConnectivityResult()).toBeNull()
    const result = await module.runConnectivityCheck()
    expect(module.getLastConnectivityResult()).toBe(result)
  })
})