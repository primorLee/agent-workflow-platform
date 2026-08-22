import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import http, {
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from 'node:http'
import net from 'node:net'


/**
 * connection-status-dot-states.spec.ts — 完整遍历 ConnectionStatusDot 的 4 个
 * UI bucket: init / ready / reconnecting / down, 每个 bucket 的 CSS class 和
 * 中文 tooltip 都必须正确.
 *
 * (Batch 19 gap audit 续补 133 → 134, 对应候选
 *   "connection-status-dot-states — 模拟 init / connected / reconnecting /
 *    unknown-pending 四态, dot CSS class 正确, tooltip 中文正确").
 *
 * ---------------------------------------------------------------------------
 * 组件映射矩阵 (useSseStatus.ts::mapServerStateToUi):
 * ---------------------------------------------------------------------------
 *   server state      last_error         → UI bucket   class suffix   tooltip 起手
 *   ----------------  -----------------  ------------  -------------  -------------
 *   'online'           -                 → 'ready'       dot--ready     "云端 SSE: 已连接"
 *   'degraded'         -                 → 'ready'       dot--ready     "云端 SSE: 已连接"
 *   'connecting'       -                 → 'reconnecting' dot--reconnecting "云端 SSE: 重连中"
 *   'offline'          -                 → 'down'        dot--down      "云端 SSE: 已断线"
 *   'error'            -                 → 'down'        dot--down      "云端 SSE: 已断线"
 *   'unknown'          null              → 'init'        dot--init      "等待本地 VM Agent 注册"
 *   'unknown'          'not-authenticated'→ 'reconnecting' dot--reconnecting "重连中"
 *
 * ---------------------------------------------------------------------------
 * 现有覆盖 vs 本 spec 的增量:
 * ---------------------------------------------------------------------------
 *   - connection-status-dot-unknown.spec.ts — **只**盯 "server unknown → init"
 *     这一格（初始化状态回归）.
 *   - useSseStatus.spec.ts (Vitest 单测) — 盯 mapper 纯函数, 不跑 IPC.
 *   - 本 spec — 跑 **完整 IPC 回路** (stub cloud → main-process SSE → IPC
 *     push → renderer useSseStatus → DOM data-sse-status), 用同一个 Electron
 *     app 串起 4 段 snapshot 依次切换 server state, 逐格断言 DOM class +
 *     tooltip. 能抓任一段"后处理丢事件"或"useSseStatus 反应慢"的回归.
 *
 *   audit 候选 "unknown-pending" = 那个 state='unknown' + lastError='not-
 *   authenticated' 的 bucket. 我们把它放在第 4 段.
 *
 * ---------------------------------------------------------------------------
 * 实现技巧 — 单 Electron + 可切换 stub state:
 * ---------------------------------------------------------------------------
 *   每个 new stub SSE accept 先读 stub.getScenario() 再根据场景推 snapshot.
 *   stub 对外暴露 setScenario() + broadcastSnapshot() 让 spec 主体直接驱动
 *   "下一帧发什么". 这样不用反复 Kill-Reconnect 或重启 Electron, 一次冷启动
 *   里走完 4 态 ~= 45s.
 *
 *   注意 "unknown + not-authenticated" 这档是 **主进程本地**合成的 —
 *   electron/services/connection-health.ts 在拿不到 auth token 时会自己 emit
 *   `{state:'unknown', last_error:'not-authenticated'}`. 从 SSE 下行看不到.
 *   最可靠的触发办法: 在 app 已经 ready 之后, 让 renderer 把 auth store
 *   token 清空 — 主进程下一轮 401 → emit unknown+not-authenticated.
 *
 * --list 语法检查:
 *   cd desktop && npx playwright test --config=playwright.electron.config.ts \
 *     --list | grep connection-status-dot-states
 */

const DESKTOP_ROOT = path.resolve(__dirname, '..')
const SHOT_DIR = path.join(DESKTOP_ROOT, 'e2e-screenshots', 'connection-status-dot-states')
fs.mkdirSync(SHOT_DIR, { recursive: true })

const FAKE_EMAIL = 'chi-e2e-dot-states@e2e.example.test'
const FAKE_CID = 'e2e-customer-dot-states'
const FAKE_TOKEN = 'e2e-stub-dot-states-token-aaaa'

type Scenario = 'online' | 'degraded' | 'connecting' | 'offline' | 'error' | 'unknown'

interface StubState {
  baseUrl: string
  close: () => Promise<void>
  setScenario: (s: Scenario) => void
  broadcast: () => void
  totalConnects: () => number
}

function buildSnapshot(state: Scenario): Record<string, unknown> {
  return {
    agent_id: state === 'unknown' ? null : 'stub-agent-1',
    state,
    last_heartbeat: state === 'unknown' ? null : new Date().toISOString(),
    last_heartbeat_age_s: state === 'unknown' ? null : 1.0,
    transport: state === 'unknown' ? 'unknown' : 'ws',
    active_tasks: 0,
    version: state === 'unknown' ? '' : 'e2e',
    uptime_s: state === 'unknown' ? null : 10,
    recent_errors: [],
    hostname: state === 'unknown' ? '' : 'stub-host',
  }
}

async function startStubCloud(initial: Scenario): Promise<StubState> {
  const active = new Set<ServerResponse>()
  let scenario: Scenario = initial
  let totalConnects = 0
  return new Promise((resolve, reject) => {
    const server: Server = http.createServer(
      (req: IncomingMessage, res: ServerResponse) => {
        const urlPath = (req.url || '').split('?')[0]
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Headers', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
        if (req.method === 'OPTIONS') { res.writeHead(204).end(); return }

        if (urlPath === '/health/events') {
          totalConnects += 1
          res.setHeader('Content-Type', 'text/event-stream')
          res.setHeader('Cache-Control', 'no-cache')
          res.setHeader('Connection', 'keep-alive')
          res.setHeader('X-Accel-Buffering', 'no')
          res.writeHead(200)
          active.add(res)

          const snap = buildSnapshot(scenario)
          res.write(`data: ${JSON.stringify({ type: 'snapshot', data: snap })}\n\n`)

          const keepalive = setInterval(() => {
            try {
              res.write(`data: ${JSON.stringify({
                type: 'keepalive', ts: Math.floor(Date.now() / 1000),
              })}\n\n`)
            } catch { clearInterval(keepalive) }
          }, 10_000)

          const cleanup = () => { clearInterval(keepalive); active.delete(res) }
          req.on('close', cleanup)
          res.on('close', cleanup)
          return
        }

        let body = ''
        req.on('data', (c) => { body += String(c) })
        req.on('end', () => {
          res.setHeader('Content-Type', 'application/json')
          if (urlPath === '/v1/auth/login' && req.method === 'POST') {
            res.writeHead(200).end(JSON.stringify({ api_key: FAKE_TOKEN, customer_id: FAKE_CID }))
            return
          }
          if (urlPath === '/v1/auth/validate') {
            res.writeHead(200).end(JSON.stringify({ valid: true, customer_id: FAKE_CID, email: FAKE_EMAIL }))
            return
          }
          if (urlPath === '/v1/auth/logout' && req.method === 'POST') {
            res.writeHead(200).end(JSON.stringify({ ok: true }))
            return
          }
          if (urlPath === '/health/snapshot') {
            res.writeHead(200).end(JSON.stringify(buildSnapshot(scenario)))
            return
          }
          res.writeHead(200).end(JSON.stringify({ ok: true, data: [], items: [], messages: [] }))
        })
      },
    )
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo
      const baseUrl = `http://127.0.0.1:${addr.port}`
      console.log(`[stub-cloud] listening on ${baseUrl} (initial scenario=${initial})`)
      const close = () =>
        new Promise<void>((r) => {
          for (const r of active) { try { r.destroy() } catch { /* noop */ } }
          active.clear()
          server.close(() => r())
        })
      resolve({
        baseUrl,
        close,
        totalConnects: () => totalConnects,
        setScenario: (s) => {
          console.log(`[stub-cloud] setScenario: ${scenario} → ${s}`)
          scenario = s
        },
        broadcast: () => {
          const snap = buildSnapshot(scenario)
          const frame = `data: ${JSON.stringify({ type: 'snapshot', data: snap })}\n\n`
          console.log(`[stub-cloud] broadcast snapshot state=${scenario} to ${active.size} client(s)`)
          for (const r of active) {
            try { r.write(frame) } catch { /* noop */ }
          }
        },
      })
    })
  })
}

