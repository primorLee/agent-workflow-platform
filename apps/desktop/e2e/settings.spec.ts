import { test, expect } from '@playwright/test'

/**
 * Settings view flow.
 *
 * Mock uses URL predicate so vite dev-server modules on :5173 pass through.
 */

test.describe('Settings View', () => {
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
          body: JSON.stringify({ ok: true, data: {} }),
        })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok', version: '1.4.0-test' }),
      })
    })
  })

  test('settings page renders with appearance + server sections', async ({ page }) => {
    await page.goto('/#/settings')
    await expect(page.locator('.settings-view')).toBeVisible({ timeout: 10_000 })
    const sections = await page.locator('.settings-section').count()
    expect(sections).toBeGreaterThanOrEqual(3)
    await expect(page.locator('.toggle-group').first()).toBeVisible()
  })

  test('theme toggle switches document data-theme attribute', async ({ page }) => {
    await page.goto('/#/settings')
    await expect(page.locator('.settings-view')).toBeVisible({ timeout: 10_000 })
    const themeGroup = page.locator('.toggle-group').first()
    const buttons = themeGroup.locator('button')
    await expect(buttons).toHaveCount(2)
    await buttons.nth(1).click()
    await expect.poll(async () =>
      await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
    ).toBe('light')
    await buttons.nth(0).click()
    await expect.poll(async () =>
      await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
    ).toBe('dark')
  })

  test('language selector switches page title between locales', async ({ page }) => {
    await page.goto('/#/settings')
    await expect(page.locator('.settings-view')).toBeVisible({ timeout: 10_000 })
    const langSelect = page.locator('.settings-view select.select').first()
    await expect(langSelect).toBeVisible()
    const title = page.locator('.settings-view .page-title').first()
    await langSelect.selectOption('en')
    await expect(title).toHaveText(/Settings/i, { timeout: 5_000 })
    await langSelect.selectOption('zh-CN')
    await expect(title).toHaveText(/设置/, { timeout: 5_000 })
  })
})
