import { test, expect } from '@playwright/test'

/**
 * Visual regression baseline for the v1.7 UI refresh (sidebar / chat /
 * artifact re-skin). Captures per-region screenshots against a checked-in
 * baseline via Playwright's `toHaveScreenshot`. Run `npx playwright test
 * ui-refresh-visual --update-snapshots` to regenerate baselines after
 * intentional visual changes.
 *
 * Scope is LIMITED — only the chrome / shell regions this PR refactored:
 *   - `.sidebar` (brand, primary button, threads section, tools section)
 *   - `.app` empty-state (cards + gaps + composer)
 *   - `.input-box` composer (standalone, focused)
 *
 * The right-hand ArtifactPanel is NOT opened here (needs assistant message
 * seed) — that'll ride on `artifact-empty-visual.spec.ts` once we have a
 * store fixture. The adversarial review pipeline compares these PNGs
 * against the spec deck shipped with the task.
 *
 * Both `light` and `dark` themes are captured — the dark baseline exists
 * specifically to prove the ArtifactPanel illustration-filter dampener
 * (brightness 0.46 / contrast 0.92) renders cleanly, not neon. If dark
 * ever drifts, tune the filter in `ArtifactPanel.vue` or (longer-term)
 * swap hardcoded SVG fills for CSS-variable-driven ones.
 */

/**
 * Install the API-mock + storage-seed + viewport fixture on a page.
 * `theme` is written to BOTH the user-scoped and legacy localStorage keys
 * (settings store reads `awp_settings_<cid>` with fallback to
 * `awp_settings`; there's no logged-in user in e2e so we cover both).
 * We also set `data-theme` directly on `<html>` so the stylesheet picks
 * it up before Vue bootstraps — this is the belt-and-braces fix for the
 * store-hydration race.
 */
function installFixture(theme: 'light' | 'dark') {
  return async ({ page }: { page: import('@playwright/test').Page }) => {
    await page.route(
      (url) => {
        try {
          const u = new URL(url.toString())
          if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
          if (u.host === 'localhost:5173') return false
          return u.pathname.startsWith('/api/') || u.pathname.startsWith('/v1/')
        } catch {
          return false
        }
      },
      async (route) => {
        const url = route.request().url()
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
          body: JSON.stringify({ ok: true, data: {} }),
        })
      },
    )

    await page.addInitScript((t: string) => {
      try {
        const payload = JSON.stringify({ theme: t, language: 'zh-CN' })
        // Cover both keys the settings store might read — the legacy
        // `_v1` suffix was the previous test convention and is kept for
        // continuity; `awp_settings` is what `_storageKey()` falls
        // back to when no user is logged in.
        localStorage.setItem('awp_settings_v1', payload)
        localStorage.setItem('awp_settings', payload)
      } catch {
        /* storage unavailable in strict-Electron contexts */
      }
      // Apply data-theme synchronously so the first paint is already the
      // right palette — avoids a light→dark flash that would poison the
      // screenshot if Vue hydrates a frame late.
      try {
        document.documentElement.setAttribute('data-theme', t)
        if (t === 'dark') document.documentElement.classList.add('dark')
      } catch {
        /* document unavailable pre-bootstrap in some harnesses */
      }
    }, theme)

    // Fixed viewport so screenshots are byte-stable. Matches the spec deck
    // proportions (roughly 1600×900 desktop).
    await page.setViewportSize({ width: 1600, height: 900 })
  }
}

test.describe('UI refresh — visual baselines', () => {
  test.beforeEach(installFixture('light'))

  test('sidebar @ light theme — brand + primary + threads header + tools group', async ({ page }) => {
    await page.goto('/#/')
    const sidebar = page.locator('.sidebar')
    await expect(sidebar).toBeVisible({ timeout: 10_000 })
    // Wait for brand title so paint is settled before the shot.
    await expect(sidebar.locator('.brand-title')).toBeVisible()
    await expect(sidebar.locator('.new-thread-btn')).toBeVisible()
    await expect(sidebar.locator('.section-title').first()).toHaveText(/对话历史|History/)
    // Freeze any pending animations (sidebar has a width transition on collapse).
    await page.waitForTimeout(250)
    await expect(sidebar).toHaveScreenshot('sidebar-light.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.02,
    })
  })

  test('app shell @ empty chat — three-column cards + gaps', async ({ page }) => {
    await page.goto('/#/')
    await expect(page.locator('.app')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.sidebar')).toBeVisible()
    await expect(page.locator('.app-main')).toBeVisible()
    // The input composer is the single most-scrutinised region per
    // the spec §5.5 — make sure it's painted before the shot.
    await expect(page.locator('.input-box')).toBeVisible()
    await page.waitForTimeout(250)
    await expect(page).toHaveScreenshot('app-empty-light.png', {
      animations: 'disabled',
      fullPage: false,
      maxDiffPixelRatio: 0.02,
    })
  })

  test('composer @ rest + focused — rounded pill, primary send', async ({ page }) => {
    await page.goto('/#/')
    const composer = page.locator('.input-box')
    await expect(composer).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(250)
    await expect(composer).toHaveScreenshot('composer-rest-light.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.02,
    })

    await page.locator('textarea.chat-input').focus()
    // Focus ring has a 150ms transition — wait it out.
    await page.waitForTimeout(300)
    await expect(composer).toHaveScreenshot('composer-focus-light.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.02,
    })
  })
})

test.describe('UI refresh — visual baselines — dark theme', () => {
  test.beforeEach(installFixture('dark'))

  test('sidebar @ dark theme — brand + primary + threads header + tools group', async ({ page }) => {
    await page.goto('/#/')
    const sidebar = page.locator('.sidebar')
    await expect(sidebar).toBeVisible({ timeout: 10_000 })
    await expect(sidebar.locator('.brand-title')).toBeVisible()
    await expect(sidebar.locator('.new-thread-btn')).toBeVisible()
    await expect(sidebar.locator('.section-title').first()).toHaveText(/对话历史|History/)
    // Sanity: the data-theme attribute really did stick — without this the
    // test could silently re-capture the light palette and we'd lock in a
    // wrong "dark" baseline.
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.waitForTimeout(250)
    await expect(sidebar).toHaveScreenshot('sidebar-dark.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.02,
    })
  })

  test('app shell @ empty chat + dark — three-column cards + gaps', async ({ page }) => {
    await page.goto('/#/')
    await expect(page.locator('.app')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.sidebar')).toBeVisible()
    await expect(page.locator('.app-main')).toBeVisible()
    await expect(page.locator('.input-box')).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.waitForTimeout(250)
    await expect(page).toHaveScreenshot('app-empty-dark.png', {
      animations: 'disabled',
      fullPage: false,
      maxDiffPixelRatio: 0.02,
    })
  })

  test('composer @ rest + focused + dark — rounded pill, primary send', async ({ page }) => {
    await page.goto('/#/')
    const composer = page.locator('.input-box')
    await expect(composer).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.waitForTimeout(250)
    await expect(composer).toHaveScreenshot('composer-rest-dark.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.02,
    })

    await page.locator('textarea.chat-input').focus()
    await page.waitForTimeout(300)
    await expect(composer).toHaveScreenshot('composer-focus-dark.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.02,
    })
  })
})
