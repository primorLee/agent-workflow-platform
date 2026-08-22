import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

/**
 * chat-sse.spec.ts — B4-08 Layer 1 E2E smoke, Electron chat SSE path.
 *
 * 为什么和 chat.spec.ts 同级但独立文件:
 *   - 现有 `e2e/chat.spec.ts` 是主 `playwright.config.ts` 的 chromium 套件
 *     (走 vite dev + baseURL:5173 + page.goto), 聚焦空状态 / 输入框 / 文件附加.
 *   - 本文件走 `playwright.electron.config.ts` (electron.launch + dist), 聚焦
 *     真实 SSE 流水线 "发消息 → 收 delta → assistant 气泡". 两者职责/宿主环境
 *     都不同, 合并成一个文件会让 testMatch 难以分辨.
 *
 * 目标 2 个 case:
 *   1. 正常流 — mock /v1/chat/completions 返 `data: {"delta":"好"}` + `"的"` +
 *      `done:true`, 断言 .assistant-bubble 最终含 "好的".
 *   2. 错误流 — /v1/chat/completions abort('failed'), 断言 .stream-error-bubble
 *      出现, 标题 = "回复失败" (chat.streamErrorTitle).
 *
 * 为什么不用 EventSource / route-mocked SSE.fulfill with body 字符串:
 *   - sse.ts 用 fetch + ReadableStream, 按 `\n` 切行解析 `data: <json>`.
 *     fulfil 的 body 就是原始字节, 浏览器 fetch 当成完整响应拉一次性读取,
 *     可以正确触发 sse.ts 的逐行解析. 多帧之间的"时序"不重要, 只要
 *     所有帧都能被解析并触发 onMessage, chunk.delta 会按顺序拼进 streamingReply.
 *
 * 为什么断言 .assistant-bubble 而不是 streamingReply ref:
 *   - streamingReply 是 store ref, 不直接进 DOM. 只有 `done:true` 到达后
 *     (chat.ts:656-675) 才 push 进 currentMessages, 由 MessageBubble 渲染到
 *     .assistant-bubble — 这也是用户肉眼看到的最终态.
 *
 * 本地跑:
 *   cd desktop && npm run dev:electron  # 产 dist + dist-electron
 *   AWP_E2E_USER=test@example.com AWP_E2E_PASS=pw npx playwright test \
 *     --config=playwright.electron.config.ts e2e/chat-sse.spec.ts
 *
 * --list (语法检查, 不需要凭据):
 *   npx playwright test --config=playwright.electron.config.ts --list
 */

const DESKTOP_ROOT = path.resolve(__dirname, '..')
const E2E_USER = process.env.AWP_E2E_USER ?? 'demo@example.test'
const E2E_PASS = process.env.AWP_E2E_PASS ?? 'local-demo-password'

// 与 login.spec.ts 同款占位 baseUrl; /v1/* 会被 route 全数拦截.
const FAKE_CLOUD = 'https://e2e-mock.example.test'

interface MockedResponse {
  status: number
  contentType?: string
  body: string
}

/**
 * 标准 /v1/* 辅助响应 — login / validate / history / threads 等兜底成功.
 * 不处理 /v1/chat/completions (由 completionsHandler 专管).
 */
function buildAuxResponder(email: string): (pathname: string, method: string) => MockedResponse {
  // Stub token per run — 纯给渲染进程 auth store 用, 不是真凭据, 避开 secret lint.
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
    // 兜底 — 历史 / 线程 / 设置 等给空成功, 别让 UI 挂错误 toast.
    return {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: [], items: [], messages: [] }),
    }
  }
}

/**
 * 安装 /v1/* mock. /v1/chat/completions 单独交给 completionsHandler 定制
 * (SSE success or abort). 非 /v1 的请求 (localhost dev-server 资源) 不拦截.
 */
async function installRouteMocks(
  page: import('@playwright/test').Page,
  email: string,
  completionsHandler: (route: import('@playwright/test').Route) => Promise<void>,
): Promise<void> {
  const aux = buildAuxResponder(email)
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
      if (u.pathname === '/v1/chat/completions') {
        await completionsHandler(route)
        return
      }
      const resp = aux(u.pathname, req.method())
      await route.fulfill(resp)
    },
  )
}

