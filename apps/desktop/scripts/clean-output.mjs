import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const APP_ROOT = realpathSync(resolve(SCRIPT_DIR, '..'))

export const OUTPUT_TARGETS = Object.freeze({
  renderer: 'dist',
  electron: 'dist-electron',
  'cloud-mcp': 'dist-awp-cloud-mcp',
  'installer-stable': 'build',
  'installer-preview': 'build-insiders',
})

export const BUILD_OUTPUT_TARGETS = Object.freeze([
  'renderer',
  'electron',
  'cloud-mcp',
])

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

export function resolveOutputTarget(name) {
  const directory = OUTPUT_TARGETS[name]
  if (!directory) {
    throw new Error(`unknown output target: ${name}`)
  }

  const target = resolve(APP_ROOT, directory)
  const rel = relative(APP_ROOT, target)
  if (rel !== directory || isAbsolute(rel) || rel.startsWith(`..`)) {
    throw new Error(`refusing output outside desktop app: ${target}`)
  }
  if (!samePath(dirname(target), APP_ROOT)) {
    throw new Error(`output must be a direct child of desktop app: ${target}`)
  }
  return target
}

export function cleanOutputTarget(name, options = {}) {
  const target = resolveOutputTarget(name)
  const rel = relative(APP_ROOT, target)

  if (existsSync(target)) {
    const stat = lstatSync(target)
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing symbolic-link output target: ${target}`)
    }
  }

  if (options.dryRun) {
    process.stdout.write(`[clean-output] dry-run ${name} -> ${rel}\n`)
    return target
  }

  rmSync(target, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 250,
  })
  process.stdout.write(`[clean-output] removed ${rel}\n`)
  return target
}

export function cleanOutputSelection(selection, options = {}) {
  const names = selection === 'all' ? BUILD_OUTPUT_TARGETS : [selection]
  return names.map((name) => cleanOutputTarget(name, options))
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const positional = args.filter((arg) => arg !== '--dry-run')
  if (positional.length !== 1) {
    throw new Error('usage: node scripts/clean-output.mjs <target|all> [--dry-run]')
  }
  cleanOutputSelection(positional[0], { dryRun })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`[clean-output] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  })
}
