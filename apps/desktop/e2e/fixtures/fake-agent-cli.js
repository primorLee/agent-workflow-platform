#!/usr/bin/env node
/**
 * Deterministic fake Agent CLI implementing the stream-json fixture protocol.
 *
 * It drains stdin, emits a fixed six-event response, and exits cleanly.
 * `AWP_FAKE_AGENT_MODE=flood` exercises the output-size guard; `hang`
 * exercises process shutdown. No network access or provider account is used.
 */

'use strict'

const ARGV_PATH = process.env.AWP_FAKE_ARGV_PATH || ''
if (ARGV_PATH) require('node:fs').writeFileSync(ARGV_PATH, JSON.stringify(process.argv.slice(2)), 'utf8')

const MODE = process.env.AWP_FAKE_AGENT_MODE || 'normal'

// Drain stdin — parent writes `{"type":"user",...}\n` and we must not block it.
process.stdin.on('data', () => { /* ignore */ })
process.stdin.on('end', () => { /* ignore */ })
process.stdin.on('error', () => { /* ignore */ })

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))

if (MODE === 'flood') {
  // Write ~10 MiB in one line with no newline to trigger cc-wrapper's
  // STDOUT_OVERSIZE_LIMIT (4 MiB) and force a session-stop with
  // `runtime_output_oversize`.
  const chunk = 'x'.repeat(64 * 1024) // 64 KiB
  let written = 0
  const target = 10 * 1024 * 1024
  const pump = () => {
    while (written < target) {
      const ok = process.stdout.write(chunk)
      written += chunk.length
      if (!ok) {
        process.stdout.once('drain', pump)
        return
      }
    }
    // Never emit a newline so it all accumulates in one line -> trip limit.
    // Then hang until killed.
  }
  pump()
  // Hang — the parent should SIGTERM us via stopSession().
  setInterval(() => {}, 1 << 30)
  return
}

if (MODE === 'hang') {
  // Never produce output, never exit. Used to verify app.close / stopSession
  // actually signals the child process.
  setInterval(() => {}, 1 << 30)
  return
}

// Default: deterministic 6-event stream-json sequence.
const events = [
  {
    type: 'message_start',
    message: {
      id: 'msg_fake_e2e',
      role: 'assistant',
      model: 'agent-fixture',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: {
      input_tokens: 15,
      output_tokens: 1,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    },
  },
  { type: 'message_stop' },
]

let i = 0
const pump = () => {
  if (i >= events.length) {
    // Ensure buffers flush before exit.
    process.stdout.end(() => process.exit(0))
    return
  }
  const line = JSON.stringify(events[i]) + '\n'
  process.stdout.write(line, () => {
    i += 1
    setTimeout(pump, 50)
  })
}
setTimeout(pump, 100)
