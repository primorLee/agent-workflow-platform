import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  APP_ROOT,
  BUILD_OUTPUT_TARGETS,
  OUTPUT_TARGETS,
  cleanOutputTarget,
  resolveOutputTarget,
} from './clean-output.mjs'

const cleaner = resolve(APP_ROOT, 'scripts', 'clean-output.mjs')
const sourceDirectory = resolve(APP_ROOT, 'src')
const sourceExisted = existsSync(sourceDirectory)

for (const name of BUILD_OUTPUT_TARGETS) {
  const target = resolveOutputTarget(name)
  assert.equal(dirname(target), APP_ROOT)
  assert.equal(basename(target), OUTPUT_TARGETS[name])
  assert.equal(cleanOutputTarget(name, { dryRun: true }), target)
}

const dryRun = spawnSync(process.execPath, [cleaner, 'all', '--dry-run'], {
  cwd: APP_ROOT,
  encoding: 'utf8',
})
assert.equal(dryRun.status, 0, dryRun.stderr)
for (const name of BUILD_OUTPUT_TARGETS) {
  assert.match(dryRun.stdout, new RegExp(`dry-run ${name} ->`))
}

const rejected = spawnSync(process.execPath, [cleaner, '../src', '--dry-run'], {
  cwd: APP_ROOT,
  encoding: 'utf8',
})
assert.notEqual(rejected.status, 0)
assert.match(rejected.stderr, /unknown output target/)
assert.equal(existsSync(sourceDirectory), sourceExisted)

process.stdout.write(`[clean-output-contract] ${BUILD_OUTPUT_TARGETS.length} exact build targets accepted; traversal target rejected\n`)
