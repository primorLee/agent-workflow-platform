import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startDemoControlPlane } from './demo-control-plane.mjs'

const root = resolve(import.meta.dirname, '..')
const agentLauncher = resolve(root, 'scripts', 'agent-electron.mjs')
const referenceLauncher = resolve(root, 'scripts', 'openai-compatible-electron.mjs')
const referenceAdapter = resolve(root, '../../examples/openai-compatible-agent-cli/awp-agent-cli.mjs')

function cleanAgentEnvironment(extra = {}) {
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (
      key.startsWith('AWP_AGENT_')
      || key.startsWith('AWP_REFERENCE_')
      || key.startsWith('AWP_CONTROL_PLANE_')
    ) delete environment[key]
  }
  return { ...environment, ...extra }
}

function run(launcher, environment) {
  return spawnSync(process.execPath, [launcher, '--smoke'], {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    timeout: 20_000,
  })
}

const missingCli = run(agentLauncher, cleanAgentEnvironment({
  AWP_AGENT_DEFAULT_MODEL: 'fixture-model',
}))
assert.notEqual(missingCli.status, 0)
assert.match(missingCli.stderr, /AWP_AGENT_CLI_EXECUTABLE must be an absolute path/u)
assert.doesNotMatch(missingCli.stdout, /local chat\/SSE adapter ready/u)

const remoteWithoutOptIn = run(referenceLauncher, cleanAgentEnvironment({
  AWP_AGENT_API_BASE_URL: 'https://provider.example/v1',
  AWP_AGENT_API_TOKEN: 'fixture-token-must-not-print',
  AWP_AGENT_MODEL: 'fixture-model',
}))
assert.notEqual(remoteWithoutOptIn.status, 0)
assert.match(remoteWithoutOptIn.stderr, /requires AWP_AGENT_REMOTE_API_OPT_IN=1/u)
assert.doesNotMatch(
  `${remoteWithoutOptIn.stdout}\n${remoteWithoutOptIn.stderr}`,
  /fixture-token-must-not-print/u,
)

const managedSettingsWithoutOptIn = run(referenceLauncher, cleanAgentEnvironment({
  AWP_AGENT_MODEL: 'fixture-model',
  AWP_CONTROL_PLANE_URL: 'http://127.0.0.1:8100',
  AWP_CONTROL_PLANE_API_KEY: 'fixture-control-plane-token-must-not-print',
}))
assert.equal(managedSettingsWithoutOptIn.status, 0, managedSettingsWithoutOptIn.stderr)
assert.doesNotMatch(
  `${managedSettingsWithoutOptIn.stdout}\n${managedSettingsWithoutOptIn.stderr}`,
  /fixture-control-plane-token-must-not-print/u,
)

const remoteControlPlaneWithoutOptIn = run(referenceLauncher, cleanAgentEnvironment({
  AWP_AGENT_MODEL: 'fixture-model',
  AWP_AGENT_MANAGED_TASKS_OPT_IN: '1',
  AWP_CONTROL_PLANE_URL: 'https://control.example',
  AWP_CONTROL_PLANE_API_KEY: 'fixture-control-plane-token-must-not-print',
}))
assert.notEqual(remoteControlPlaneWithoutOptIn.status, 0)
assert.match(remoteControlPlaneWithoutOptIn.stderr, /remote control plane requires/u)
assert.doesNotMatch(
  `${remoteControlPlaneWithoutOptIn.stdout}\n${remoteControlPlaneWithoutOptIn.stderr}`,
  /fixture-control-plane-token-must-not-print/u,
)

const referenceSmoke = run(referenceLauncher, cleanAgentEnvironment({
  AWP_AGENT_API_TOKEN: 'fixture-token-must-not-print',
  AWP_AGENT_MODEL: 'fixture-model',
}))
assert.equal(referenceSmoke.status, 0, referenceSmoke.stderr)
assert.match(referenceSmoke.stdout, /local chat\/SSE adapter ready at http:\/\/127\.0\.0\.1:8787/u)
assert.match(referenceSmoke.stdout, /launcher smoke complete/u)
assert.doesNotMatch(
  `${referenceSmoke.stdout}\n${referenceSmoke.stderr}`,
  /fixture-token-must-not-print/u,
)

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'awp-agent-launcher-contract-'))
let rebound
try {
  const actualState = join(temporaryDirectory, 'actual-state')
  const linkedState = join(temporaryDirectory, 'linked-state')
  await mkdir(actualState, { mode: 0o700 })
  await symlink(actualState, linkedState, process.platform === 'win32' ? 'junction' : 'dir')
  const unsafeState = spawnSync(process.execPath, [referenceAdapter, '--model', 'fixture-model'], {
    cwd: root,
    env: cleanAgentEnvironment({
      AWP_REFERENCE_API_BASE_URL: 'http://127.0.0.1:11434/v1',
      AWP_REFERENCE_STATE_DIR: linkedState,
    }),
    input: '{"type":"shutdown"}\n',
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.notEqual(unsafeState.status, 0)
  assert.match(unsafeState.stdout, /unsafe_session_state_directory/u)

  rebound = await startDemoControlPlane({
    host: '127.0.0.1',
    port: 8787,
    stateFile: join(temporaryDirectory, 'sessions.json'),
  })
  assert.equal(rebound.port, 8787, 'real-agent launcher must release its fixed local adapter port')
} finally {
  if (rebound) await rebound.close()
  await rm(temporaryDirectory, { recursive: true, force: true })
}

process.stdout.write('[agent-electron-contract] fail-visible configuration, remote opt-in, secret silence, and cleanup passed\n')
