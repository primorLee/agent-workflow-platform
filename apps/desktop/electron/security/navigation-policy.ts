export type NavigationDenyReason =
  | 'malformed_url'
  | 'dangerous_scheme'
  | 'invalid_artifact'
  | 'untrusted_file'

export type NavigationDecision =
  | { action: 'allow-current-document' }
  | { action: 'deny'; reason: NavigationDenyReason }
  | { action: 'open-external'; url: string }
  | { action: 'open-artifact'; artifactId: string }

export interface TopLevelNavigationInput {
  targetUrl: string
  currentDocumentUrl: string
  trustedDocumentUrl: string
}

export interface NavigationSideEffects {
  openExternal: (url: string) => void
  openArtifact: (artifactId: string) => void
}

export interface PreventableNavigationEvent {
  preventDefault: () => void
}

export type NavigationEventListener = (
  event: PreventableNavigationEvent,
  targetUrl: string,
) => void

export interface NavigationGuardWebContents {
  getURL: () => string
  on: (
    event: 'will-navigate' | 'will-redirect',
    listener: NavigationEventListener,
  ) => void
  setWindowOpenHandler: (
    handler: (details: { url: string }) => { action: 'deny' },
  ) => void
}

const MAX_URL_LENGTH = 8_192
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/
const INVALID_PERCENT_ESCAPE = /%(?![0-9a-fA-F]{2})/
const INVALID_ARTIFACT_CHAR = /[<>:"/\\|?*\u0000-\u001f\u007f]/

function getRawAuthority(raw: string): string | null {
  const scheme = raw.indexOf('://')
  if (scheme < 0) return null
  const authorityStart = scheme + 3
  const authorityEndCandidates = [raw.indexOf('/', authorityStart), raw.indexOf('?', authorityStart), raw.indexOf('#', authorityStart)]
    .filter((index) => index >= 0)
  const authorityEnd = authorityEndCandidates.length > 0
    ? Math.min(...authorityEndCandidates)
    : raw.length
  return raw.slice(authorityStart, authorityEnd)
}

function hasRawUserInfo(raw: string): boolean {
  return getRawAuthority(raw)?.includes('@') ?? false
}

function parseStrictAbsoluteUrl(raw: string): URL | null {
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    raw.length > MAX_URL_LENGTH ||
    raw !== raw.trim() ||
    CONTROL_CHAR.test(raw) ||
    raw.includes('\\') ||
    INVALID_PERCENT_ESCAPE.test(raw)
  ) {
    return null
  }

  try {
    const parsed = new URL(raw)
    if (parsed.username || parsed.password || hasRawUserInfo(raw)) return null
    return parsed
  } catch {
    return null
  }
}

function isSafeWebUrl(parsed: URL): boolean {
  return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length > 0
}

function isLoopbackDevelopmentUrl(raw: string, parsed: URL): boolean {
  if (!isSafeWebUrl(parsed)) return false
  const authority = getRawAuthority(raw)
  if (!authority || authority.includes('@')) return false

  if (/^localhost(?::\d{1,5})?$/i.test(authority)) {
    return parsed.hostname === 'localhost'
  }
  if (/^127\.0\.0\.1(?::\d{1,5})?$/.test(authority)) {
    return parsed.hostname === '127.0.0.1'
  }

  // Accept any ordinary textual representation that the WHATWG parser
  // canonicalizes to IPv6 ::1. Brackets are mandatory and zone identifiers,
  // percent encoding, IPv4-mapped addresses, and non-loopback IPv6 all fail.
  if (/^\[[0-9a-f:]+\](?::\d{1,5})?$/i.test(authority)) {
    return parsed.hostname === '[::1]'
  }
  return false
}

function withoutHash(parsed: URL): string {
  const copy = new URL(parsed.href)
  copy.hash = ''
  return copy.href
}

function isBootstrapDocument(raw: string, parsed: URL | null): boolean {
  return raw.length === 0 || parsed?.href === 'about:blank'
}

function parseArtifactId(raw: string, parsed: URL): string | null {
  if (
    parsed.protocol !== 'awp:' ||
    parsed.hostname !== 'artifact' ||
    parsed.port ||
    parsed.search ||
    parsed.hash ||
    !parsed.pathname.startsWith('/')
  ) {
    return null
  }

  const authorityStart = raw.indexOf('://') + 3
  const rawPathStart = raw.indexOf('/', authorityStart)
  const rawPathEndCandidates = [raw.indexOf('?', rawPathStart), raw.indexOf('#', rawPathStart)]
    .filter((index) => index >= 0)
  const rawPathEnd = rawPathEndCandidates.length > 0 ? Math.min(...rawPathEndCandidates) : raw.length
  const rawSegments = rawPathStart >= authorityStart
    ? raw.slice(rawPathStart + 1, rawPathEnd).split('/')
    : []
  if (rawSegments.length !== 1) return null

  let artifactId: string
  try {
    artifactId = decodeURIComponent(parsed.pathname.slice(1))
  } catch {
    return null
  }

  if (
    artifactId.length === 0 ||
    artifactId.length > 255 ||
    artifactId === '.' ||
    artifactId === '..' ||
    INVALID_ARTIFACT_CHAR.test(artifactId)
  ) {
    return null
  }
  return artifactId
}

