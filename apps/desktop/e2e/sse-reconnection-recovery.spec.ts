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
 * Hermetic Electron regression for the main-process SSE reconnect loop.
 * The localhost fixture accepts /health/events, sends an online snapshot,
 * deliberately drops the socket, and verifies that the real main process
 * reconnects and returns ConnectionStatusDot to ready. No external account,
 * deployment environment, or live endpoint participates in this test.
 */


const DESKTOP_ROOT = path.resolve(__dirname, '..')
const SHOT_DIR = path.join(DESKTOP_ROOT, 'e2e-screenshots', 'sse-reconnection-recovery')
fs.mkdirSync(SHOT_DIR, { recursive: true })

const FAKE_EMAIL = 'chi-e2e-sse-recon@e2e.example.test'
const FAKE_CID = 'e2e-customer-sse-recon'
const FAKE_TOKEN = 'e2e-stub-sse-recon-token-aaaa'

interface StubState {
  baseUrl: string
  close: () => Promise<void>
  totalConnects: () => number
  killAllActive: () => void
}

/**
 * Stub cloud with a killable SSE endpoint on /health/events.
 *
 * totalConnects counts *every* fresh TCP accept for the stream — that's the
 * reconnection signal the spec checks (>= 2 after one kill).
 * killAllActive walks the set of live res objects and res.destroy()s them —
 * simulates an LB YANK.
 */
async function startStubCloud(): Promise<StubState> {
  const active = new Set<ServerResponse>()
  let totalConnects = 0
  return new Promise((resolve, reject) => {
    const server: Server = http.createServer(
      (req: IncomingMessage, res: ServerResponse) => {
        const urlPath = (req.url || '').split('?')[0]
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Headers', '*')
        res.setHeader(
          'Access-Control-Allow-Methods',
          'GET,POST,PUT,DELETE,OPTIONS',
        )
        if (req.method === 'OPTIONS') {
          res.writeHead(204).end()
          return
        }

        if (urlPath === '/health/events') {
          totalConnects += 1
          console.log(`[stub-cloud] SSE accept #${totalConnects}`)
          res.setHeader('Content-Type', 'text/event-stream')
          res.setHeader('Cache-Control', 'no-cache')
          res.setHeader('Connection', 'keep-alive')
          res.setHeader('X-Accel-Buffering', 'no')
          res.writeHead(200)
          active.add(res)

          // Emit a 'online' snapshot immediately so dot settles into ready
          // (not stuck at init / reconnecting). Using the real wire shape —
          // see _snapshot_for_customer in cloud/routes/agent_status.py.
          const snapshot = {
            agent_id: 'stub-agent-1',
            state: 'online',
            last_heartbeat: new Date().toISOString(),
            last_heartbeat_age_s: 1.0,
            transport: 'ws',
            active_tasks: 0,
            version: 'e2e',
            uptime_s: 10,
            recent_errors: [],
            hostname: 'stub-host',
          }
          res.write(
            `data: ${JSON.stringify({ type: 'snapshot', data: snapshot })}\n\n`,
          )

          // Keep-alives so NAT doesn't kill us. 10s cadence.
          const keepalive = setInterval(() => {
            try {
              res.write(
                `data: ${JSON.stringify({
                  type: 'keepalive',
                  ts: Math.floor(Date.now() / 1000),
                })}\n\n`,
              )
            } catch {
              clearInterval(keepalive)
            }
          }, 10_000)

          const cleanup = () => {
            clearInterval(keepalive)
            active.delete(res)
          }
          req.on('close', cleanup)
          res.on('close', cleanup)
          return
        }

        // Drain the body on non-stream routes
        let body = ''
        req.on('data', (chunk) => { body += String(chunk) })
        req.on('end', () => {
          res.setHeader('Content-Type', 'application/json')
          if (urlPath === '/v1/auth/login' && req.method === 'POST') {
            res.writeHead(200).end(
              JSON.stringify({ api_key: FAKE_TOKEN, customer_id: FAKE_CID }),
            )
            return
          }
          if (urlPath === '/v1/auth/validate') {
            res.writeHead(200).end(
              JSON.stringify({ valid: true, customer_id: FAKE_CID, email: FAKE_EMAIL }),
            )
            return
          }
          if (urlPath === '/v1/auth/logout' && req.method === 'POST') {
            res.writeHead(200).end(JSON.stringify({ ok: true }))
            return
          }
          if (urlPath === '/health/snapshot') {
            // REST snapshot parallel to the stream; some front-end code falls
            // back to the REST endpoint if stream hasn't emitted yet.
            res.writeHead(200).end(JSON.stringify({
              agent_id: 'stub-agent-1',
              state: 'online',
              last_heartbeat: new Date().toISOString(),
              last_heartbeat_age_s: 1.0,
              transport: 'ws',
              active_tasks: 0,
              version: 'e2e',
              uptime_s: 10,
              recent_errors: [],
              hostname: 'stub-host',
            }))
            return
          }
          // Default 200 stub for ambient polling — don't let startup error-spam
          res.writeHead(200).end(
            JSON.stringify({ ok: true, data: [], items: [], messages: [] }),
          )
        })
      },
    )
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo
      const baseUrl = `http://127.0.0.1:${addr.port}`
      console.log(`[stub-cloud] listening on ${baseUrl}`)
      const close = () =>
        new Promise<void>((r) => {
          // Destroy any stragglers so server.close() doesn't hang.
          for (const r of active) {
            try { r.destroy() } catch { /* noop */ }
          }
          active.clear()
          server.close(() => r())
        })
      resolve({
        baseUrl,
        close,
        totalConnects: () => totalConnects,
        killAllActive: () => {
          console.log(`[stub-cloud] killAllActive: ${active.size} SSE client(s) about to be yanked`)
          for (const r of active) {
            try {
              r.destroy()
            } catch { /* noop */ }
          }
          active.clear()
        },
      })
    })
  })
}