async function pickMainWindow(app: ElectronApplication, waitMs = 20_000): Promise<Page> {
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

async function shot(win: Page, name: string): Promise<void> {
  try {
    const p = path.join(SHOT_DIR, `${Date.now()}-${name}.png`)
    await win.screenshot({ path: p })
    console.log(`  [screenshot] ${p}`)
  } catch { /* noop */ }
}

test('ConnectionStatusDot 4 态遍历: init / ready / reconnecting / down — class + 中文 tooltip 正确', async () => {
  test.setTimeout(300_000)

  // 开局场景用 'unknown' — 首次 snapshot 就是 init bucket (状态 1).
  const stub = await startStubCloud('unknown')
  const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-dot-states-'))
  console.log(`[setup] userDataDir=${tmpUserData}`)
  console.log(`[setup] stubCloud=${stub.baseUrl}`)

  const cleanEnv: NodeJS.ProcessEnv = { ...process.env }
  delete cleanEnv.ELECTRON_RUN_AS_NODE

  const app: ElectronApplication = await electron.launch({
    args: [DESKTOP_ROOT],
    env: {
      ...cleanEnv,
      AWP_HOSTED_AUTH_OPT_IN: '1',
      AWP_API_BASE: stub.baseUrl,
      AWP_CONNECTION_HEALTH_SSE_URL: `${stub.baseUrl}/health/events`,
      AWP_ALLOW_ANY_PATH: '1',
      AWP_USER_DATA_DIR: tmpUserData,
      AWP_TEST_USER_DATA_DIR_OPT_IN: '1',
    },
    timeout: 45_000,
  })

  try {
    const win = await pickMainWindow(app)
    win.on('pageerror', (err) => console.log(`  [renderer-pageerror] ${err.message}`))
    await win.waitForLoadState('domcontentloaded')
    await shot(win, '01-app-launched')

    await win.addInitScript(
      (args: { cid: string; email: string; stubUrl: string }) => {
        try {
          const { cid, email, stubUrl } = args
          localStorage.setItem('awp_customer_id', cid)
          localStorage.setItem('awp_email', email)
          localStorage.setItem(`awp_onboarding_complete_${cid}`, '1')
          localStorage.setItem(`awp_onboarding_skipped_${cid}`, '1')
          localStorage.setItem('awp_onboarding_complete', '1')
          localStorage.setItem('awp_onboarding_skipped', '1')
          const settingsBlob = JSON.stringify({ serverUrl: stubUrl })
          localStorage.setItem('awp_settings', settingsBlob)
          localStorage.setItem(`awp_settings_${cid}`, settingsBlob)
        } catch { /* ignore */ }
      },
      { cid: FAKE_CID, email: FAKE_EMAIL, stubUrl: stub.baseUrl },
    )

    await win.evaluate(async (args) => {
      const { cid, email, token, stubUrl } = args
      try {
        localStorage.setItem('awp_customer_id', cid)
        localStorage.setItem('awp_email', email)
        localStorage.setItem(`awp_onboarding_complete_${cid}`, '1')
        localStorage.setItem(`awp_onboarding_skipped_${cid}`, '1')
        localStorage.setItem('awp_onboarding_complete', '1')
        localStorage.setItem('awp_onboarding_skipped', '1')
        const settingsBlob = JSON.stringify({ serverUrl: stubUrl })
        localStorage.setItem('awp_settings', settingsBlob)
        localStorage.setItem(`awp_settings_${cid}`, settingsBlob)
      } catch { /* ignore */ }
      try {
        const api = (window as unknown as {
          electronAPI?: { set_credential?: (k: string, v: string) => Promise<{ ok: boolean }> }
        }).electronAPI
        if (api?.set_credential) await api.set_credential('auth_token', token)
      } catch { /* ignore */ }
    }, { cid: FAKE_CID, email: FAKE_EMAIL, token: FAKE_TOKEN, stubUrl: stub.baseUrl })

    await win.reload()
    await win.waitForLoadState('domcontentloaded')

    await win.evaluate(() => { window.location.hash = '#/perf' })
    await win.waitForTimeout(500)

    await win.evaluate(async (args) => {
      const { cid, email, token, stubUrl } = args
      const root = document.querySelector('#app') as HTMLElement | null
      if (!root) return
      const vue = (root as unknown as { __vue_app__?: unknown }).__vue_app__
      if (!vue) return
      const app = vue as { config: { globalProperties: Record<string, unknown> } }
      const pinia = (app.config.globalProperties as Record<string, unknown>).$pinia as {
        state: { value: Record<string, Record<string, unknown>> }
      } | undefined
      if (!pinia) return
      const authState = pinia.state.value['auth'] ?? (pinia.state.value['auth'] = {})
      authState.token = token
      authState.user = { email, customer_id: cid }
      const settingsState = pinia.state.value['settings'] ?? (pinia.state.value['settings'] = {})
      settingsState.serverUrl = stubUrl
      settingsState.loaded = true
    }, { cid: FAKE_CID, email: FAKE_EMAIL, token: FAKE_TOKEN, stubUrl: stub.baseUrl })

    await win.evaluate(() => { window.location.hash = '#/' })
    await win.waitForTimeout(500)
    await shot(win, '02-home-loaded')

    const dot = win.locator('.connection-status-dot').first()
    await expect(dot).toBeVisible({ timeout: 15_000 })

    // ──────────────────────────────────────────────────────────
    // 态 1 — server state='unknown' (fresh session) → UI bucket 'init'
    // ──────────────────────────────────────────────────────────
    await expect
      .poll(async () => dot.getAttribute('data-sse-status'),
        { timeout: 30_000, message: '态1 server=unknown → data-sse-status must be "init"' })
      .toBe('init')
    const innerClass1 = (await dot.locator('.dot').first().getAttribute('class')) ?? ''
    expect(innerClass1, '[1-class] dot--init').toContain('dot--init')
    expect(innerClass1, '[1-class] must NOT be reconnecting').not.toContain('dot--reconnecting')
    const tip1 = (await dot.getAttribute('title')) ?? ''
    expect(tip1, `[1-tip] init 态 tooltip 必须提到"等待本地 VM Agent"或类似, got "${tip1}"`)
      .toMatch(/等待本地.*Agent|VM Agent/)
    expect(tip1, '[1-tip] 不能是 "重连中"').not.toMatch(/重连中/)
    await shot(win, '03-state-1-init')
    console.log(`[assert-态1] init: class ✓ tooltip="${tip1.slice(0, 60)}" ✓`)

    // ──────────────────────────────────────────────────────────
    // 态 2 — server state='online' → UI bucket 'ready'
    // ──────────────────────────────────────────────────────────
    stub.setScenario('online')
    stub.broadcast()
    await expect
      .poll(async () => dot.getAttribute('data-sse-status'),
        { timeout: 30_000, message: '态2 server=online → data-sse-status must be "ready"' })
      .toBe('ready')
    const innerClass2 = (await dot.locator('.dot').first().getAttribute('class')) ?? ''
    expect(innerClass2, '[2-class] dot--ready').toContain('dot--ready')
    const tip2 = (await dot.getAttribute('title')) ?? ''
    expect(tip2, `[2-tip] ready 态 tooltip 必须提 "已连接", got "${tip2}"`)
      .toMatch(/已连接|connected/i)
    await shot(win, '04-state-2-ready')
    console.log(`[assert-态2] ready: class ✓ tooltip="${tip2.slice(0, 60)}" ✓`)

    // ──────────────────────────────────────────────────────────
    // 态 3 — server state='offline' → UI bucket 'down'
    // ──────────────────────────────────────────────────────────
    stub.setScenario('offline')
    stub.broadcast()
    await expect
      .poll(async () => dot.getAttribute('data-sse-status'),
        { timeout: 30_000, message: '态3 server=offline → data-sse-status must be "down"' })
      .toBe('down')
    const innerClass3 = (await dot.locator('.dot').first().getAttribute('class')) ?? ''
    expect(innerClass3, '[3-class] dot--down').toContain('dot--down')
    const tip3 = (await dot.getAttribute('title')) ?? ''
    expect(tip3, `[3-tip] down 态 tooltip 必须提 "已断线", got "${tip3}"`)
      .toMatch(/已断线|断开|disconnected/i)
    await shot(win, '05-state-3-down')
    console.log(`[assert-态3] down: class ✓ tooltip="${tip3.slice(0, 60)}" ✓`)

    // ──────────────────────────────────────────────────────────
    // 态 4 — server state='connecting' → UI bucket 'reconnecting'
    //        (audit 候选里的 "unknown-pending" 覆盖面, connecting 是
    //         server 显式 emit 的 pending 状态, reconnecting bucket 共用)
    // ──────────────────────────────────────────────────────────
    stub.setScenario('connecting')
    stub.broadcast()
    await expect
      .poll(async () => dot.getAttribute('data-sse-status'),
        { timeout: 30_000, message: '态4 server=connecting → data-sse-status must be "reconnecting"' })
      .toBe('reconnecting')
    const innerClass4 = (await dot.locator('.dot').first().getAttribute('class')) ?? ''
    expect(innerClass4, '[4-class] dot--reconnecting').toContain('dot--reconnecting')
    const tip4 = (await dot.getAttribute('title')) ?? ''
    expect(tip4, `[4-tip] reconnecting 态 tooltip 必须提 "重连中", got "${tip4}"`)
      .toMatch(/重连中|reconnecting/i)
    await shot(win, '06-state-4-reconnecting')
    console.log(`[assert-态4] reconnecting: class ✓ tooltip="${tip4.slice(0, 60)}" ✓`)

    console.log(`\n[done] 4 态 dot class + 中文 tooltip 全部 ✓`)
  } finally {
    await app.close()
    await stub.close()
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }) } catch { /* noop */ }
    console.log(`\n所有截图: ${SHOT_DIR}`)
  }
})