function classifySpecialTarget(raw: string, parsed: URL): NavigationDecision | null {
  if (parsed.protocol === 'awp:') {
    const artifactId = parseArtifactId(raw, parsed)
    return artifactId
      ? { action: 'open-artifact', artifactId }
      : { action: 'deny', reason: 'invalid_artifact' }
  }
  if (isSafeWebUrl(parsed)) return null
  if (parsed.protocol === 'file:') return null
  return { action: 'deny', reason: 'dangerous_scheme' }
}

/**
 * Validate the single document that may carry the privileged preload.
 * Development accepts strict loopback HTTP(S); production accepts a file URL.
 */
export function normalizeTrustedDocumentUrl(
  raw: string,
  mode: 'development' | 'production',
): string | null {
  const parsed = parseStrictAbsoluteUrl(raw)
  if (!parsed) return null
  if (mode === 'development') return isLoopbackDevelopmentUrl(raw, parsed) ? parsed.href : null
  return parsed.protocol === 'file:' && (parsed.hostname === '' || parsed.hostname === 'localhost')
    ? parsed.href
    : null
}

/** Policy for Electron's top-level will-navigate / will-redirect events. */
export function decideTopLevelNavigation(input: TopLevelNavigationInput): NavigationDecision {
  const target = parseStrictAbsoluteUrl(input.targetUrl)
  if (!target) return { action: 'deny', reason: 'malformed_url' }

  const special = classifySpecialTarget(input.targetUrl, target)
  if (special) return special

  const trusted = parseStrictAbsoluteUrl(input.trustedDocumentUrl)
  const current = parseStrictAbsoluteUrl(input.currentDocumentUrl)
  if (!trusted) return { action: 'deny', reason: 'malformed_url' }

  if (isSafeWebUrl(target)) {
    const trustedIsWeb = isSafeWebUrl(trusted)
    const currentIsTrusted = isBootstrapDocument(input.currentDocumentUrl, current) || (
      current !== null &&
      isSafeWebUrl(current) &&
      current.origin === trusted.origin
    )
    if (trustedIsWeb && currentIsTrusted && target.origin === trusted.origin) {
      return { action: 'allow-current-document' }
    }
    return { action: 'open-external', url: target.href }
  }

  if (target.protocol === 'file:') {
    const currentIsTrusted = isBootstrapDocument(input.currentDocumentUrl, current) || (
      current !== null &&
      current.protocol === 'file:' &&
      withoutHash(current) === withoutHash(trusted)
    )
    if (
      trusted.protocol === 'file:' &&
      currentIsTrusted &&
      withoutHash(target) === withoutHash(trusted)
    ) {
      return { action: 'allow-current-document' }
    }
    return { action: 'deny', reason: 'untrusted_file' }
  }

  return { action: 'deny', reason: 'dangerous_scheme' }
}

/**
 * Policy for window.open. Electron must always return `deny`; this decision
 * only selects the optional side effect performed before denying the window.
 */
export function decideWindowOpen(targetUrl: string): NavigationDecision {
  const target = parseStrictAbsoluteUrl(targetUrl)
  if (!target) return { action: 'deny', reason: 'malformed_url' }

  const special = classifySpecialTarget(targetUrl, target)
  if (special) return special
  if (isSafeWebUrl(target)) return { action: 'open-external', url: target.href }
  if (target.protocol === 'file:') return { action: 'deny', reason: 'untrusted_file' }
  return { action: 'deny', reason: 'dangerous_scheme' }
}
function applyNavigationSideEffect(
  decision: NavigationDecision,
  effects: NavigationSideEffects,
): void {
  if (decision.action === 'open-external') {
    effects.openExternal(decision.url)
  } else if (decision.action === 'open-artifact') {
    effects.openArtifact(decision.artifactId)
  }
}

/** Enforce will-navigate / will-redirect with preventDefault before side effects. */
export function enforceTopLevelNavigation(
  input: TopLevelNavigationInput,
  event: PreventableNavigationEvent,
  effects: NavigationSideEffects,
): NavigationDecision {
  const decision = decideTopLevelNavigation(input)
  if (decision.action !== 'allow-current-document') {
    event.preventDefault()
    applyNavigationSideEffect(decision, effects)
  }
  return decision
}

/** Enforce window.open: perform only an approved side effect and always deny. */
export function enforceWindowOpenPolicy(
  targetUrl: string,
  effects: NavigationSideEffects,
): { action: 'deny' } {
  applyNavigationSideEffect(decideWindowOpen(targetUrl), effects)
  return { action: 'deny' }
}
/** Install all top-level Electron navigation guards through an injectable seam. */
export function installNavigationGuards(
  webContents: NavigationGuardWebContents,
  trustedDocumentUrl: string,
  effects: NavigationSideEffects,
): void {
  const handleNavigation: NavigationEventListener = (event, targetUrl) => {
    enforceTopLevelNavigation({
      targetUrl,
      currentDocumentUrl: webContents.getURL(),
      trustedDocumentUrl,
    }, event, effects)
  }
  webContents.on('will-navigate', handleNavigation)
  webContents.on('will-redirect', handleNavigation)
  webContents.setWindowOpenHandler(({ url }) =>
    enforceWindowOpenPolicy(url, effects),
  )
}
