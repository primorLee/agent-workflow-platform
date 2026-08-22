/**
 * Hosted account flows are retained as an optional adapter, but public builds
 * fail closed. Electron preload exposes `true` only when the main process saw
 * the exact opt-in value `AWP_HOSTED_AUTH_OPT_IN=1`.
 */
export function isHostedAuthEnabled(): boolean {
  return typeof window !== 'undefined' && window.__AWP_HOSTED_AUTH_ENABLED === true
}
