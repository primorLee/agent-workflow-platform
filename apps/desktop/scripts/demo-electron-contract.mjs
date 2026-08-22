import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { startDemoControlPlane } from './demo-control-plane.mjs'

const root = resolve(import.meta.dirname, '..')
const launcher = resolve(root, 'scripts', 'demo-electron.mjs')
const child = spawnSync(process.execPath, [launcher, '--smoke'], {
  cwd: root,
  encoding: 'utf8',
  timeout: 20_000,
})
assert.equal(child.status, 0, child.stderr)
assert.match(child.stdout, /local chat\/SSE adapter ready at http:\/\/127\.0\.0\.1:8787/)
assert.match(child.stdout, /launcher smoke complete/)

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'awp-electron-launcher-contract-'))
let rebound
try {
  rebound = await startDemoControlPlane({
    host: '127.0.0.1',
    port: 8787,
    stateFile: join(temporaryDirectory, 'sessions.json'),
  })
  assert.equal(rebound.port, 8787, 'launcher must release its fixed demo port on exit')
} finally {
  if (rebound) await rebound.close()
  await rm(temporaryDirectory, { recursive: true, force: true })
}

process.stdout.write('[demo-electron-contract] fixed-port readiness and shutdown cleanup passed\n')
