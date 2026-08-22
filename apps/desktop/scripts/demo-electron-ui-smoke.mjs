import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'
import { isDemoRouteImplemented, startDemoControlPlane } from './demo-control-plane.mjs'

const appRoot = resolve(import.meta.dirname, '..')
const screenshotRequested = process.argv.includes('--screenshot')
const screenshotPath = resolve(appRoot, 'docs', 'desktop-demo.png')
const DEFAULT_DISABLED_AUTH_ROUTES = new Set([
  '/v1/auth/login',
  '/v1/auth/register',
  '/v1/auth/validate',
  '/v1/auth/logout',
])
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'awp-electron-ui-smoke-'))
let runtime
let application
let networkGateActive = true
let testCompleted = false

async function settlesWithin(promise, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function closeElectronApplication(electronApplication) {
  const child = electronApplication.process()
  const closedGracefully = await settlesWithin(electronApplication.close(), 5_000)
  if (closedGracefully || !child || child.exitCode !== null) return

  process.stderr.write('[electron-ui-smoke] graceful close timed out; terminating the owned Electron process tree\n')
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
  }
  if (child.exitCode === null) child.kill('SIGKILL')
  if (child.exitCode === null) {
    await settlesWithin(new Promise((resolveExit) => child.once('exit', resolveExit)), 5_000)
  }
}

function httpTarget(rawUrl) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const hostname = url.hostname.toLowerCase()
  return {
    url,
    loopback: hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]',
  }
}

function addResponseObservation(response, runtimeUrl, observed, violations) {
  const request = response.request()
  const target = httpTarget(request.url())
  if (!target) return
  const route = `${request.method()} ${target.url.pathname}${target.url.search}`
  observed.add(`${route} -> ${response.status()}`)
  if (!target.loopback) {
    violations.add(`non-loopback renderer request: ${route} (${target.url.origin})`)
    return
  }
  if (target.url.origin !== runtimeUrl) {
    violations.add(`unexpected loopback origin: ${route} (${target.url.origin}, expected ${runtimeUrl})`)
  }
  if (DEFAULT_DISABLED_AUTH_ROUTES.has(target.url.pathname)) {
    violations.add(`hosted-auth route used while opt-in is disabled: ${route}`)
  }
  if (!isDemoRouteImplemented(request.method(), target.url.pathname)) {
    violations.add(`undeclared demo route: ${route}`)
  }
  if (target.url.origin === runtimeUrl && target.url.pathname !== '/health') {
    const headers = request.headers()
    if (!Object.hasOwn(headers, 'x-awp-demo-token')) {
      violations.add(`protected demo route missing capability header: ${route}`)
    }
  }
  if (response.status() >= 400) {
    violations.add(`HTTP ${response.status()}: ${route}`)
  }
}

function addFailureObservation(request, runtimeUrl, observed, violations) {
  const target = httpTarget(request.url())
  if (!target) return
  const failure = request.failure()?.errorText || 'unknown request failure'
  const route = `${request.method()} ${target.url.pathname}${target.url.search}`
  observed.add(`${route} -> FAILED ${failure}`)
  if (!target.loopback) {
    violations.add(`non-loopback renderer request failed: ${route} (${target.url.origin}; ${failure})`)
    return
  }
  if (target.url.origin !== runtimeUrl) {
    violations.add(`unexpected loopback origin failed: ${route} (${target.url.origin}; ${failure})`)
  }
  if (DEFAULT_DISABLED_AUTH_ROUTES.has(target.url.pathname)) {
    violations.add(`hosted-auth route failed while opt-in is disabled: ${route} (${failure})`)
  }
  if (!isDemoRouteImplemented(request.method(), target.url.pathname)) {
    violations.add(`undeclared demo route failed: ${route} (${failure})`)
  }
  if (!/ERR_ABORTED|NS_BINDING_ABORTED/iu.test(failure)) {
    violations.add(`loopback request failed: ${route} (${failure})`)
  }
}

async function waitForHash(window, hash, selector) {
  await window.waitForFunction((expectedHash) => location.hash === expectedHash, hash)
  await window.locator(selector).waitFor({ state: 'visible', timeout: 30_000 })
}

