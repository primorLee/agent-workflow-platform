/**
 * Credential-key allow-list for the `secure:*-credential` IPC surface.
 *
 * Background — S1 (desktop 2026-04-19 industrial-grade audit):
 *   The original `secure:set-credential` / `secure:get-credential` /
 *   `secure:delete-credential` handlers accepted an arbitrary `key: string`
 *   from the renderer. A single renderer-side XSS (or malicious extension
 *   / devtools injection) could therefore silently overwrite `auth_token`
 *   with attacker-controlled material — full account takeover, no prompt.
 *
 *   Fix: central allow-list. The handlers consult `isCredentialKey()` and
 *   reject anything else. The set of keys is closed; every legitimate
 *   callsite is enumerated below, and the TypeScript alias `CredentialKey`
 *   is threaded through `bridge.ts` / `types/bridge.ts` so a renderer
 *   caller that types the wrong key fails at compile time — not at
 *   runtime behind a user-triggered XSS.
 *
 * How to add a key (operator-only, do not do this casually):
 *   1. Verify the new key actually needs safeStorage (not every secret
 *      belongs here — short-lived tokens often want in-memory only).
 *   2. Append to `CREDENTIAL_KEYS` below.
 *   3. Add a unit-test case in `__tests__/credential-allowlist.spec.ts`
 *      asserting the key passes through.
 *   4. Update any renderer caller with the correct typed key.
 *
 * Threat model assumed:
 *   - Renderer is compromised (XSS / malicious preload / devtools inject).
 *   - Main process is trusted (Electron process boundary).
 *   - Attacker cannot forge the channel name (contextIsolation on).
 *   The allow-list therefore lives *in main* and is enforced on every
 *   invoke — never in renderer, and never shared across channels.
 */

/**
 * Every credential key the rest of the codebase is allowed to store in
 * safeStorage. Enumerated from a full grep of the desktop tree
 * (`setCredential(` / `getCredential(` / `deleteCredential(` callsites).
 *
 * Do NOT extend this list without doing the checklist above.
 */
export const CREDENTIAL_KEYS = [
  /** Bearer token for the cloud API. Written on login, read on every
   *  authenticated request via `getAuthHeaders()`. Owner: `auth.ts`. */
  'auth_token',
  /** Legacy key used before v1.4.x. Still read/deleted on logout for
   *  backwards compatibility with clients that upgraded from <=1.3.
   *  Owner: `auth.ts:clearAuth`. Never written by new code. */
  'token',
  /** SSH password for the VM bridge, persisted opt-in by the
   *  user via Settings → VM. Written and deleted from the
   *  settings store. Owner: `stores/settings.ts`. */
  'sshPassword',
] as const

export type CredentialKey = typeof CREDENTIAL_KEYS[number]

/**
 * Type guard — true iff `k` is one of the allow-listed credential keys.
 * Rejects:
 *   - Any string outside the literal union (including "Auth_Token" — the
 *     allow-list is case-sensitive, matching the persisted blob keys).
 *   - Path-traversal / injection payloads (`../foo`, `auth_token\0evil`)
 *     fall through because they are not identical to any member.
 *   - Non-string inputs (number, object, undefined) — the narrower
 *     `typeof k === 'string'` short-circuit keeps the set membership
 *     check honest even if a caller bypasses TypeScript.
 */
export function isCredentialKey(k: unknown): k is CredentialKey {
  if (typeof k !== 'string') return false
  // Cast is safe: we test membership before narrowing.
  return (CREDENTIAL_KEYS as readonly string[]).includes(k)
}
