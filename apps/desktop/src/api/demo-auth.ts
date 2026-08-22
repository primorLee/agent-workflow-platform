export const DEMO_TOKEN_HEADER = 'X-AWP-Demo-Token'
const DEMO_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u

const STATIC_DEMO_PATHS = new Set([
  '/api/health',
  '/v1/health/ready',
  '/v1/maintenance',
  '/v1/changelog',
  '/api/chat/models',
  '/v1/chat/history',
  '/v1/chat/completions',
  '/v1/chat/upload',
  '/v1/chat/artifacts',
  '/v1/activity/events',
  '/v1/activity/stream',
  '/v1/auth/validate',
  '/v1/auth/login',
  '/v1/auth/register',
  '/v1/auth/logout',
])

function isDemoApiPath(pathname: string): boolean {
  if (STATIC_DEMO_PATHS.has(pathname)) return true
  return /^\/v1\/chat\/history\/[^/]+(?:\/messages)?$/u.test(pathname)
    || /^\/v1\/chat\/artifacts\/[^/]+\/download$/u.test(pathname)
}

export function isSemanticLoopbackHttpUrl(value: string): boolean {
  if (
    !value
    || value !== value.trim()
    || value.includes('\\')
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return false
  }
  try {
    const parsed = new URL(value)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return false
    const hostname = parsed.hostname.toLowerCase()
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  } catch {
    return false
  }
}

export function readDemoToken(): string {
  const bridgeToken = typeof window !== 'undefined' ? window.__AWP_DEMO_TOKEN : undefined
  if (typeof bridgeToken === 'string' && DEMO_TOKEN_PATTERN.test(bridgeToken)) return bridgeToken
  const viteToken = import.meta.env.VITE_AWP_DEMO_TOKEN
  return typeof viteToken === 'string' && DEMO_TOKEN_PATTERN.test(viteToken) ? viteToken : ''
}

export function readDemoOrigin(): string {
  const bridgeOrigin = typeof window !== 'undefined' ? window.__AWP_DEMO_ORIGIN : undefined
  if (typeof bridgeOrigin === 'string' && isSemanticLoopbackHttpUrl(bridgeOrigin)) {
    return new URL(bridgeOrigin).origin
  }
  const viteOrigin = import.meta.env.VITE_AWP_DEMO_ORIGIN
  if (typeof viteOrigin === 'string' && isSemanticLoopbackHttpUrl(viteOrigin)) {
    return new URL(viteOrigin).origin
  }
  return ''
}

export function withDemoAuthHeaders(
  targetUrl: string,
  input: Record<string, string> = {},
  token = readDemoToken(),
  demoOrigin = readDemoOrigin(),
): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    if (key.toLowerCase() !== DEMO_TOKEN_HEADER.toLowerCase()) headers[key] = value
  }
  if (!DEMO_TOKEN_PATTERN.test(token) || !isSemanticLoopbackHttpUrl(demoOrigin) || !isSemanticLoopbackHttpUrl(targetUrl)) return headers
  try {
    const target = new URL(targetUrl)
    const expectedOrigin = new URL(demoOrigin).origin
    if (target.origin === expectedOrigin && isDemoApiPath(target.pathname)) {
      headers[DEMO_TOKEN_HEADER] = token
    }
  } catch {
    // Fail closed for malformed targets.
  }
  return headers
}
