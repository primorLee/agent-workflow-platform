import { test, expect } from '@playwright/test'

/**
 * Chat view flow.
 *
 * Mock uses URL predicate (not wildcard glob). Wildcard would match
 * vite dev-server source files on :5173 and break Vue bootstrap.
 */

test.describe('Chat View', () => {
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
      if (url.includes('/models')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([{ id: 'awp-demo', name: 'AWP Local Demo', provider: 'awp-demo' }]),
        })
        return
      }
      if (url.includes('/history') || url.includes('/conversations')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([]),
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

  test('empty chat renders quick-prompt welcome state', async ({ page }) => {
    await page.goto('/#/')
    await expect(page.locator('.layout')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.chat-panel')).toBeVisible()
    await expect(page.locator('.empty-chat').first()).toBeVisible({ timeout: 10_000 })
  })

  test('textarea input enables the send button and preserves value', async ({ page }) => {
    await page.goto('/#/')
    await expect(page.locator('.layout')).toBeVisible({ timeout: 10_000 })
    const input = page.locator('textarea.chat-input')
    const send = page.locator('.send-btn').first()
    await expect(input).toBeVisible()
    await expect(send).toBeDisabled()
    await input.fill('Analyze the failing test log and propose a fix')
    await expect(input).toHaveValue('Analyze the failing test log and propose a fix')
    await expect(send).toBeEnabled()
  })

  test('file attach populates textarea with code-fenced content', async ({ page }) => {
    await page.goto('/#/')
    await expect(page.locator('.layout')).toBeVisible({ timeout: 10_000 })
    const attachBtn = page.locator('.input-icon-btn').first()
    const fileInput = page.locator('input[type="file"]')
    const artifact = 'status: failed\nstep: unit-test\nmessage: timeout\n'
    await fileInput.setInputFiles({
      name: 'task.log',
      mimeType: 'text/plain',
      buffer: Buffer.from(artifact, 'utf-8'),
    })
    const input = page.locator('textarea.chat-input')
    await expect(input).toHaveValue(/```[\s\S]*status: failed[\s\S]*message: timeout[\s\S]*```/, { timeout: 5_000 })
    expect(await attachBtn.count()).toBeGreaterThan(0)
  })
})
