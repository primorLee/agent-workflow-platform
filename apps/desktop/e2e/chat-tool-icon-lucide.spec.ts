import { test, expect } from '@playwright/test'

/**
 * chat-tool-icon-lucide.spec.ts — E2E for the emoji→Lucide SVG migration.
 *
 * Scope (why this file exists):
 *   Method E (agreed 2026-04-23) replaces the 10 emoji-based tool status
 *   labels (📖 读取文件, ✏️ 编辑文件 ...) with Lucide SVG icons rendered
 *   by `desktop/src/components/chat/ToolIcon.vue`. Backend still emits
 *   the `cc_status` SSE events with `{tool: <name>, label: <zh-text>}`,
 *   but labels no longer contain emoji. The frontend maps `tool` → SVG.
 *
 * Why this is a chromium (not Electron) spec:
 *   The value-add here is proving that the REAL Vue component + the
 *   REAL lucide-vue-next bundle render together without any icon
 *   missing/mis-tree-shaken. Unit tests (ToolIcon.spec.ts) already
 *   cover the Vue component in isolation with happy-dom; this spec
 *   runs the component in a real Chromium browser against the vite
 *   dev server so we exercise the full module resolution path (JS
 *   bundler + ESM imports + Vue mount).
 *
 *   Driving the real Electron app to a state where ToolIcon renders
 *   requires bypassing auth/routing — which is brittle and adds no
 *   additional coverage beyond "does the component render". We use
 *   addInitScript to inject a self-contained mount in a blank page
 *   served by vite, then assert on the resulting DOM.
 *
 * What we assert end-to-end:
 *   1. Three ToolIcon components (Read / Bash / Grep) mount and each
 *      exposes `[data-testid="tool-icon"]`.
 *   2. Each SVG carries the canonical lucide-* class for its mapped
 *      icon (book-open, terminal, search-code). Status overrides
 *      (done/running) are exercised by a second batch of assertions.
 *   3. REVERSE assertion — no legacy emoji character (📖 ✏️ 📝 ⚡ 🔍 📁
 *      🤖 🌐 📋 🔧) appears in the rendered DOM. Regression guard.
 *   4. Visual sign-off screenshot.
 *
 * Runs against the main `playwright.config.ts` (chromium project +
 * vite dev server on localhost:5173).
 */

// Legacy emoji characters the old `_TOOL_LABELS` map used — regression
// guard. Using explicit codepoints so a stray copy-paste can't
// reintroduce them silently.
const LEGACY_EMOJI = [
  '\u{1F4D6}', // 📖
  '\u{270F}\u{FE0F}', // ✏️
  '\u{1F4DD}', // 📝
  '\u{26A1}', // ⚡
  '\u{1F50D}', // 🔍
  '\u{1F4C1}', // 📁
  '\u{1F916}', // 🤖
  '\u{1F310}', // 🌐
  '\u{1F4CB}', // 📋
  '\u{1F527}', // 🔧
]

