/**
 * Error sanitization for renderer display.
 *
 * Backend error payloads (HTTP 5xx bodies, IPC bridge errors, SSH2 rejections,
 * Python tracebacks propagated via JSON) may leak internals that we do NOT
 * want in the UI:
 *
 *   - Absolute filesystem paths (`/opt/tool/...`, `C:\Users\Example\workspace`).
 *   - Auth tokens (JWT bearer strings, long hex secrets).
 *   - Multi-line stack traces.
 *
 * Use `sanitizeError(err)` at the renderer edge — toast stores, chat error
 * bubbles, form-submission catch handlers — before passing the result to
 * Vue for rendering. It returns a safe `{ title, message, code? }` object.
 *
 * Referenced by the VM-setup security audit
 * (`docs/L3-tasks/security-reviews/vm-setup-audit-2026-04-17.md`), ticket
 * `TASK-DESKTOP-ERROR-SANITIZE`.
 */

import i18n from '@/i18n'

interface I18nGlobal {
  t: (key: string, params?: Record<string, unknown>) => string
}
function t(key: string): string {
  try {
    return (i18n.global as unknown as I18nGlobal).t(key)
  } catch {
    // i18n may not be initialised yet (early module load); fall back to key.
    return key
  }
}

export interface SanitizedError {
  /** Short user-facing title (default: localized "operation failed"). */
  title: string
  /** Sanitized single-line message, safe to show in a toast or bubble. */
  message: string
  /** Optional error code (e.g. HTTP status, ApiError.code). */
  code?: string
}

// --- Regexes -------------------------------------------------------------

/** POSIX absolute paths: /foo, /opt/..., /home/user/..., /tmp/... */
const POSIX_PATH_RE = /\/(?:[\w.\-@+]+\/)+[\w.\-@+]*/g

/** Windows absolute paths: C:\Users\Example\..., D:/..., \\server\share\... */
const WIN_PATH_RE = /(?:[A-Za-z]:[\\/])(?:[\w .\-@+]+[\\/])+[\w .\-@+]*|\\\\[\w.\-]+\\[\w.\-]+(?:\\[\w .\-@+]*)*/g

/** JWT-shaped tokens: three base64url segments separated by dots. */
const JWT_RE = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g

/** Long hex strings (>= 24 chars) — API keys, session tokens, sha256 digests. */
const HEX_TOKEN_RE = /\b[0-9a-fA-F]{24,}\b/g

/** "Bearer xxx" tokens. */
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._\-+/=]+/gi

/**
 * "api_key=...", "token=...", "password=...". Query-string or dict style.
 * Deliberately excludes "authorization" — handled by BEARER_RE which
 * preserves the "Bearer" keyword for operator debugging.
 */
const KV_SECRET_RE = /\b(?:api[_-]?key|token|password|secret|passwd|pwd)\s*[:=]\s*["']?[^"'\s,;}]+["']?/gi

// --- Core cleaners -------------------------------------------------------

/**
 * Strip absolute filesystem paths (POSIX + Windows + UNC), replacing each
 * with the literal string `<path>`. The basename is preserved as a hint when
 * the path ends in a filename with an extension (helps debugging without
 * leaking the parent directory).
 */
export function stripPaths(input: string): string {
  const replacePath = (match: string): string => {
    // Preserve basename if the path ends in "<name>.<ext>" (helps debugging
    // without exposing the parent directory).
    const segments = match.split(/[\\/]/)
    const last = segments[segments.length - 1] ?? ''
    if (last && /^[\w.\-@+]+\.[A-Za-z0-9]{1,6}$/.test(last)) {
      return `<path>/${last}`
    }
    return '<path>'
  }
  return input
    .replace(WIN_PATH_RE, replacePath)
    .replace(POSIX_PATH_RE, replacePath)
}

/**
 * Redact anything resembling an authentication secret: JWTs, bearer tokens,
 * long hex blobs, key=value pairs whose key name implies secrecy.
 */
