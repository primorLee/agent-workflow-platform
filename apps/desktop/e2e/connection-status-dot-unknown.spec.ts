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
 * connection-status-dot-unknown.spec.ts — regression for an initialization
 * state that was previously rendered as a permanent reconnect.
 *
 * Scenario under test
 * ===================
 *   A newly created session has no worker row registered yet.
 *   The event stream is otherwise healthy.
 *   The cloud route `GET /health/events` emits a snapshot with
 *   `state='unknown'` is emitted while the worker row is absent.
 *
 *
 *   Before the fix: ConnectionStatusDot.vue rendered `data-sse-status="reconnecting"`
 *   permanently — amber pulsing dot, tooltip "重连中". Looked like the
 *   cloud SSE was broken, but the channel was actually delivering snapshots
 *   fine; the UI was just misrepresenting "no agent yet" as "reconnecting".
 *
 *   After the fix: useSseStatus.mapServerStateToUi distinguishes server-
 *   emitted `unknown` (agent missing) from main-process `unknown` with auth
 *   last_error. Server-unknown → `init` bucket, white dot, tooltip
 *   "等待本地 VM Agent 注册". That matches the real state.
 *
 * Test strategy
 * =============
 *   Re-use the stub-cloud pattern established in
 *   `connection-health-indicator.spec.ts`:
 *   - spawn a local http server on a random port
 *   - respond 200 to /v1/auth/login / validate / logout
 *   - expose /health/events as a real SSE endpoint emitting
 *     `{"type":"snapshot","data":{"state":"unknown", ...}}` frames so the
 *     main-process SSE consumer sees the exact adapter wire payload
 *   - Electron app is launched with AWP_API_BASE pointing to the stub
 *   - Pinia auth store is injected directly (same trick as the sibling spec,
 *     documented there - avoids unrelated login throttling)
 *   - wait up to 30s, then assert `data-sse-status="init"` and the tooltip
 *     contains the new "等待本地 VM Agent 注册" string, NOT "重连中"
 *
 *   The spec is specifically NOT a unit test on the mapper — the mapper
 *   already has `useSseStatus.spec.ts` covering its branches. This spec
 *   exercises the full IPC pipeline:
 *       stub cloud SSE  →  main-process connection-health service
 *                            →  on_connection_health IPC push
 *                            →  renderer useSseStatus snapshot ref
 *                            →  ConnectionStatusDot.vue class binding
 */

const DESKTOP_ROOT = path.resolve(__dirname, '..')
const SHOT_DIR = path.join(
  DESKTOP_ROOT,
  'e2e-screenshots',
  'connection-status-dot-unknown',
)
fs.mkdirSync(SHOT_DIR, { recursive: true })

const FAKE_EMAIL = 'chi-e2e-dot@e2e.example.test'
const FAKE_PASS = 'chi-e2e-pw-not-used'
const FAKE_CID = 'e2e-customer-dot'
const FAKE_TOKEN = 'e2e-stub-dot-token-aaaaaaaa'

/**
 * Stub cloud that speaks SSE on /health/events.
 *
 * The main-process SSE consumer expects frames in the shape
 *   data: {"type":"snapshot","data":{ state, agent_id, ... }}\n\n
 * (see electron/services/connection-health.ts::_parseSseFrame + the
 * mirroring contract on cloud/routes/agent_status.py).
 *
 * We keep the stream open (no res.end) and push a single frame immediately,
 * then one keepalive every 15s. That replicates the real cloud route but
 * never transitions to `online` — making the "no registered worker" scenario
 * deterministic.
 */
