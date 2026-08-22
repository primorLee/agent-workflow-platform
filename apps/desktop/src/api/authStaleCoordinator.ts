/**
 * authStaleCoordinator — single-fire guard shared between the two
 * "token is stale / server said 401" code paths:
 *
 *   1. vm-exec SSE runner detects a stale-token burst and emits the
 *      `auth:token-stale` IPC event. `App.vue::onAuthTokenStale` handles it.
 *   2. A plain REST call (`GET /v1/tasks`, etc.) returns 401 and
 *      the generic 401 branch in `client.ts::handleErrorStatus` fires.
 *
 * Both paths want the same UX: clear credentials, toast "登录已失效", push to
 * /login — but only ONCE per stale-token episode. Without a shared guard,
 * every failing request in the same tick re-toasts and re-pushes. Prior to
 * v1.6.x the SSE path had its own `_authStaleHandling` flag in App.vue and
 * the REST path had nothing, so simultaneous 401s across SSE + REST produced
 * duplicate toasts and sometimes a router.push loop.
 *
 * Module-level state is fine here: the renderer process has exactly one
 * instance, and we WANT this to persist across the lifetime of the renderer
 * (reloading the app naturally resets it).
 *
 * Contract:
 *   - `tryClaimAuthStale()` returns `true` the first time it's called within
 *     the debounce window, `false` otherwise. The caller that got `true` is
 *     responsible for running the full logout/toast/redirect flow.
 *   - `resetAuthStale()` is exposed for tests and for the rare case where we
 *     want to force-re-enable handling (e.g. after a successful login).
 *   - Debounce defaults to 15 s, matching the vm-exec stale-streak reset
 *     cadence (runner resets its counter every ~50 s so a real second
 *     episode is well outside the window).
 */

let _claimed = false
let _resetTimer: ReturnType<typeof setTimeout> | null = null

/** Debounce window in ms — kept in sync with App.vue's legacy 15 s. */
export const AUTH_STALE_DEBOUNCE_MS = 15_000

/**
 * Attempt to claim the "I will handle this stale-token episode" lock.
 *
 * @returns `true` if the caller won the race and should run the handling
 *          flow. `false` if another path already claimed within the window.
 */
export function tryClaimAuthStale(debounceMs: number = AUTH_STALE_DEBOUNCE_MS): boolean {
  if (_claimed) return false
  _claimed = true
  if (_resetTimer) clearTimeout(_resetTimer)
  _resetTimer = setTimeout(() => {
    _claimed = false
    _resetTimer = null
  }, debounceMs)
  return true
}

/**
 * Force-release the claim. Exposed for:
 *   - unit tests (reset between cases)
 *   - a successful re-login flow, which implies the previous stale episode
 *     is resolved and a fresh 401 should be treated as a new episode.
 */
export function resetAuthStale(): void {
  _claimed = false
  if (_resetTimer) {
    clearTimeout(_resetTimer)
    _resetTimer = null
  }
}

/** Read-only accessor, mainly for diagnostics / tests. */
export function isAuthStaleClaimed(): boolean {
  return _claimed
}