export function redactSecrets(input: string): string {
  return input
    .replace(BEARER_RE, 'Bearer <redacted>')
    .replace(JWT_RE, '<jwt>')
    .replace(KV_SECRET_RE, (m) => {
      const key = m.split(/[:=]/)[0]
      return `${key}=<redacted>`
    })
    .replace(HEX_TOKEN_RE, '<token>')
}

/**
 * Collapse a multi-line stack trace into a single user-friendly line. The
 * first non-empty line is kept (it is almost always the exception type and
 * top-level message); subsequent "    at ..." / "  File ..." / "Traceback"
 * lines are discarded.
 */
export function collapseStack(input: string): string {
  const raw = input.split(/\r?\n/)
  // Normalize by trimming each line and dropping empties.
  const lines: string[] = raw.map((l) => l.trim()).filter((l): l is string => l.length > 0)
  if (lines.length === 0) return ''

  const first = lines[0] as string
  // Python traceback: the *last* non-frame line is the real exception message
  // (format: "ExceptionType: message").
  if (/^Traceback\b/i.test(first)) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i] as string
      if (/^File\s+["']/.test(ln)) continue
      if (/^Traceback\b/i.test(ln)) continue
      // Skip code fragments inside a frame (no ": " separator and not an
      // ExceptionType line). Heuristic: keep lines matching `Word: message`.
      if (/^[A-Za-z_][\w.]*(?:Error|Exception|Warning|Abort)\b/.test(ln)) {
        return clamp(ln)
      }
      if (/^[A-Za-z_][\w.]*\s*:\s*.+/.test(ln)) {
        return clamp(ln)
      }
    }
    // Fallback: last line
    return clamp(lines[lines.length - 1] as string)
  }

  // JS / generic: first non-frame line wins.
  for (const ln of lines) {
    if (/^at\s+/.test(ln)) continue
    if (/^File\s+["']/.test(ln)) continue
    return clamp(ln)
  }
  return clamp(first)
}

function clamp(s: string, max = 280): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

// --- Public API ----------------------------------------------------------

function extractRaw(err: unknown): { message: string; code?: string; title?: string } {
  if (err == null) return { message: t('api.unknownError') }
  if (typeof err === 'string') return { message: err }
  if (typeof err === 'number' || typeof err === 'boolean') return { message: String(err) }

  const anyErr = err as Record<string, unknown>

  // ApiError (see src/api/client.ts) exposes { status, code, detail, message }.
  const status = typeof anyErr.status === 'number' ? String(anyErr.status) : undefined
  const code =
    (typeof anyErr.code === 'string' && anyErr.code) ||
    (typeof anyErr.error_type === 'string' && (anyErr.error_type as string)) ||
    status

  const message =
    (typeof anyErr.detail === 'string' && (anyErr.detail as string)) ||
    (typeof anyErr.message === 'string' && (anyErr.message as string)) ||
    (typeof anyErr.error === 'string' && (anyErr.error as string)) ||
    (() => {
      try {
        return JSON.stringify(err)
      } catch {
        return String(err)
      }
    })()

  const title = typeof anyErr.title === 'string' ? (anyErr.title as string) : undefined
  return { message, code, title }
}

/**
 * Sanitize an error value of unknown shape into a safe `{ title, message, code? }`
 * object suitable for rendering in a toast/notification/bubble.
 *
 * Pipeline: extract raw → collapse stack → strip paths → redact secrets → clamp.
 */
export function sanitizeError(err: unknown, fallbackTitle?: string): SanitizedError {
  const fallback = fallbackTitle ?? t('api.operationFailed')
  const raw = extractRaw(err)
  let message = raw.message ?? ''
  message = collapseStack(message)
  message = stripPaths(message)
  message = redactSecrets(message)
  message = message.trim()
  if (!message) message = fallback
  if (message.length > 280) message = message.slice(0, 277) + '…'

  const out: SanitizedError = {
    title: raw.title ?? fallback,
    message,
  }
  if (raw.code) out.code = raw.code
  return out
}

/**
 * Convenience helper: return only the sanitized message string (e.g. for a
 * toast that shows just one line).
 */
export function sanitizeErrorMessage(err: unknown, fallback?: string): string {
  return sanitizeError(err, fallback ?? t('api.operationFailed')).message
}