async function startStubCloud(): Promise<{
  baseUrl: string
  close: () => Promise<void>
  sseClients: number
}> {
  const state = { sseClients: 0 }
  return new Promise((resolve, reject) => {
    const server: Server = http.createServer(
      (req: IncomingMessage, res: ServerResponse) => {
        const urlPath = (req.url || '').split('?')[0]

        // CORS for Electron renderer fetches
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
          state.sseClients += 1
          console.log(
            `[stub-cloud] SSE client connected (${state.sseClients} total)`,
          )
          res.setHeader('Content-Type', 'text/event-stream')
          res.setHeader('Cache-Control', 'no-cache')
          res.setHeader('Connection', 'keep-alive')
          res.setHeader('X-Accel-Buffering', 'no')
          res.writeHead(200)

          // Send the "no agent registered" snapshot immediately. This is the
          // representative payload returned when the workers
          // table has no row for the session — the regression trigger.
          const snapshot = {
            agent_id: null,
            state: 'unknown',
            last_heartbeat: null,
            last_heartbeat_age_s: null,
            transport: 'unknown',
            active_tasks: 0,
            version: '',
            uptime_s: null,
            recent_errors: [],
            hostname: '',
          }
          res.write(
            `data: ${JSON.stringify({ type: 'snapshot', data: snapshot })}\n\n`,
          )

          // Keepalive so NAT / parsers are happy; use a shorter cadence than
          // the runtime's 30s default so the test does not rely on it.
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

          req.on('close', () => {
            clearInterval(keepalive)
            state.sseClients = Math.max(0, state.sseClients - 1)
          })
          return
        }

        // Swallow body on non-SSE routes
        let body = ''
        req.on('data', (chunk) => {
          body += String(chunk)
        })
        req.on('end', () => {
          res.setHeader('Content-Type', 'application/json')
          if (urlPath === '/v1/auth/login' && req.method === 'POST') {
            res
              .writeHead(200)
              .end(
                JSON.stringify({ api_key: FAKE_TOKEN, customer_id: FAKE_CID }),
              )
            return
          }
          if (urlPath === '/v1/auth/validate') {
            res
              .writeHead(200)
              .end(
                JSON.stringify({
                  valid: true,
                  customer_id: FAKE_CID,
                  email: FAKE_EMAIL,
                }),
              )
            return
          }
          if (urlPath === '/v1/auth/logout' && req.method === 'POST') {
            res.writeHead(200).end(JSON.stringify({ ok: true }))
            return
          }
          if (urlPath === '/health/snapshot') {
            res
              .writeHead(200)
              .end(
                JSON.stringify({
                  agent_id: null,
                  state: 'unknown',
                  last_heartbeat: null,
                  last_heartbeat_age_s: null,
                  transport: 'unknown',
                  active_tasks: 0,
                  version: '',
                  uptime_s: null,
                  recent_errors: [],
                  hostname: '',
                }),
              )
            return
          }
          // Default 200 stub for miscellaneous polling (notifications, chat
          // history, model list, etc) so startup doesn't error-spam.
          res
            .writeHead(200)
            .end(
              JSON.stringify({
                ok: true,
                data: [],
                items: [],
                messages: [],
              }),
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
        new Promise<void>((r) => server.close(() => r()))
      resolve({ baseUrl, close, sseClients: state.sseClients })
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
  } catch {
    /* best-effort */
  }
}

test('ConnectionStatusDot: server unknown state renders as init, not reconnecting', async () => {
  test.setTimeout(180_000)

  const stub = await startStubCloud()
  const tmpUserData = fs.mkdtempSync(
    path.join(os.tmpdir(), 'awp-dot-'),
  )
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

    // Same bootstrap trick as connection-health-indicator.spec.ts — see
    // that file's comments for why we inject localStorage + pinia state
    // rather than going through the real login form.
    await win.addInitScript(
      (args: { cid: string; email: string; stubUrl: string }) => {
        try {
          const { cid, email, stubUrl } = args
          localStorage.setItem('awp_customer_id', cid)
          localStorage.setItem('awp_email', email)
          localStorage.setItem(
            `awp_onboarding_complete_${cid}`,
            '1',
          )
          localStorage.setItem(
            `awp_onboarding_skipped_${cid}`,
            '1',
          )
          localStorage.setItem('awp_onboarding_complete', '1')
          localStorage.setItem('awp_onboarding_skipped', '1')
          const settingsBlob = JSON.stringify({ serverUrl: stubUrl })
          localStorage.setItem('awp_settings', settingsBlob)
          localStorage.setItem(`awp_settings_${cid}`, settingsBlob)
        } catch {
          /* ignore */
        }
      },
      { cid: FAKE_CID, email: FAKE_EMAIL, stubUrl: stub.baseUrl },
    )

    await win.evaluate(
      async (args) => {
        const { cid, email, token, stubUrl } = args
        try {
          localStorage.setItem('awp_customer_id', cid)
          localStorage.setItem('awp_email', email)
          localStorage.setItem(
            `awp_onboarding_complete_${cid}`,
            '1',
          )
          localStorage.setItem(
            `awp_onboarding_skipped_${cid}`,
            '1',
          )
          localStorage.setItem('awp_onboarding_complete', '1')
          localStorage.setItem('awp_onboarding_skipped', '1')
          const settingsBlob = JSON.stringify({ serverUrl: stubUrl })
          localStorage.setItem('awp_settings', settingsBlob)
          localStorage.setItem(`awp_settings_${cid}`, settingsBlob)
        } catch {
          /* ignore */
        }
        try {
          const api = (
            window as unknown as {
              electronAPI?: {
                set_credential?: (
                  k: string,
                  v: string,
                ) => Promise<{ ok: boolean }>
              }
            }
          ).electronAPI
          if (api?.set_credential)
            await api.set_credential('auth_token', token)
        } catch {
          /* ignore */
        }
      },
      {
        cid: FAKE_CID,
        email: FAKE_EMAIL,
        token: FAKE_TOKEN,
        stubUrl: stub.baseUrl,
      },
    )

    await win.reload()
    await win.waitForLoadState('domcontentloaded')
    await shot(win, '02-after-inject-reload')

    await win.evaluate(() => {
      window.location.hash = '#/perf'
    })
    await win.waitForTimeout(500)

    const authInjected = await win.evaluate(
      async (args) => {
        const { cid, email, token, stubUrl } = args
        try {
          const root = document.querySelector('#app') as HTMLElement | null
          if (!root) return { ok: false, reason: 'no #app' }
          const vue = (root as unknown as { __vue_app__?: unknown })
            .__vue_app__
          if (!vue) return { ok: false, reason: 'no __vue_app__' }
          const app = vue as {
            config: {
              globalProperties: Record<string, unknown>
            }
          }
          const pinia = (
            app.config.globalProperties as Record<string, unknown>
          ).$pinia as
            | {
                state: {
                  value: Record<string, Record<string, unknown>>
                }
              }
            | undefined
          if (!pinia) return { ok: false, reason: 'no $pinia' }
          const authState =
            pinia.state.value['auth'] ??
            (pinia.state.value['auth'] = {})
          authState.token = token
          authState.user = { email, customer_id: cid }
          const settingsState =
            pinia.state.value['settings'] ??
            (pinia.state.value['settings'] = {})
          settingsState.serverUrl = stubUrl
          settingsState.loaded = true
          return { ok: true, reason: 'injected' }
        } catch (e) {
          return { ok: false, reason: (e as Error).message }
        }
      },
      {
        cid: FAKE_CID,
        email: FAKE_EMAIL,
        token: FAKE_TOKEN,
        stubUrl: stub.baseUrl,
      },
    )
    console.log(`[auth-inject] ${JSON.stringify(authInjected)}`)

    // Navigate anywhere that mounts the titlebar (any post-login view) so
    // ConnectionStatusDot is rendered.
    await win.evaluate(() => {
      window.location.hash = '#/'
    })
    await win.waitForTimeout(500)
    await shot(win, '03-home-after-login')

    const dot = win.locator('.connection-status-dot').first()
    await expect(dot).toBeVisible({ timeout: 15_000 })
    await shot(win, '04-dot-visible')

    // Wait up to 30s for the main-process SSE loop to connect to the stub,
    // read the `state=unknown` snapshot, and push it to the renderer. The
    // data attribute is set by ConnectionStatusDot.vue:data-sse-status.
    await expect
      .poll(
        async () => dot.getAttribute('data-sse-status'),
        {
          timeout: 30_000,
          message:
            'dot must NOT be stuck at "reconnecting" when server reports state=unknown',
        },
      )
      .toBe('init')

    // Tooltip must explain WHY it's white — not lie about reconnecting.
    const tooltip = (await dot.getAttribute('title')) ?? ''
    const ariaLabel = (await dot.getAttribute('aria-label')) ?? ''
    console.log(`[assert] title="${tooltip}"`)
    console.log(`[assert] aria-label="${ariaLabel}"`)
    expect(tooltip).toMatch(/等待本地.*Agent|VM Agent|已连接/)
    // The old buggy tooltip said "重连中". It must be gone from the new
    // init-bucket rendering.
    expect(tooltip).not.toMatch(/重连中/)

    // And the inner `.dot` must have class `dot--init`, not `dot--reconnecting`.
    const innerClass =
      (await dot.locator('.dot').first().getAttribute('class')) ?? ''
    expect(innerClass).toContain('dot--init')
    expect(innerClass).not.toContain('dot--reconnecting')

    await shot(win, '05-dot-init-verified')
  } finally {
    await app.close()
    await stub.close()
    try {
      fs.rmSync(tmpUserData, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
    console.log(`\n所有截图: ${SHOT_DIR}`)
  }
})
