/**
 * Regression — ssh-config defaults must NOT silently regress.
 *
 * Background: every remote SSH session (vm-exec-runner.ts +
 * remote execution and onboarding SSH checks) goes
 * through buildSshConnectDefaults(). Three constants here are load-bearing:
 *
 *   readyTimeout: 120_000  — CentOS 7 GSSAPI accounting; <30s rejects slow
 *                            but well-configured hosts.
 *   keepaliveInterval: 30_000  — under every common NAT idle timer.
 *   keepaliveCountMax: 3      — without it, a long-running remote workflow dies
 *                               silently when 3+ keepalives miss.
 *   tryKeyboard: false        — true re-opens the 88s GSSAPI hang after
 *                               publickey acceptance.
 *
 * These were tuned against real deployments over multiple regressions
 * (v1.5.12 hotfix, v1.6.3 T-024 F6). A "just bump the timeout down for
 * faster tests" PR would silently break production SSH on slow hosts;
 * this spec catches it at CI time.
 */

import { describe, it, expect } from 'vitest'

import {
  SSH_READY_TIMEOUT_MS,
  SSH_KEEPALIVE_MS,
  SSH_CONNECT_WALL_MS,
  buildSshConnectDefaults,
} from '../ssh-config'

describe('ssh-config — connect defaults are load-bearing constants', () => {
  it('readyTimeout >= 120s (CentOS 7 GSSAPI accounting)', () => {
    expect(SSH_READY_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000)
    expect(buildSshConnectDefaults().readyTimeout).toBe(SSH_READY_TIMEOUT_MS)
  })

  it('keepalive interval <= 30s (under common NAT idle timers)', () => {
    expect(SSH_KEEPALIVE_MS).toBeLessThanOrEqual(30_000)
    expect(SSH_KEEPALIVE_MS).toBeGreaterThan(0)
    expect(buildSshConnectDefaults().keepaliveInterval).toBe(SSH_KEEPALIVE_MS)
  })

  it('keepaliveCountMax === 3 (no silent idle-session death)', () => {
    // Hard-coded by memory note feedback_ssh_timeout_120s_required.md. If
    // someone changes this, they need to update that memory + at least one
    // real test against a flaky NAT — otherwise long sims regress silently.
    expect(buildSshConnectDefaults().keepaliveCountMax).toBe(3)
  })

  it('tryKeyboard === false (avoid 88s GSSAPI hang on CentOS 7)', () => {
    // ssh2 defaults this to TRUE. We must override to FALSE.
    expect(buildSshConnectDefaults().tryKeyboard).toBe(false)
  })

  it('wall-clock cap >= readyTimeout (so ssh2 emits error first)', () => {
    // The outer Promise watchdog must give ssh2's own readyTimeout time to
    // fire its error event for cleaner diagnostics. Anything below this
    // means our watchdog beats ssh2's diagnostics every time.
    expect(SSH_CONNECT_WALL_MS).toBeGreaterThanOrEqual(SSH_READY_TIMEOUT_MS)
  })

  it('returns a FRESH object each call (callers spread their own auth)', () => {
    const a = buildSshConnectDefaults()
    const b = buildSshConnectDefaults()
    expect(a).not.toBe(b)
    a.readyTimeout = 1 as unknown as number
    expect(b.readyTimeout).toBe(SSH_READY_TIMEOUT_MS)
  })

  it('returned object contains ONLY the timing/auth-mode keys', () => {
    // Caller is responsible for host/port/username/privateKey/password.
    // If we accidentally start setting any of those here, the helper
    // turns into a footgun (silently overrides tenant-scoped config).
    const keys = Object.keys(buildSshConnectDefaults()).sort()
    expect(keys).toEqual(
      ['keepaliveCountMax', 'keepaliveInterval', 'readyTimeout', 'tryKeyboard'].sort(),
    )
  })
})
