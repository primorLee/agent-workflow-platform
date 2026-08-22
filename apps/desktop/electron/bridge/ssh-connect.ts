/**
 * Unified ssh2 connection helper.
 *
 * Every desktop-side ssh2 Client creation should go through this module so
 * that host-key verification is enforced uniformly — no more one-off
 * `new Client(); conn.connect({...})` sequences that skip the `hostVerifier`
 * entirely (the F3 finding of the 2026-04-19 industrial-grade audit).
 *
 * Two public entry points:
 *
 *   sshConnect(opts)
 *     Creates a new ssh2 Client, attaches the shared host-key verifier,
 *     connects, and resolves with the ready Client. Reject paths clean up
 *     the client, so callers never leak half-open sockets on failure.
 *
 *   attachHostVerifier(connectOpts, host, port)
 *     Mutation helper for legacy callsites that still prefer to manage the
 *     Client / event wiring themselves. Attaches (and overwrites) the
 *     `hostVerifier` field on a ConnectConfig-shaped options bag.
 *
 * Both share the same known_hosts store via `ssh-known-hosts.ts`.
 */

import { Client as SSHClient } from 'ssh2'
import type { ConnectConfig } from 'ssh2'
import { log } from '../utils/logger'
import { makeHostVerifier } from './ssh-known-hosts'

export interface SshConnectOptions {
  host: string
  port?: number
  username: string
  password?: string
  privateKey?: Buffer | string
  /** Milliseconds — default 15000. */
  readyTimeout?: number
  /** Seconds — passed to ssh2. Default 30. */
  keepaliveInterval?: number
  /** Default 3. */
  keepaliveCountMax?: number
  /** When false, disables keyboard-interactive auth (default false). */
  tryKeyboard?: boolean
  /** Optional label for log lines. Defaults to `host:port`. */
  label?: string
}

export class SshConnectError extends Error {
  readonly host: string
  readonly port: number
  constructor(host: string, port: number, cause: string) {
    super(`SSH connect to ${host}:${port} failed: ${cause}`)
    this.name = 'SshConnectError'
    this.host = host
    this.port = port
  }
}

/**
 * Attach the shared TOFU host-key verifier to an existing ConnectConfig bag.
 * Callers responsible for the Client lifecycle.
 */
export function attachHostVerifier(
  connectOpts: ConnectConfig,
  host: string,
  port?: number,
): void {
  connectOpts.hostVerifier = makeHostVerifier(host, port ?? (connectOpts.port ?? 22))
}

/**
 * Preferred new API — create, configure, and connect an ssh2 Client.
 * Resolves with a ready Client; rejects with SshConnectError on timeout or
 * transport error. The Client is closed on reject, so callers don't need to.
 */
export async function sshConnect(opts: SshConnectOptions): Promise<SSHClient> {
  const host = opts.host
  const port = opts.port ?? 22
  const username = opts.username
  const readyTimeoutMs = opts.readyTimeout ?? 120_000
  const label = opts.label ?? `${host}:${port}`

  const connectOpts: ConnectConfig = {
    host,
    port,
    username,
    readyTimeout: readyTimeoutMs,
    keepaliveInterval: (opts.keepaliveInterval ?? 30) * 1000,
    keepaliveCountMax: opts.keepaliveCountMax ?? 3,
    agent: undefined,
    tryKeyboard: opts.tryKeyboard ?? false,
    hostVerifier: makeHostVerifier(host, port),
  }

  if (opts.privateKey) {
    connectOpts.privateKey = opts.privateKey
  } else if (opts.password) {
    connectOpts.password = opts.password
  }

  const client = new SSHClient()

  return new Promise<SSHClient>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { client.end() } catch { /* best-effort close */ }
      log(`[ssh-connect] timeout after ${readyTimeoutMs}ms to ${label}`)
      reject(new SshConnectError(host, port, `timeout after ${readyTimeoutMs}ms`))
    }, readyTimeoutMs + 1000)

    client.once('ready', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      log(`[ssh-connect] ready ${label} as ${username}`)
      resolve(client)
    })

    client.once('error', (err: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { client.end() } catch { /* best-effort close */ }
      log(`[ssh-connect] error ${label}: ${err.message}`)
      reject(new SshConnectError(host, port, err.message))
    })

    try {
      client.connect(connectOpts)
    } catch (err) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const msg = err instanceof Error ? err.message : String(err)
      log(`[ssh-connect] synchronous connect threw ${label}: ${msg}`)
      reject(new SshConnectError(host, port, msg))
    }
  })
}
