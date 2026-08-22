/**
 * One-shot connectivity preflight.
 *
 * The default public desktop performs only the configured SSH probe. A control
 * plane readiness request is added only when AWP_CONTROL_PLANE_URL is explicit
 * and passes the strict service-origin policy. No hosted-auth or legacy SSE
 * request is issued by this module.
 */
import { Client as SSHClient } from 'ssh2'
import { getAwpDir, getSshConfig } from '../utils/config'
import { readProvisionedSshPrivateKey } from '../utils/ssh-private-key'
import { normalizeServiceBaseUrl } from '../utils/service-base-url'
import { log as logToFile } from '../utils/logger'

const log = (message: string) => logToFile(`[connectivity-check] ${message}`)

export type ProbeStatus = 'ok' | 'fail' | 'skipped'
export interface ConnectivityCheckResult {
  /** Legacy wire name for the explicitly configured control-plane readiness probe. */
  cloud_http: ProbeStatus
  /** Retained wire field; the retired implicit activity stream is never probed. */
  cloud_sse: ProbeStatus
  vm_ssh: ProbeStatus
  details: Record<string, string>
  checked_at_ms: number
}

let _lastResult: ConnectivityCheckResult | null = null
const HTTP_TIMEOUT_MS = 5_000
const SSH_TIMEOUT_MS = 15_000

export function getLastConnectivityResult(): ConnectivityCheckResult | null {
  return _lastResult
}

async function probeConfiguredControlPlane(
  details: Record<string, string>,
): Promise<ProbeStatus> {
  const rawBase = process.env.AWP_CONTROL_PLANE_URL
  if (!rawBase) {
    details.cloud_http = 'control plane not configured'
    return 'skipped'
  }
  const base = normalizeServiceBaseUrl(rawBase)
  if (!base) {
    details.cloud_http = 'invalid control plane URL'
    return 'fail'
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
  try {
    const response = await fetch(`${base}/v1/health/ready`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      redirect: 'error',
    })
    details.cloud_http = response.ok ? 'readiness returned success' : `readiness HTTP ${response.status}`
    return response.ok ? 'ok' : 'fail'
  } catch (error) {
    details.cloud_http = (error as { name?: string })?.name === 'AbortError'
      ? `readiness timeout after ${HTTP_TIMEOUT_MS}ms`
      : 'readiness request failed'
    return 'fail'
  } finally {
    clearTimeout(timer)
  }
}

async function probeVmSsh(details: Record<string, string>): Promise<ProbeStatus> {
  let sshConfig: ReturnType<typeof getSshConfig>
  try {
    sshConfig = getSshConfig()
  } catch {
    details.vm_ssh = 'SSH configuration unavailable'
    return 'skipped'
  }
  if (!sshConfig?.host || !sshConfig.user) {
    details.vm_ssh = 'SSH workspace not configured'
    return 'skipped'
  }

  const host = sshConfig.host
  const port = sshConfig.port ?? 22
  const username = sshConfig.user
  let privateKey: Buffer
  try {
    const provisioned = readProvisionedSshPrivateKey(getAwpDir())
    if (!provisioned) {
      details.vm_ssh = 'SSH key not explicitly provisioned'
      return 'fail'
    }
    privateKey = provisioned.privateKey
  } catch {
    details.vm_ssh = 'SSH key bundle failed validation'
    return 'fail'
  }

  return await new Promise<ProbeStatus>((resolve) => {
    const client = new SSHClient()
    let settled = false
    const finish = (status: ProbeStatus, detail: string) => {
      if (settled) return
      settled = true
      details.vm_ssh = detail
      try { client.end() } catch { /* best effort */ }
      resolve(status)
    }
    const timer = setTimeout(() => {
      finish('fail', `SSH timeout after ${SSH_TIMEOUT_MS}ms`)
    }, SSH_TIMEOUT_MS)

    client.on('ready', () => {
      clearTimeout(timer)
      finish('ok', 'SSH workspace reachable')
    })
    client.on('error', () => {
      clearTimeout(timer)
      finish('fail', 'SSH connection failed')
    })
    try {
      client.connect({
        host,
        port,
        username,
        privateKey,
        readyTimeout: SSH_TIMEOUT_MS,
        tryKeyboard: false,
      })
    } catch {
      clearTimeout(timer)
      finish('fail', 'SSH connection could not start')
    }
  })
}

export async function runConnectivityCheck(): Promise<ConnectivityCheckResult> {
  const details: Record<string, string> = {
    cloud_sse: 'compatibility stream probe disabled',
  }
  const [cloudHttp, vmSsh] = await Promise.all([
    probeConfiguredControlPlane(details).catch((): ProbeStatus => {
      details.cloud_http = 'control plane probe failed'
      return 'fail'
    }),
    probeVmSsh(details).catch((): ProbeStatus => {
      details.vm_ssh = 'SSH probe failed'
      return 'fail'
    }),
  ])

  const result: ConnectivityCheckResult = {
    cloud_http: cloudHttp,
    cloud_sse: 'skipped',
    vm_ssh: vmSsh,
    details,
    checked_at_ms: Date.now(),
  }
  _lastResult = result
  log(`control_plane=${cloudHttp} compat_stream=skipped vm_ssh=${vmSsh}`)
  return result
}