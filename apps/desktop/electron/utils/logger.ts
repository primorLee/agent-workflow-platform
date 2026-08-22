/**
 * Simple file logger — replaces Python's _log().
 *
 * Appends timestamped lines to ~/.awp/launch.log.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { getLogPath, getAwpDir } from './config'

/** Ensure the log directory exists (called once). */
let dirEnsured = false
function ensureDir(): void {
  if (dirEnsured) return
  try {
    mkdirSync(getAwpDir(), { recursive: true })
  } catch {
    // already exists or truly broken — either way, we tried
  }
  dirEnsured = true
}

/**
 * Append a timestamped message to the launch log.
 *
 * Never throws — logging failures are silently swallowed.
 */
export function log(msg: string): void {
  try {
    ensureDir()
    const ts = new Date().toISOString()
    appendFileSync(getLogPath(), `[${ts}] ${msg}\n`, 'utf-8')
  } catch {
    // swallow — console.error would go nowhere in packaged app
  }
}

/**
 * Log an error with optional stack trace.
 */
export function logError(context: string, err: unknown): void {
  const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
  log(`ERROR [${context}] ${message}`)
}
