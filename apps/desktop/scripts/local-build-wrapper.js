#!/usr/bin/env node
'use strict'

/**
 * Build a local Windows package from already-built desktop artifacts.
 *
 * This wrapper is intentionally local-only: it never copies artifacts into an
 * upload staging area and rejects electron-builder publish flags. Stable uses
 * package.json; preview uses the existing isolated Insiders builder config.
 */

const path = require('node:path')
const { spawnSync } = require('node:child_process')

const APP_ROOT = path.resolve(__dirname, '..')
const CLEANER = path.join(__dirname, 'clean-output.mjs')
const ARTIFACT_CHECK = path.join(__dirname, 'assert-no-sourcemaps.mjs')

function parseArgs(argv) {
  const result = { channel: 'stable', forward: [], dryRun: false }
  const args = argv.slice(2)
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === '--dry-run') {
      result.dryRun = true
    } else if (value === '--channel') {
      const channel = args[index + 1]
      if (!channel) throw new Error('--channel requires stable or preview')
      result.channel = channel
      index += 1
    } else if (value === '--') {
      result.forward = args.slice(index + 1)
      break
    } else {
      result.forward.push(value)
    }
  }

  if (result.channel === 'insiders') result.channel = 'preview'
  if (!['stable', 'preview'].includes(result.channel)) {
    throw new Error(`unsupported channel: ${result.channel}`)
  }
  if (result.forward.some((value) => value === '-p' || /^--publish(?:=|$)/.test(value))) {
    throw new Error('publishing is disabled in the public local-build workflow')
  }
  return result
}

function run(command, args, label, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: APP_ROOT,
    env,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${label} exited with code ${result.status ?? 'unknown'}`)
}

function main() {
  const options = parseArgs(process.argv)
  const preview = options.channel === 'preview'
  const cleanTarget = preview ? 'installer-preview' : 'installer-stable'
  const outputDirectory = preview ? 'build-insiders' : 'build'

  const builderCli = require.resolve('electron-builder/cli.js')
  const builderArgs = [builderCli, '--win']
  if (preview) builderArgs.push('--config=electron-builder.insiders.yml')
  builderArgs.push(...options.forward)

  if (options.dryRun) {
    run(process.execPath, [CLEANER, cleanTarget, '--dry-run'], 'installer output cleanup dry-run')
    process.stdout.write(`[local-package] dry-run channel=${options.channel}; output=${outputDirectory}; publish=disabled\n`)
    process.stdout.write(`[local-package] command=${JSON.stringify([process.execPath, ...builderArgs])}\n`)
    return
  }

  run(process.execPath, [CLEANER, cleanTarget], 'installer output cleanup')
  run(process.execPath, [ARTIFACT_CHECK], 'production artifact check')
  process.stdout.write(`[local-package] channel=${options.channel}; output=${outputDirectory}; publish=disabled\n`)
  run(process.execPath, builderArgs, 'electron-builder', {
    ...process.env,
    AWP_LOCAL_PACKAGE_CHANNEL: options.channel,
  })
  process.stdout.write(`[local-package] complete: ${outputDirectory}\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`[local-package] ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