try {
  runtime = await startDemoControlPlane({
    host: '127.0.0.1',
    port: 8787,
    stateFile: join(temporaryDirectory, 'sessions.json'),
  })

  const electronUserData = join(temporaryDirectory, 'electron-user-data')
  await mkdir(electronUserData, { recursive: true })
  await writeFile(join(electronUserData, 'settings.json'), `${JSON.stringify({
    serverUrl: runtime.url,
    theme: 'light',
    language: 'en',
    remote: { vmHost: '127.0.0.1', sshPort: 2222, sshUser: '' },
  }, null, 2)}\n`, 'utf8')
  const env = {
    ...process.env,
    AWP_DEV: '1',
    AWP_ENV: 'local',
    AWP_HOSTED_AUTH_OPT_IN: '0',
    AWP_DEMO_TOKEN: runtime.token,
    AWP_DEMO_ORIGIN: runtime.url,
    AWP_API_BASE: runtime.url,
    AWP_API_URL: runtime.url,
    AWP_USER_DATA_DIR: electronUserData,
    AWP_TEST_USER_DATA_DIR_OPT_IN: '1',
    VITE_AWP_CHAT_ADAPTER_URL: runtime.url,
    AWP_UPDATE_URL: '',
    AWP_UPDATE_INSIDERS_URL: '',
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_ENV

  application = await electron.launch({
    args: ['.'],
    cwd: appRoot,
    env,
    timeout: 30_000,
  })
  const observedNetwork = new Set()
  const networkViolations = new Set()
  const context = application.context()
  context.on('response', (response) => {
    if (networkGateActive) addResponseObservation(response, runtime.url, observedNetwork, networkViolations)
  })
  context.on('requestfailed', (request) => {
    if (networkGateActive) addFailureObservation(request, runtime.url, observedNetwork, networkViolations)
  })

  const window = await application.firstWindow({ timeout: 30_000 })
  await window.waitForLoadState('domcontentloaded')
  await window.evaluate(() => {
    const fixtureNow = new Date().toISOString()
    localStorage.setItem('awp_sidebar_collapsed', '0')
    localStorage.setItem('awp_settings', JSON.stringify({
      language: 'en',
      theme: 'light',
      serverUrl: 'http://127.0.0.1:8787',
    }))
    localStorage.setItem('awp_threads', JSON.stringify([{
      id: 'thread-1',
      conversationId: 'demo-conversation',
      title: 'New Conversation',
      messages: [],
      model: '',
      created_at: fixtureNow,
      updated_at: fixtureNow,
    }]))
  })
  await window.reload({ waitUntil: 'domcontentloaded' })
  await window.setViewportSize({ width: 1440, height: 900 })
  await window.locator('#app').waitFor({ state: 'visible', timeout: 30_000 })
  await waitForHash(window, '#/', '.chat-main')
  await window.waitForFunction(() => (document.body.innerText || '').trim().length > 20)
  await window.addStyleTag({
    content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}',
  })

  // Covers immediate local health calls and the delayed maintenance poll.
  await window.waitForTimeout(2_750)

  const settingsButton = window.locator('button.tool-item.footer-item').filter({ hasText: /Settings|设置/u })
  await settingsButton.waitFor({ state: 'visible' })
  await settingsButton.click()
  await waitForHash(window, '#/settings', '.settings-page')
  const connectionButton = window.getByRole('button', { name: /^(Test connection|测试连接)$/u })
  await connectionButton.click()
  const connectionStatus = window.locator('.settings-page .status.ok')
  await connectionStatus.waitFor({ state: 'visible', timeout: 10_000 })
  assert.match(await connectionStatus.innerText(), /^Connected(?:\s|·|$)/)
  await window.waitForTimeout(500)

  await window.evaluate(() => { location.hash = '#/about' })
  await waitForHash(window, '#/about', '.about-page')
  await window.waitForFunction(() => document.body.innerText.includes('Local-first public preview'))
  await window.waitForTimeout(500)

  // Return from About to the deterministic persisted chat for the public screenshot.
  const persistedThread = window.locator('.thread-item').first()
  await persistedThread.click()
  await waitForHash(window, '#/', '.chat-main')
  await window.locator('textarea.chat-input').waitFor({ state: 'visible' })
  await window.waitForTimeout(500)
  if (screenshotRequested) {
    await window.screenshot({ path: screenshotPath, type: 'png', animations: 'disabled' })
    process.stdout.write(`[electron-ui-smoke] screenshot=${screenshotPath}\n`)
  }

  // New Thread must create and select a distinct durable thread.
  const serializedThreadsBefore = await window.evaluate(() => localStorage.getItem('awp_threads'))
  assert.ok(serializedThreadsBefore, 'deterministic thread fixture must be persisted')
  const threadsBefore = JSON.parse(serializedThreadsBefore)
  assert.ok(Array.isArray(threadsBefore) && threadsBefore.length === 1)
  await window.locator('button.new-thread-btn').click()
  await waitForHash(window, '#/', '.chat-main')
  await window.waitForFunction(
    (expected) => document.querySelectorAll('.thread-item').length === expected,
    threadsBefore.length + 1,
  )
  const threadsAfter = JSON.parse(await window.evaluate(() => localStorage.getItem('awp_threads')) || 'null')
  assert.ok(Array.isArray(threadsAfter))
  assert.equal(threadsAfter.length, threadsBefore.length + 1)
  assert.notEqual(threadsAfter[0].id, threadsBefore[0].id, 'New Thread must create a distinct identity')
  const renderedThreads = window.locator('.thread-item')
  assert.match(await renderedThreads.first().getAttribute('class') || '', /\bactive\b/)
  assert.doesNotMatch(await renderedThreads.nth(1).getAttribute('class') || '', /\bactive\b/)
  const pageState = await window.evaluate(async () => {
    const response = await fetch('http://127.0.0.1:8787/health')
    return {
      url: location.href,
      hash: location.hash,
      title: document.title,
      bodyLength: (document.body.innerText || '').trim().length,
      healthStatus: response.status,
      healthBody: await response.json(),
      hostedAuthEnabled: window.__AWP_HOSTED_AUTH_ENABLED,
      loginSurfaceCount: document.querySelectorAll('.login-view,.login-page,[data-testid*="login"],form[action*="login"]').length,
    }
  })
  await window.waitForTimeout(250)

  assert.match(pageState.url, /^file:/)
  assert.equal(pageState.hash, '#/')
  assert.doesNotMatch(pageState.hash, /login/i, 'explicit local build must bypass hosted login')
  assert.ok(pageState.bodyLength > 20)
  assert.equal(pageState.healthStatus, 200)
  assert.deepEqual(pageState.healthBody, { status: 'ok', version: 'demo' })
  assert.equal(pageState.hostedAuthEnabled, false, 'default demo must expose hosted auth as disabled')
  assert.equal(pageState.loginSurfaceCount, 0, 'default demo must render no Login surface')
  const observedHostedAuth = [...observedNetwork].filter((entry) =>
    [...DEFAULT_DISABLED_AUTH_ROUTES].some((path) => entry.startsWith(`GET ${path} `) || entry.startsWith(`POST ${path} `)),
  )
  assert.deepEqual(observedHostedAuth, [], 'default demo must make no hosted-auth requests')
  assert.equal(
    networkViolations.size,
    0,
    `renderer network contract violations:\n${[...networkViolations].sort().join('\n')}\nobserved:\n${[...observedNetwork].sort().join('\n')}`,
  )

  process.stdout.write(`[electron-ui-smoke] loaded ${pageState.title || 'desktop window'} with hosted-auth=false and no Login surface; Chat/Settings/About, connection, and New Thread actions passed\n`)
  process.stdout.write(`[electron-ui-smoke] declared loopback routes observed: ${[...observedNetwork].sort().join(', ')}\n`)
  networkGateActive = false
  testCompleted = true
} finally {
  networkGateActive = false
  if (application) await closeElectronApplication(application)
  if (runtime) {
    const closing = runtime.close()
    runtime.server.closeAllConnections?.()
    await closing.catch(() => {})
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  try {
    await rm(temporaryDirectory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    })
  } catch (error) {
    if (testCompleted) throw error
    process.stderr.write(`[electron-ui-smoke] cleanup warning after test failure: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}