async function pickMainWindow(
  app: ElectronApplication,
  waitMs = 20_000,
): Promise<Page> {
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
  } catch { /* best-effort */ }
}

test('SSE 断开后主进程自动重连, ConnectionStatusDot 最终回到 ready (不卡 reconnecting)', async () => {
  test.setTimeout(240_000)

  const stub = await startStubCloud()
  const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-sse-recon-'))
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
    win.on('pageerror', (err) =>
      console.log(`  [renderer-pageerror] ${err.message}`),
    )
    await win.waitForLoadState('domcontentloaded')
    await shot(win, '01-app-launched')

    // Install a synthetic hosted-adapter session for this explicit opt-in test.
    // The values are local fixtures and never leave the loopback stub.
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
          electronAPI?: {
            set_credential?: (k: string, v: string) => Promise<{ ok: boolean }>
          }
        }).electronAPI
        if (api?.set_credential) await api.set_credential('auth_token', token)
      } catch { /* ignore */ }
    }, { cid: FAKE_CID, email: FAKE_EMAIL, token: FAKE_TOKEN, stubUrl: stub.baseUrl })

    await win.reload()
    await win.waitForLoadState('domcontentloaded')
    await shot(win, '02-after-inject-reload')

    await win.evaluate(() => { window.location.hash = '#/perf' })
    await win.waitForTimeout(500)

    await win.evaluate(async (args) => {
      const { cid, email, token, stubUrl } = args
      const root = document.querySelector('#app') as HTMLElement | null
      if (!root) return
      const vue = (root as unknown as { __vue_app__?: unknown }).__vue_app__
      if (!vue) return
      const app = vue as {
        config: { globalProperties: Record<string, unknown> }
      }
      const pinia = (
        app.config.globalProperties as Record<string, unknown>
      ).$pinia as {
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
    await shot(win, '03-home-loaded')

    const dot = win.locator('.connection-status-dot').first()
    await expect(dot).toBeVisible({ timeout: 15_000 })
    await shot(win, '04-dot-visible')

    // ══════════════════════════════════════════════════════════
    // 档 A — 首次连接: dot 到达 ready (收到 state='online' snapshot)
    // ══════════════════════════════════════════════════════════
    await expect
      .poll(
        async () => dot.getAttribute('data-sse-status'),
        { timeout: 30_000, message: '首次 SSE snapshot 后 dot 必须 ready' },
      )
      .toBe('ready')
    await shot(win, '05-dot-ready')

    const firstConnects = stub.totalConnects()
    expect(firstConnects, `[A1] stub 必须至少见到 1 次 SSE accept, got ${firstConnects}`).toBeGreaterThanOrEqual(1)
    console.log(`[assert-A] dot=ready after ${firstConnects} accept(s) ✓`)

    // ══════════════════════════════════════════════════════════
    // 档 B — 断掉活跃 SSE, 主进程必须自动重连
    // ══════════════════════════════════════════════════════════
    console.log('[act-B] 杀掉所有活跃 SSE 连接...')
    stub.killAllActive()
    await shot(win, '06-after-kill')

    // Poll until stub sees a NEW accept count (reconnection happened).
    await expect
      .poll(
        async () => stub.totalConnects(),
        {
          timeout: 60_000,
          intervals: [1_000, 2_000, 3_000],
          message: '断后 60s 内主进程必须发起新的 SSE 连接',
        },
      )
      .toBeGreaterThan(firstConnects)
    const secondConnects = stub.totalConnects()
    console.log(`[assert-B1] 重连发生: accept 总数 ${firstConnects} → ${secondConnects} ✓`)

    // ══════════════════════════════════════════════════════════
    // 档 C — 重连完成后 dot 最终 回到 ready, 不能卡在 reconnecting
    // ══════════════════════════════════════════════════════════
    await expect
      .poll(
        async () => dot.getAttribute('data-sse-status'),
        {
          timeout: 60_000,
          intervals: [1_000, 2_000, 3_000],
          message: '重连成功后 dot 必须最终回到 ready, 不能卡 reconnecting',
        },
      )
      .toBe('ready')
    await shot(win, '07-dot-ready-after-reconnect')

    // D — inner dot class 必须是 dot--ready, 不是 dot--reconnecting
    const innerClass =
      (await dot.locator('.dot').first().getAttribute('class')) ?? ''
    expect(innerClass, `[D1] inner class should be dot--ready, got "${innerClass}"`).toContain('dot--ready')
    expect(innerClass, `[D2] inner class must NOT still be dot--reconnecting`).not.toContain('dot--reconnecting')
    console.log(`[assert-CD] 重连后 dot=ready, class="${innerClass}" ✓`)

    await shot(win, '08-final')
    console.log(`\n[done] SSE recovery: accepts total=${stub.totalConnects()}, dot final=ready ✓`)
  } finally {
    await app.close()
    await stub.close()
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }) } catch { /* noop */ }
    console.log(`\n所有截图: ${SHOT_DIR}`)
  }
})
