import { lstat, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const adapter = resolve(
  scriptDirectory,
  '../../../examples/openai-compatible-agent-cli/awp-agent-cli.mjs',
)
const adapterInfo = await lstat(adapter).catch(() => null)
if (!adapterInfo?.isFile() || adapterInfo.isSymbolicLink()) {
  throw new Error('the checked-in OpenAI-compatible reference adapter is unavailable')
}

const baseUrl = String(
  process.env.AWP_AGENT_API_BASE_URL ?? 'http://127.0.0.1:11434/v1',
).trim()
const model = String(process.env.AWP_AGENT_MODEL ?? '').trim()
if (!model) throw new Error('AWP_AGENT_MODEL is required')

let parsed
try {
  parsed = new URL(baseUrl)
} catch {
  throw new Error('AWP_AGENT_API_BASE_URL must be an absolute HTTP(S) URL')
}
if (parsed.username || parsed.password || parsed.search || parsed.hash) {
  throw new Error('AWP_AGENT_API_BASE_URL cannot contain credentials, a query, or a fragment')
}
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase())
if (!['http:', 'https:'].includes(parsed.protocol) || (!loopback && parsed.protocol !== 'https:')) {
  throw new Error('AWP_AGENT_API_BASE_URL must use HTTP on loopback or HTTPS')
}
if (!loopback && process.env.AWP_AGENT_REMOTE_API_OPT_IN !== '1') {
  throw new Error('a remote model endpoint requires AWP_AGENT_REMOTE_API_OPT_IN=1')
}

const stateDirectory = resolve(
  process.env.AWP_AGENT_STATE_DIR
    || resolve(scriptDirectory, '../.agent-data/reference-agent-sessions'),
)
const childEnv = {
  AWP_REFERENCE_API_BASE_URL: baseUrl,
  AWP_REFERENCE_MODEL: model,
  AWP_REFERENCE_STATE_DIR: stateDirectory,
}
const apiToken = String(process.env.AWP_AGENT_API_TOKEN ?? '')
const systemPrompt = String(process.env.AWP_AGENT_SYSTEM_PROMPT ?? '')
const timeout = String(process.env.AWP_AGENT_TIMEOUT_MS ?? '')
const managedTaskOptIn = process.env.AWP_AGENT_MANAGED_TASKS_OPT_IN === '1'
const controlPlaneUrl = String(process.env.AWP_CONTROL_PLANE_URL ?? '').trim()
const controlPlaneToken = String(process.env.AWP_CONTROL_PLANE_API_KEY ?? '')
if (apiToken) childEnv.AWP_REFERENCE_API_TOKEN = apiToken
if (systemPrompt) childEnv.AWP_REFERENCE_SYSTEM_PROMPT = systemPrompt
if (timeout) childEnv.AWP_REFERENCE_TIMEOUT_MS = timeout
if (!loopback) childEnv.AWP_REFERENCE_REMOTE_API_OPT_IN = '1'
if (managedTaskOptIn) {
  if (!controlPlaneUrl || !controlPlaneToken) {
    throw new Error('AWP_CONTROL_PLANE_URL and AWP_CONTROL_PLANE_API_KEY are required for managed tasks')
  }
  let controlPlane
  try {
    controlPlane = new URL(controlPlaneUrl)
  } catch {
    throw new Error('AWP_CONTROL_PLANE_URL must be an origin-only HTTP(S) URL')
  }
  if (
    controlPlane.username
    || controlPlane.password
    || controlPlane.search
    || controlPlane.hash
    || (controlPlane.pathname !== '/' && controlPlane.pathname !== '')
  ) {
    throw new Error('AWP_CONTROL_PLANE_URL must be an origin-only HTTP(S) URL')
  }
  const localControlPlane = ['localhost', '127.0.0.1', '[::1]'].includes(
    controlPlane.hostname.toLowerCase(),
  )
  if (
    !['http:', 'https:'].includes(controlPlane.protocol)
    || (!localControlPlane && controlPlane.protocol !== 'https:')
  ) {
    throw new Error('AWP_CONTROL_PLANE_URL must use HTTP on loopback or HTTPS')
  }
  if (!localControlPlane && process.env.AWP_AGENT_REMOTE_API_OPT_IN !== '1') {
    throw new Error('a remote control plane requires AWP_AGENT_REMOTE_API_OPT_IN=1')
  }
  if (
    controlPlaneToken !== controlPlaneToken.trim()
    || Buffer.byteLength(controlPlaneToken, 'utf8') < 16
    || Buffer.byteLength(controlPlaneToken, 'utf8') > 4096
    || /[\u0000-\u0020\u007f]/u.test(controlPlaneToken)
  ) {
    throw new Error('AWP_CONTROL_PLANE_API_KEY is not canonical')
  }
  childEnv.AWP_REFERENCE_MANAGED_TASKS_OPT_IN = '1'
  childEnv.AWP_REFERENCE_CONTROL_PLANE_URL = controlPlane.origin
  childEnv.AWP_REFERENCE_CONTROL_PLANE_TOKEN = controlPlaneToken
}

process.env.AWP_AGENT_CLI_EXECUTABLE = await realpath(process.execPath)
process.env.AWP_AGENT_CLI_ARGS_JSON = JSON.stringify([adapter])
process.env.AWP_AGENT_CLI_ENV_JSON = JSON.stringify(childEnv)
process.env.AWP_AGENT_CLI_PROTOCOL = 'awp-jsonl'
process.env.AWP_AGENT_DEFAULT_MODEL = model
process.env.AWP_AGENT_MODEL_NAME = `OpenAI-compatible: ${model}`

await import('./agent-electron.mjs')
