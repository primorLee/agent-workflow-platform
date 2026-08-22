import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

/**
 * login.spec.ts — FOLLOWUP-03 Layer 1 E2E smoke.
 *
 * 目标: 锁定桌面客户端登录流程不被 UI 改动悄悄打破
 *   1. 启动 Electron → 主窗口可见
 *   2. 进入 /#/login, 输入账号密码, 点提交
 *   3. 登录成功 → 跳转聊天主界面 (.chat-input 可见)
 *   4. 重启 app, 不再看到 LoginView (session 持久化)
 *
 * 为什么不接真 cloud:
 *   - CI / 离线开发没法打真 203.0.113.10
 *   - `page.route()` 在渲染进程拦 `/v1/auth/login` 和 `/v1/auth/validate`,
 *     保证 hermetic. 生产登录路径 `useAuthStore.login → authApi.login → POST /v1/auth/login`
 *     一字不差, 只是响应被本地 mock.
 *
 * 凭据来源:
 *   - `AWP_E2E_USER` + `AWP_E2E_PASS` — 未设 skip
 *   - 任何字符串都接受 (mock route 不校验密码), 纯用作"非空 email/password" 入参
 *
 * 为什么走 dist 包而非 vite dev:
 *   - `isDevMode` 为 true 时 LoginView.onMounted 直接 router.replace('/'),
 *     testcase 根本走不到填表那一步. 必须用 `vite build` 产物 (dist/index.html),
 *     vm-exec-flow.spec.ts 同样道理.
 *
 * 为什么不断言持久化细节 (safeStorage/localStorage):
 *   - 这是 smoke, 只验"用户眼里登录态还在". 细节归 vitest 单测 (auth.store.spec.ts).
 *
 * 本地跑:
 *   cd desktop && npm run dev:electron  # 产 dist + dist-electron
 *   AWP_E2E_USER=test@example.com AWP_E2E_PASS=pw npx playwright test \
 *     --config=playwright.electron.config.ts e2e/login.spec.ts
 *
 * --list (语法检查, 不需要凭据):
 *   npx playwright test --config=playwright.electron.config.ts --list
 */

const DESKTOP_ROOT = path.resolve(__dirname, '..')
const E2E_USER = process.env.AWP_E2E_USER ?? 'demo@example.test'
const E2E_PASS = process.env.AWP_E2E_PASS ?? 'local-demo-password'

// Electron 主进程 settings.json 默认 serverUrl 指向真 cloud; 用一个本地占位 URL
// 作为 baseUrl. 所有 /v1/auth/* 会被 page.route 拦下, 根本不会真发. 保留一个
// https:// 前缀是因为 api/client.ts 会校验 baseUrl 格式.
const FAKE_CLOUD = 'https://e2e-mock.example.test'

interface MockedResponse {
  status: number
  contentType?: string
  body: string
}

/**
 * 统一的 /v1/* 拦截. 返回成功登录态:
 *   - POST /v1/auth/login → { api_key, customer_id }
 *   - GET  /v1/auth/validate → { valid: true, customer_id, email }
 *   - 其余 /v1/* → 200 {} 兜底 (chat history / settings / threads 等不影响 login 判定)
 * 非 /v1/ 路径 (localhost dev-server 资源) 不拦, 透传.
 */
function buildV1Responder(email: string): (pathname: string, method: string) => MockedResponse {
  // Stub token generated per-run. Not a real credential; just satisfies renderer auth store.
  const stubToken = `e2e-stub-${Math.random().toString(36).slice(2, 10)}`
  return (pathname, method) => {
    if (pathname === '/v1/auth/login' && method === 'POST') {
      return {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ api_key: stubToken, customer_id: 'e2e-customer-001' }),
      }
    }
    if (pathname === '/v1/auth/validate' && method === 'GET') {
      return {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ valid: true, customer_id: 'e2e-customer-001', email }),
      }
    }
    // Chat history / settings / threads / etc — 给空数据成功, 别让 UI 挂错误 toast.
    return {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: [], items: [], messages: [] }),
    }
  }
}

