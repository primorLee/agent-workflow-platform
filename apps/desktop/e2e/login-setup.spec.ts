import { test, expect } from '@playwright/test'

/**
 * Login + Setup flow.
 *
 * Dev mode auto-redirects /login and /setup to '/'. Mock uses URL predicate
 * (not wildcard glob) so vite dev-server source files on :5173 pass through
 * unintercepted.
 */

test.describe('Login & Setup Flow', () => {
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
      if (url.includes('/v1/')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, data: [] }),
        })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok', version: '1.4.0-test', data: [] }),
      })
    })
  })

  test('login route redirects to chat home in dev mode', async ({ page }) => {
    await page.goto('/#/login')
    await page.waitForURL(/#\/(\?.*)?$/, { timeout: 5_000 })
    await expect(page.locator('.chat-input').first()).toBeVisible({ timeout: 10_000 })
  })

  test('setup route redirects to chat home in dev mode', async ({ page }) => {
    await page.goto('/#/setup')
    await page.waitForURL(/#\/(\?.*)?$/, { timeout: 5_000 })
    await expect(page.locator('.layout').first()).toBeVisible({ timeout: 10_000 })
  })

  test('chat home page loads core UI shell', async ({ page }) => {
    await page.goto('/#/')
    await expect(page.locator('.layout').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.input-area').first()).toBeVisible()
    await expect(page.locator('.chat-input').first()).toBeVisible()
  })
})
