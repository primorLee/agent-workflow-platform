import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { APP_ROOT, BUILD_OUTPUT_TARGETS, resolveOutputTarget } from './clean-output.mjs'

function walk(directory, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`
    if (entry.isSymbolicLink()) {
      throw new Error(`symbolic link found in production output: ${relative(APP_ROOT, path)}`)
    }
    if (entry.isDirectory()) walk(path, files)
    else if (entry.isFile()) files.push(path)
  }
}

const files = []
for (const target of BUILD_OUTPUT_TARGETS) {
  const directory = resolveOutputTarget(target)
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) {
    throw new Error(`missing production output: ${relative(APP_ROOT, directory)}`)
  }
  walk(directory, files)
}

const mapFiles = files.filter((file) => file.endsWith('.map'))
const mappedJavaScript = files.filter((file) => {
  if (!file.endsWith('.js')) return false
  const content = readFileSync(file, 'utf8')
  const tail = content.slice(-4096)
  return /(?:^|\r?\n)\s*(?:\/\/[#@]|\/\*[#@])\s*sourceMappingURL\s*=/.test(tail)
})

if (mapFiles.length || mappedJavaScript.length) {
  const offending = [...mapFiles, ...mappedJavaScript]
    .map((file) => relative(APP_ROOT, file))
    .join('\n  - ')
  throw new Error(`production source maps are forbidden:\n  - ${offending}`)
}

process.stdout.write(`[artifact-check] ${files.length} files across ${BUILD_OUTPUT_TARGETS.length} clean outputs; no source maps\n`)
