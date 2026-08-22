import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDemoControlPlane } from './demo-control-plane.mjs'

const require = createRequire(import.meta.url)
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEMO_URL = 'http://127.0.0.1:8787'
const DATA_ROOT = resolve(APP_ROOT, '.demo-data')
const STATE_FILE = resolve(DATA_ROOT, 'sessions.json')
const USER_DATA_DIR = resolve(DATA_ROOT, 'electron-user-data')
const smokeOnly = process.argv.includes('--smoke')
const buildOnly = process.argv.includes('--build-only')

let activeChild
let runtime
let stopping = false

function terminateChild(child) {
  if (child && child.exitCode === null && !child.killed) {
    child.kill('SIGTERM')
  }
}

async function shutdown() {
  if (stopping) return
  stopping = true
  terminateChild(activeChild)
  if (runtime) {
    const closing = runtime.close()
    runtime.server.closeAllConnections?.()
    await closing.catch(() => {})
    runtime = undefined
  }
}

async function waitUntilReady(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 750)
    try {
      const response = await fetch(`${url}/health`, { signal: controller.signal })
      if (response.ok) {
        const body = await response.json()
        if (body?.status === 'ok') return
      }
    } catch (error) {
      lastError = error
    } finally {
      clearTimeout(timer)
    }
    await new Promise((done) => setTimeout(done, 150))
  }
  throw new Error(`local demo did not become ready: ${lastError instanceof Error ? lastError.message : 'timeout'}`)
}

function waitForChild(child, label) {
  return new Promise((resolveWait, rejectWait) => {
    child.once('error', rejectWait)
    child.once('exit', (code, signal) => {
      if (signal) rejectWait(new Error(`${label} exited after signal ${signal}`))
      else if (code === 0) resolveWait()
      else rejectWait(new Error(`${label} exited with code ${code ?? 'unknown'}`))
    })
  })
}

async function runBuild(env) {
  const npmExecPath = process.env.npm_execpath
  const command = npmExecPath
    ? process.execPath
    : (process.platform === 'win32' ? 'npm.cmd' : 'npm')
  const args = npmExecPath
    ? [npmExecPath, 'run', 'build:desktop-artifacts']
    : ['run', 'build:desktop-artifacts']
  const child = spawn(command, args, {
    cwd: APP_ROOT,
    env,
    stdio: 'inherit',
    windowsHide: true,
    shell: !npmExecPath && process.platform === 'win32',
  })
  activeChild = child
  await waitForChild(child, 'desktop build')
  activeChild = undefined
}

async function launchElectron(env) {
  let electronPath
  try {
    electronPath = require('electron')
  } catch (error) {
    throw new Error(`Electron runtime is unavailable; run npm ci first: ${error instanceof Error ? error.message : String(error)}`)
  }

  const electronEnv = { ...env }
  delete electronEnv.ELECTRON_RUN_AS_NODE
  const child = spawn(electronPath, ['.'], {
    cwd: APP_ROOT,
    env: electronEnv,
    stdio: 'inherit',
    windowsHide: false,
  })
  activeChild = child
  await waitForChild(child, 'Electron')
  activeChild = undefined
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void shutdown().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143))
  })
}
process.once('exit', () => terminateChild(activeChild))

try {
  await mkdir(DATA_ROOT, { recursive: true })
  runtime = await startDemoControlPlane({
    host: '127.0.0.1',
    port: 8787,
    stateFile: STATE_FILE,
  })
  await waitUntilReady(runtime.url)

  const localEnv = {
    ...process.env,
    AWP_DEV: '1',
    AWP_ENV: 'local',
    AWP_HOSTED_AUTH_OPT_IN: '0',
    AWP_DEMO_TOKEN: runtime.token,
    AWP_DEMO_ORIGIN: runtime.url,
    AWP_API_BASE: DEMO_URL,
    AWP_API_URL: DEMO_URL,
    AWP_USER_DATA_DIR: USER_DATA_DIR,
    AWP_TEST_USER_DATA_DIR_OPT_IN: '1',
    VITE_AWP_CHAT_ADAPTER_URL: DEMO_URL,
    AWP_UPDATE_URL: '',
    AWP_UPDATE_INSIDERS_URL: '',
  }
  delete localEnv.NODE_ENV

  process.stdout.write(`[demo:electron] local chat/SSE adapter ready at ${runtime.url}\n`)
  process.stdout.write(`[demo:electron] durable demo state: ${STATE_FILE}\n`)
  if (smokeOnly) {
    process.stdout.write('[demo:electron] launcher smoke complete; build and GUI intentionally skipped\n')
  } else {
    process.stdout.write('[demo:electron] rebuilding from clean output directories...\n')
    await runBuild(localEnv)
    if (buildOnly) {
      process.stdout.write('[demo:electron] build-only check complete; GUI intentionally skipped\n')
    } else {
      process.stdout.write('[demo:electron] launching Electron in explicit local mode (no hosted account required)\n')
      await launchElectron(localEnv)
    }
  }
} catch (error) {
  if (error?.code === 'EADDRINUSE') {
    throw new Error('127.0.0.1:8787 is already in use; stop the other process before running demo:electron')
  }
  throw error
} finally {
  await shutdown()
}
