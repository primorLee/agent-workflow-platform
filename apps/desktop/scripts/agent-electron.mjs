import { lstat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

const executable = String(process.env.AWP_AGENT_CLI_EXECUTABLE ?? '').trim()
const model = String(process.env.AWP_AGENT_DEFAULT_MODEL ?? '').trim()

if (!executable || !isAbsolute(executable)) {
  throw new Error('AWP_AGENT_CLI_EXECUTABLE must be an absolute path to a compatible Agent CLI')
}
const info = await lstat(resolve(executable)).catch(() => null)
if (!info?.isFile() || info.isSymbolicLink()) {
  throw new Error('AWP_AGENT_CLI_EXECUTABLE must identify a regular, non-symlink file')
}
if (!model) {
  throw new Error('AWP_AGENT_DEFAULT_MODEL is required so Desktop does not force a demo model')
}
if (model.length > 256 || /[\u0000-\u001f\u007f]/u.test(model)) {
  throw new Error('AWP_AGENT_DEFAULT_MODEL contains unsupported characters')
}

// Real-agent mode has no silent deterministic fallback. A runtime failure is
// rendered as a visible error so the operator never mistakes a demo response
// for an answer from the configured Agent CLI.
process.env.AWP_LAB_MODE = '1'
process.env.AWP_DEMO_MODEL = model
process.env.AWP_DEMO_MODEL_NAME = String(process.env.AWP_AGENT_MODEL_NAME ?? model)
process.env.AWP_DEMO_MODEL_DESCRIPTION = 'Explicitly configured external Agent CLI'

await import('./demo-electron.mjs')
