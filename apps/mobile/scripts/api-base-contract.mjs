import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const here = path.dirname(fileURLToPath(import.meta.url))
const sourcePath = path.join(here, '..', 'src', 'lib', 'api.ts')
const source = fs.readFileSync(sourcePath, 'utf8')
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
const moduleRecord = { exports: {} }
new Function('module', 'exports', 'require', output)(
  moduleRecord,
  moduleRecord.exports,
  (id) => { throw new Error(`unexpected runtime import: ${id}`) },
)
const { FALLBACK_BASE_URL, fetchHealth, normalizeBaseUrl } = moduleRecord.exports

assert.equal(normalizeBaseUrl(''), FALLBACK_BASE_URL)
assert.equal(normalizeBaseUrl('http://localhost:8100'), 'http://localhost:8100')
assert.equal(normalizeBaseUrl('http://127.0.0.1:8100/'), 'http://127.0.0.1:8100')
assert.equal(normalizeBaseUrl('http://[::1]:8100'), 'http://[::1]:8100')
assert.equal(normalizeBaseUrl('https://control.example.test:8443'), 'https://control.example.test:8443')

for (const unsafe of [
  ' http://127.0.0.1:8100',
  'http://127.0.0.1:8100/path',
  'http://127.0.0.1:8100?token=value',
  ['http://user', 'pass@127.0.0.1:8100'].join(':'),
  'http://localhost.evil:8100',
  'http://127.0.0.1.evil:8100',
  'http://2130706433:8100',
  'http://0x7f000001:8100',
  'http://0.0.0.0:8100',
  'http://203.0.113.10:8100',
  'javascript:alert(1)',
]) {
  assert.throws(() => normalizeBaseUrl(unsafe), { name: 'ApiError' }, unsafe)
}

let seenRequest
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  seenRequest = { url: String(url), init }
  return new Response(JSON.stringify({ status: 'ready' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
try {
  await fetchHealth('http://127.0.0.1:8100')
  assert.equal(seenRequest.url, 'http://127.0.0.1:8100/v1/health/ready')
  assert.equal(seenRequest.init.redirect, 'error')
} finally {
  globalThis.fetch = originalFetch
}

console.log('mobile API base contract: PASS')
