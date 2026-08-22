/**
 * network-tap.ts — shared window.fetch tap for real-backend E2E specs.
 *
 * Installed in beforeAll BEFORE register. Captures every fetch the renderer
 * issues — url / method / status / response body text (+ parsed JSON shape).
 *
 * Upgraded from the original per-spec `{url, status}` tap after /review code
 * S2 finding: status-only taps can't catch "server returns 200 with hardcoded
 * demo data in the body". Body capture lets specs assert actual shape.
 *
 * Contract:
 *   - Idempotent (window.__apiTapInstalled guard)
 *   - Non-throwing — falls back silently if clone() fails
 *   - Body captured as text (at most TAP_BODY_MAX chars) + a shape tag
 *     ('array' | 'object' | 'empty' | 'text' | 'error')
 *
 * Usage:
 *   import { installNetworkTap, getApiCalls, getCallsMatching } from './helpers/network-tap'
 *   ...
 *   await installNetworkTap(win)  // BEFORE register
 *   ...
 *   const calls = await getApiCalls(win)
 *   expect(historyCalls[0]?.bodyShape).toBe('array')   // ← S2-strength assertion
 */
import type { Page } from '@playwright/test'

export interface TappedCall {
  url: string
  method: string
  status: number
  /** Response body as text; truncated to TAP_BODY_MAX chars (default 4KB). */
  body?: string
  /** Rough classification of the body for quick assertions. */
  bodyShape?: 'array' | 'object' | 'empty' | 'text' | 'error'
}

const TAP_BODY_MAX = 4096

export async function installNetworkTap(win: Page, bodyMax: number = TAP_BODY_MAX): Promise<void> {
  await win.evaluate((maxBytes) => {
    interface TapWin {
      __apiTapInstalled?: boolean
      __apiCalls?: TappedCall[]
    }
    interface TappedCall {
      url: string
      method: string
      status: number
      body?: string
      bodyShape?: 'array' | 'object' | 'empty' | 'text' | 'error'
    }
    const w = window as typeof window & TapWin
    if (w.__apiTapInstalled) return
    w.__apiTapInstalled = true
    w.__apiCalls = []
    const orig = window.fetch.bind(window)
    window.fetch = async function (...args: Parameters<typeof fetch>) {
      const url =
        typeof args[0] === 'string' ? args[0] : (args[0] as Request).url
      const method =
        (typeof args[0] !== 'string' && (args[0] as Request).method) ||
        (args[1] && (args[1] as RequestInit).method) ||
        'GET'
      let resp: Response
      try {
        resp = await orig(...args)
      } catch (err) {
        w.__apiCalls!.push({
          url,
          method: String(method).toUpperCase(),
          status: 0,
          body: (err as Error)?.message ?? 'fetch-threw',
          bodyShape: 'error',
        })
        throw err
      }
      let body: string | undefined
      let bodyShape: TappedCall['bodyShape'] = 'empty'
      try {
        const clone = resp.clone()
        const raw = await clone.text()
        const trimmed = raw.length > maxBytes ? raw.slice(0, maxBytes) : raw
        body = trimmed
        if (!raw) {
          bodyShape = 'empty'
        } else {
          const firstNonWs = raw.replace(/^\s+/, '')[0]
          if (firstNonWs === '[') bodyShape = 'array'
          else if (firstNonWs === '{') bodyShape = 'object'
          else bodyShape = 'text'
        }
      } catch {
        /* non-clonable / already-consumed body — leave body undef, shape empty */
      }
      w.__apiCalls!.push({
        url,
        method: String(method).toUpperCase(),
        status: resp.status,
        body,
        bodyShape,
      })
      return resp
    }
  }, bodyMax)
}

export async function getApiCalls(win: Page): Promise<TappedCall[]> {
  return (await win.evaluate(() => {
    const w = window as typeof window & { __apiCalls?: TappedCall[] }
    return w.__apiCalls ?? []
  })) as TappedCall[]
}

/** Convenience: filter by URL substring OR regex. */
export async function getCallsMatching(
  win: Page,
  match: string | RegExp,
): Promise<TappedCall[]> {
  const all = await getApiCalls(win)
  return all.filter((c) =>
    typeof match === 'string' ? c.url.includes(match) : match.test(c.url),
  )
}
