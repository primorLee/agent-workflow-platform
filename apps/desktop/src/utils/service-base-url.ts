const MAX_SERVICE_BASE_URL_LENGTH = 2_048

/** Strict origin-only service URL policy shared by renderer network clients. */
export function normalizeServiceBaseUrl(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_SERVICE_BASE_URL_LENGTH) {
    return null
  }
  if (raw !== raw.trim() || /[\s\u0000-\u001f\u007f\\%]/u.test(raw)) return null

  const authorityMatch = /^(https?):\/\/([^/]+)\/?$/iu.exec(raw)
  if (!authorityMatch) return null

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null
  if (parsed.pathname !== '/') return null
  if (parsed.port && (!/^\d{1,5}$/u.test(parsed.port) || Number(parsed.port) < 1)) return null

  if (parsed.protocol === 'http:') {
    const authority = authorityMatch[2]
    if (!authority) return null
    const explicitLoopback = /^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/iu.test(authority)
      || /^\[::1\](?::\d{1,5})?$/u.test(authority)
    if (!explicitLoopback) return null
  }

  return parsed.origin
}

export function requireServiceBaseUrl(raw: string | undefined | null, label = 'service URL'): string {
  const normalized = normalizeServiceBaseUrl(raw)
  if (!normalized) throw new Error(`invalid_${label.replace(/[^a-z0-9]+/giu, '_').toLowerCase()}`)
  return normalized
}
/** Validate an absolute service endpoint while applying the same origin policy. */
export function normalizeServiceEndpointUrl(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_SERVICE_BASE_URL_LENGTH) {
    return null
  }
  if (raw !== raw.trim() || /[\s\u0000-\u001f\u007f\\%]/u.test(raw)) return null

  const authorityMatch = /^(https?):\/\/([^/]+)(\/.*)?$/iu.exec(raw)
  if (!authorityMatch) return null
  const scheme = authorityMatch[1]
  const authority = authorityMatch[2]
  if (!scheme || !authority) return null
  const origin = normalizeServiceBaseUrl(`${scheme}://${authority}`)
  if (!origin) return null

  try {
    const parsed = new URL(raw)
    if (parsed.origin !== origin || parsed.username || parsed.password || parsed.hash) return null
    if (!parsed.pathname.startsWith('/') || parsed.pathname.startsWith('//')) return null
    return parsed.toString()
  } catch {
    return null
  }
}
