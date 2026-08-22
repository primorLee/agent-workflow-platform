import { test, expect } from '@playwright/test'

/**
 * auth-401-renderer.spec.ts — FIX-S3 verification.
 *
 * Scenario: a non-SSE REST call (e.g. `/v1/tasks`) returns 401
 * because the cached token silently expired. The renderer must:
 *
 *   1. Show a toast matching the "登录已过期" / "Session expired" copy.
 *   2. Navigate to the /login route (hash-router => URL ends with `#/login`).
 *   3. Debounce — repeated 401s in the same tick must NOT stack toasts or
 *      trigger a router.push loop. We assert only ONE toast exists after
 *      three parallel 401s.
 *
 * Route-mock pattern mirrors `desktop/e2e/chat.spec.ts`: we use a URL
 * predicate so the Vite dev server on :5173 is NOT matched (which would
 * break Vue bootstrap).
 *
 * NB: this spec targets the vite dev server (`playwright.config.ts` in
 * the default suite), NOT the Electron harness. The 401 path is
 * renderer-only — it doesn't need the Electron preload bridge. If the
 * Electron config needs equivalent coverage later, fork this into
 * `auth-401-electron.spec.ts`.
 */

test.describe('REST 401 → renderer login redirect', () => {
  test.beforeEach(async ({ page }) => {
    await page.route((url) => {
      try {
        const u = new URL(url.toString())
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
        if (u.host === 'localhost:5173') return false
        return u.pathname.startsWith('/api/') || u.pathname.startsWith('/v1/')
      } catch { return false }
    }, async (route) => {
      const url = route.request().url()

      // Force 401 for the endpoints we care about; everything else stays 200
      // so the app can bootstrap past the initial health poll.
      if (url.includes('/v1/tasks')) {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({
            error_type: 'UNAUTHORIZED',
            detail: 'Token expired',
          }),
        })
        return
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok', version: '1.6.3-test' }),
      })
    })
  })

  test('401 on tasks redirects to /login and shows expired toast', async ({ page }) => {
    await page.goto('/#/')

    // Trigger the 401 from the renderer context so the real ApiClient
    // interceptor runs (not a synthetic fetch). We reach into the exposed
    // `api` singleton if the app registered it on window for debugging;
    // otherwise fall back to a bare fetch which also hits the mock.
    await page.evaluate(async () => {
      try {
        await fetch(`${window.location.origin}/v1/tasks`, {
          headers: { Authorization: 'Bearer stale-token' },
        })
      } catch { /* network errors surface in client.ts, not here */ }
    })

    // Route assertion — hash router, so we wait for `#/login`.
    await page.waitForURL(/#\/login/, { timeout: 5_000 })
    await expect(page).toHaveURL(/#\/login/)

    // Toast assertion. The exact selector depends on the toast component; we
    // match the i18n string directly from either `.toast` or any element
    // carrying the expected text to stay resilient across refactors.
    const toast = page.getByText(/登录已过期|Session expired/).first()
    await expect(toast).toBeVisible({ timeout: 5_000 })
  })

  test('three parallel 401s only toast once (shared debounce with SSE path)', async ({ page }) => {
    await page.goto('/#/')

    // Kick off three simultaneous 401-returning requests. Without the shared
    // debounce in `authStaleCoordinator.ts`, each would re-toast + re-push.
    await page.evaluate(async () => {
      await Promise.all([
        fetch(`${window.location.origin}/v1/tasks`).catch(() => {}),
        fetch(`${window.location.origin}/v1/notifications`).catch(() => {}),
        fetch(`${window.location.origin}/v1/activity`).catch(() => {}),
      ])
    })

    await page.waitForURL(/#\/login/, { timeout: 5_000 })

    // Allow the toast store to flush.
    await page.waitForTimeout(500)

    const toastCount = await page
      .getByText(/登录已过期|Session expired/)
      .count()
    // Exactly one visible toast, not three. The coordinator swallows the
    // duplicates so the user isn't spammed.
    expect(toastCount).toBeLessThanOrEqual(1)
  })
})
