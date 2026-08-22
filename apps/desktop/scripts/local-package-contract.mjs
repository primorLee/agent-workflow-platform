import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const root = resolve(import.meta.dirname, '..')
const wrapper = resolve(root, 'scripts', 'local-build-wrapper.js')

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
assert.equal(
  packageJson.scripts?.['test:unit'],
  'vitest run --maxWorkers=1',
  'test:unit must remain deterministic on resource-constrained CI runners',
)
assert.equal(
  packageJson.scripts?.['demo:server'],
  undefined,
  'the capability-protected demo adapter must only start through an owned launcher',
)
for (const file of ['demo-dev.mjs', 'demo-electron.mjs', 'demo-electron-ui-smoke.mjs']) {
  const source = readFileSync(resolve(root, 'scripts', file), 'utf8')
  assert.doesNotMatch(
    source,
    /(?:console\.(?:log|error|warn)|process\.(?:stdout|stderr)\.write)[^\r\n]*(?:runtime\.token|AWP_DEMO_TOKEN|demoToken)/u,
    `${file} must never print the ephemeral demo capability`,
  )
}

function run(args) {
  return spawnSync(process.execPath, [wrapper, ...args], {
    cwd: root,
    encoding: 'utf8',
  })
}

const stable = run(['--channel', 'stable', '--dry-run'])
assert.equal(stable.status, 0, stable.stderr)
assert.match(stable.stdout, /dry-run installer-stable -> build/)
assert.match(stable.stdout, /channel=stable; output=build; publish=disabled/)
assert.doesNotMatch(stable.stdout, /electron-builder\.insiders\.yml/)

const preview = run(['--channel', 'preview', '--dry-run'])
assert.equal(preview.status, 0, preview.stderr)
assert.match(preview.stdout, /dry-run installer-preview -> build-insiders/)
assert.match(preview.stdout, /channel=preview; output=build-insiders; publish=disabled/)
assert.match(preview.stdout, /--config=electron-builder\.insiders\.yml/)

const rejected = run(['--channel', 'stable', '--dry-run', '--', '--publish=always'])
assert.notEqual(rejected.status, 0)
assert.match(rejected.stderr, /publishing is disabled/)

process.stdout.write('[local-package-contract] deterministic unit worker, isolated stable/preview outputs, and publish rejection passed\n')