/**
 * SSE 成功体: 两帧 delta ("好" + "的") + done + [DONE].
 * 格式严格遵循 sse.ts 的 `data: <json>\n\n` 解析逻辑 (split 按 '\n').
 */
function buildSseSuccessBody(): string {
  return [
    'data: {"delta":"好"}',
    '',
    'data: {"delta":"的"}',
    '',
    'data: {"done":true}',
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n')
}

async function launchElectron(userDataDir: string): Promise<ElectronApplication> {
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env }
  // 见 vm-exec-flow.spec.ts 长注释: ELECTRON_RUN_AS_NODE=1 会与 Playwright 的
  // --remote-debugging-port=0 冲突, exit 9. 手动清掉.
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

/**
 * 共用登录 → 聊天主界面 helper. 与 login.spec.ts 的前半段一致.
 */
async function loginAndReachChat(win: import('@playwright/test').Page): Promise<void> {
  await win.evaluate(() => { window.location.hash = '#/login' })
  await expect(win.locator('.login-card')).toBeVisible({ timeout: 15_000 })
  await win.locator('.login-card input[type="email"]').fill(E2E_USER)
  await win.locator('.login-card input[type="password"]').fill(E2E_PASS)
  await win.locator('.login-card button[type="submit"]').click()
  await expect(win.locator('.chat-input').first()).toBeVisible({ timeout: 20_000 })
}

test.describe('chat SSE flow (local smoke)', () => {
  test('发消息触发 SSE delta, assistant 气泡累积显示完整文本', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-e2e-chat-ok-'))
    const app = await launchElectron(userDataDir)
    try {
      const win = await pickMainWindow(app)
      await win.waitForLoadState('domcontentloaded')

      await installRouteMocks(win, E2E_USER, async (route) => {
        await route.fulfill({
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          },
          body: buildSseSuccessBody(),
        })
      })

      await loginAndReachChat(win)

      // .chat-input 是 textarea (ChatView.vue:590-600), .send-btn 是唯一发送按钮 (ChatView.vue:604)
      await win.locator('.chat-input').first().fill('请分析一次失败的本地部署并给出恢复步骤')
      await win.locator('.send-btn').click()

      // done:true 后 chat.ts 把 streamingReply push 进 currentMessages,
      // MessageBubble 渲染为 .assistant-bubble. marked 会把 "好的" 包成 <p>好的</p>.
      const assistant = win.locator('.assistant-bubble').last()
      await expect(assistant).toBeVisible({ timeout: 15_000 })
      await expect(assistant).toContainText('好的', { timeout: 15_000 })

      // 反向断言: 正常流不该冒出错误气泡
      await expect(win.locator('.stream-error-bubble')).toHaveCount(0)
    } finally {
      await app.close()
      try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })

  test('网络错误时显示 stream-error-bubble 提示「回复失败」', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-e2e-chat-err-'))
    const app = await launchElectron(userDataDir)
    try {
      const win = await pickMainWindow(app)
      await win.waitForLoadState('domcontentloaded')

      await installRouteMocks(win, E2E_USER, async (route) => {
        // 模拟网络断开 — sse.ts 的 fetch 会抛, onError 触发 streamErrorChunk (chat.ts:700-710)
        await route.abort('failed')
      })

      await loginAndReachChat(win)

      await win.locator('.chat-input').first().fill('测试网络错误')
      await win.locator('.send-btn').click()

      // 错误气泡应出现, 标题 = chat.streamErrorTitle = "回复失败" (zh-CN.json:267)
      const errBubble = win.locator('.stream-error-bubble')
      await expect(errBubble).toBeVisible({ timeout: 15_000 })
      await expect(errBubble.locator('.err-title')).toContainText('回复失败')
      await expect(errBubble.locator('.err-msg')).not.toBeEmpty()
    } finally {
      await app.close()
      try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })
})
