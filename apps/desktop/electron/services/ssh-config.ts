/**
 * ssh-config — shared ssh2 ConnectConfig builder for Desktop runners.
 *
 * Extracted 2026-04-23 (T-024, F6) so vm-exec-runner.ts and other remote workload runners
 * don't each hand-roll the CentOS 7 GSSAPI mitigations. Any new runner that
 * opens an ssh2 session to the remote workspace MUST import these helpers instead
 * of reintroducing raw `{ readyTimeout, keepaliveInterval, tryKeyboard }`.
 *
 * Why these exact values
 * ----------------------
 *  - readyTimeout: 120_000
 *      Empirically needed on CentOS 7 hosts where GSSAPI + keyboard-interactive
 *      chaining adds ~88s on top of publickey auth before ssh2 surfaces a
 *      failure. 30s (ssh2 default) rejects on well-configured hosts that are
 *      merely slow to answer banner. Memory note
 *      `feedback_ssh_timeout_120s_required.md` and lock-in test
 *      electron/vm-setup/__tests__/v1.5.12-ssh-fixes.spec.ts enforce >=120s at
 *      every ssh2 connect point in the repo.
 *
 *  - keepaliveInterval: 30_000
 *      Long-running workloads can hold the session open for 25-35 min.
 *      Intermediate NAT/router tables drop idle TCP flows around 60-120s;
 *      30s keepalive stays well inside every common NAT timer.
 *
 *  - tryKeyboard: false
 *      ssh2 defaults this to true, which on CentOS 7 GSSAPI triggers an 88s
 *      keyboard-interactive fallback after publickey auth "fails" (even when
 *      the key was accepted for a different method). Pinning false keeps
 *      readyTimeout actually bounding the wall clock. See the v1.6.3 comment
 *      in every remote runner; all callers now
 *      now delegate to this helper. The lock-in test
 *      Shared SSH configuration tests
 *      guard against reversion.
 *
 *  - wallClockMs: 130_000
 *      Outer safety net wrapping the ssh2 connect Promise. Must be >=
 *      readyTimeout; 10s buffer lets ssh2 emit its own timeout `error` event
 *      (cleaner diagnostics) before our watchdog trips. Matches the comment
 *      in electron/ipc/handlers.ts:267.
 *
 * Callers hand the result to `ssh2.Client#connect(cfg)`; injecting a
 * `privateKey` / `password` / `username` etc. is the caller's responsibility.
 */

import type { ConnectConfig } from 'ssh2'

/** ssh2 readyTimeout (ms) — CentOS 7 GSSAPI accounting. */
export const SSH_READY_TIMEOUT_MS = 120_000

/** ssh2 keepaliveInterval (ms) — under every common NAT idle timer. */
export const SSH_KEEPALIVE_MS = 30_000

/**
 * Outer wall-clock cap for the Promise that wraps ssh2 connect(). Must be
 * >= SSH_READY_TIMEOUT_MS so the ssh2 error event fires first (better diag).
 */
export const SSH_CONNECT_WALL_MS = 130_000

/**
 * Build the baseline timing/options block every Desktop ssh2 connect should
 * start from. Returns a fresh object each call so callers can freely spread
 * in their own host/port/username/privateKey without affecting anyone else.
 *
 * Intentionally leaves host/port/username/auth to the caller — those are
 * per-session, not a shared concern.
 */
export function buildSshConnectDefaults(): Pick<
  ConnectConfig,
  'readyTimeout' | 'keepaliveInterval' | 'keepaliveCountMax' | 'tryKeyboard'
> {
  return {
    readyTimeout: SSH_READY_TIMEOUT_MS,
    keepaliveInterval: SSH_KEEPALIVE_MS,
    // T-023 F6 memory compliance (`feedback_ssh_timeout_120s_required.md`):
    // every ssh2 connect in the repo must carry keepaliveCountMax:3. Missing
    // this lets an idle long-sim session die silently when 3+ consecutive
    // keepalives miss on a flaky NAT/VPN hop.
    keepaliveCountMax: 3,
    // tryKeyboard:false — ssh2 default `true` re-opens the 88s GSSAPI hang on
    // CentOS 7 after publickey is accepted-then-rejected by PAM chaining.
    tryKeyboard: false,
  }
}