test.describe('chat tool icon — Lucide SVG migration', () => {
  test('ToolIcon renders Lucide SVGs (no legacy emoji) for every mapped tool', async ({ page }) => {
    // Start from any page served by the vite dev server; we'll replace
    // the body below anyway. The index.html route is safe because it
    // doesn't require auth at this stage.
    await page.goto('/', { waitUntil: 'domcontentloaded' })

    // Nuke any existing Vue app and set up a clean mount container.
    // Then dynamic-import the app's real ToolIcon module (same path
    // the dist bundle resolves from) and mount three instances.
    const mountResult = await page.evaluate(async () => {
      document.body.innerHTML = '<div id="tool-icon-test-root"></div>'
      // Vite dev server resolves these via its /src/ prefix.
      const [{ default: ToolIcon }, Vue] = await Promise.all([
        import('/src/components/chat/ToolIcon.vue'),
        import('/node_modules/.vite/deps/vue.js').catch(() => import('vue' as any)),
      ])
      const { createApp, h } = Vue as any
      const root = document.getElementById('tool-icon-test-root')!

      // Three ToolIcon instances replicating what the todo-panel does:
      // two "done" items + one "running" current item + one "idle"
      // item (so we also exercise the mapped-icon path, not just the
      // status override).
      const App = {
        render() {
          return h('div', { class: 'todo-panel-mock' }, [
            h(ToolIcon, { tool: 'Read', status: 'done' }),
            h(ToolIcon, { tool: 'Bash', status: 'done' }),
            h(ToolIcon, { tool: 'Grep', status: 'running' }),
            h(ToolIcon, { tool: 'Glob', status: 'idle' }),
            h(ToolIcon, { tool: 'TodoWrite', status: 'idle' }),
            h(ToolIcon, { tool: 'Edit', status: 'idle' }),
            h(ToolIcon, { tool: 'Write', status: 'idle' }),
            h(ToolIcon, { tool: 'Agent', status: 'idle' }),
            h(ToolIcon, { tool: 'WebSearch', status: 'idle' }),
            h(ToolIcon, { tool: 'WebFetch', status: 'idle' }),
            h(ToolIcon, { tool: 'UnknownTool', status: 'idle' }), // wrench fallback
          ])
        },
      }
      createApp(App).mount(root)
      // Wait one macrotask so Vue finishes the mount.
      await new Promise((r) => setTimeout(r, 50))
      return { ok: true, count: document.querySelectorAll('[data-testid="tool-icon"]').length }
    })

    expect(mountResult).toMatchObject({ ok: true })
    expect(mountResult.count).toBe(11)

    // Each ToolIcon should expose data-testid + data-tool + data-status.
    const icons = page.locator('[data-testid="tool-icon"]')
    await expect(icons).toHaveCount(11)

    // Pull every SVG's class + data-tool so we can assert by tool name.
    const perIcon = await icons.evaluateAll((els) =>
      els.map((el) => ({
        classes: el.getAttribute('class') || '',
        tool: el.getAttribute('data-tool') || '',
        status: el.getAttribute('data-status') || '',
      })),
    )

    // Helper: find the ToolIcon entry with the given tool+status combo.
    const findIcon = (tool: string, status: string) =>
      perIcon.find((p) => p.tool === tool && p.status === status)

    // Status overrides: done → circle-check, running → loader-circle.
    expect(findIcon('Read', 'done')?.classes).toContain('lucide-circle-check')
    expect(findIcon('Bash', 'done')?.classes).toContain('lucide-circle-check')
    expect(findIcon('Grep', 'running')?.classes).toContain('lucide-loader-circle')

    // Idle items use the mapped tool icon (lucide 1.x canonical names).
    //   Glob → folder-search, TodoWrite → list-checks, Edit3 → pen-line,
    //   Write → file-plus, Agent → bot, WebSearch → earth (Globe2 alias),
    //   WebFetch → cloud-download (DownloadCloud alias).
    expect(findIcon('Glob', 'idle')?.classes).toContain('lucide-folder-search')
    expect(findIcon('TodoWrite', 'idle')?.classes).toContain('lucide-list-checks')
    expect(findIcon('Edit', 'idle')?.classes).toContain('lucide-pen-line')
    expect(findIcon('Write', 'idle')?.classes).toContain('lucide-file-plus')
    expect(findIcon('Agent', 'idle')?.classes).toContain('lucide-bot')
    expect(findIcon('WebSearch', 'idle')?.classes).toContain('lucide-earth')
    expect(findIcon('WebFetch', 'idle')?.classes).toContain('lucide-cloud-download')

    // Unknown tool → wrench fallback.
    expect(findIcon('UnknownTool', 'idle')?.classes).toContain('lucide-wrench')

    // REVERSE assertion: no legacy emoji anywhere in the rendered DOM.
    const fullHtml = await page.locator('.todo-panel-mock').innerHTML()
    for (const emoji of LEGACY_EMOJI) {
      expect(
        fullHtml.includes(emoji),
        `rendered DOM must not contain legacy emoji ${emoji}`,
      ).toBe(false)
    }

    // Visual sign-off screenshot.
    await page.locator('.todo-panel-mock').screenshot({
      path: 'e2e/__screenshots__/chat-tool-icon-lucide.png',
    })
  })
})