async function installRouteMocks(page: import('@playwright/test').Page, email: string): Promise<void> {
  const responder = buildV1Responder(email)
  await page.route(
    (url) => {
      try {
        const u = new URL(url.toString())
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
        return u.pathname.startsWith('/v1/')
      } catch {
        return false
      }
    },
    async (route) => {
      const req = route.request()
      const u = new URL(req.url())
      const resp = responder(u.pathname, req.method())
      await route.fulfill(resp)
    },
  )
}

async function launchElectron(userDataDir: string): Promise<ElectronApplication> {
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env }
  // 见 vm-exec-flow.spec.ts 的长注释: ELECTRON_RUN_AS_NODE=1 会让 electron.exe 按
  // Node 启动, 与 Playwright 传的 --remote-debugging-port=0 冲突, exit 9.
  delete cleanEnv.ELECTRON_RUN_AS_NODE
  return electron.launch({
    args: [DESKTOP_ROOT],
    env: {
      ...cleanEnv,
      NODE_ENV: 'test',
      AWP_HOSTED_AUTH_OPT_IN: '1',
      AWP_API_BASE: FAKE_CLOUD,
      AWP_ALLOW_ANY_PATH: '1',
      AWP_USER_DATA_DIR: userDataDir,
      AWP_TEST_USER_DATA_DIR_OPT_IN: '1',
    },
    timeout: 45_000,
  })
}

async function pickMainWindow(app: ElectronApplication, waitMs = 20_000) {
  const start = Date.now()
  while (Date.now() - start < waitMs) {
    for (const w of app.windows()) {
      const url = w.url()
      if (url && !url.startsWith('devtools://')) return w
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return await app.firstWindow()
}

test.describe('login flow (local smoke)', () => {
  test('login submits and lands on chat, then persists across restart', async () => {
    // 共享 userData 目录, 跨两次 launch 保持 safeStorage/localStorage. afterAll 再清.
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-e2e-login-'))

    // --- 第一次启动: 真实走登录表单 ---
    let app = await launchElectron(userDataDir)
    try {
      const win = await pickMainWindow(app)
      await win.waitForLoadState('domcontentloaded')
      await installRouteMocks(win, E2E_USER)

      // 未登录时 router guard 会把任何路由重定向到 /login.
      // 显式 hash 跳一次, 保证到 LoginView (防 onboarding / setup 插队).
      await win.evaluate(() => { window.location.hash = '#/login' })
      await expect(win.locator('.login-card')).toBeVisible({ timeout: 15_000 })

      // 填表 — autocomplete="email" / type="password" 两个 input 是稳定锚点
      await win.locator('.login-card input[type="email"]').fill(E2E_USER)
      await win.locator('.login-card input[type="password"]').fill(E2E_PASS)

      // 提交 — .login-card 内唯一 type=submit 按钮 (mode=login 时没有 confirm password)
      await win.locator('.login-card button[type="submit"]').click()

      // 成功标志: 跳到 chat 主界面, .chat-input 可见
      await expect(win.locator('.chat-input').first()).toBeVisible({ timeout: 20_000 })
      await expect(win.locator('.login-card')).toHaveCount(0)
    } finally {
      await app.close()
    }

    // --- 第二次启动: 共享 userData, 应直接进 chat (session restore) ---
    app = await launchElectron(userDataDir)
    try {
      const win = await pickMainWindow(app)
      await win.waitForLoadState('domcontentloaded')
      // validate/login 仍需 mock — checkSession 会打 /v1/auth/validate 校验缓存 token.
      await installRouteMocks(win, E2E_USER)

      // 给 router guard + checkSession 跑完 (migrateOldCredentials + validateToken).
      // 不手动跳 hash — 让 router 按已有 token 自然落到 chat.
      await expect(win.locator('.chat-input').first()).toBeVisible({ timeout: 20_000 })
      // 反向断言: 如果 persistence 断了, 会被打回 /login
      await expect(win.locator('.login-card')).toHaveCount(0)
    } finally {
      await app.close()
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }
  })
})
