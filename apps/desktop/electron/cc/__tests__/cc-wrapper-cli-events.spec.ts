/**
 * Parser regression tests for complete-message wrapper events and raw
 * delta-oriented stream events. These representative fixtures preserve the
 * production protocol shapes that previously produced empty replies.
 */

import { describe, it, expect } from 'vitest'

// Mock electron BEFORE importing cc-wrapper — `broadcast()` uses BrowserWindow
// but this spec only touches the pure `translateEvent()` function.
import { vi } from 'vitest'
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() },
}))

import { translateEvent } from '../cc-wrapper'
import type { CcSession, FlatChunk } from '../cc-wrapper'

function newSessionFixture(): CcSession {
  return {
    sessionId: 's-fixture',
    conversationId: 'c-fixture',
    // @ts-expect-error partial fake — translateEvent doesn't touch proc.
    proc: {},
    cwd: '/tmp',
    model: 'fixture-model',
    phase: 'idle',
    stdoutBuffer: '',
    stderrBuffer: '',
    decoder: new TextDecoder('utf-8', { fatal: false }),
    pendingToolInput: new Map(),
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
  }
}

function asArray(out: FlatChunk | FlatChunk[] | null): FlatChunk[] {
  if (out === null) return []
  return Array.isArray(out) ? out : [out]
}

// ---------------------------------------------------------------------------
// Representative complete-message stream fixtures
// ---------------------------------------------------------------------------

const EVT_SYSTEM_HOOK_STARTED = {
  type: 'system',
  subtype: 'hook_started',
  hook_id: 'hook-fixture-001',
  hook_name: 'SessionStart:startup',
  hook_event: 'SessionStart',
  uuid: 'event-fixture-001',
  session_id: 'session-fixture-001',
}

const EVT_SYSTEM_INIT = {
  type: 'system',
  subtype: 'init',
  cwd: 'C:\\Example\\workspace',
  session_id: 'session-fixture-001',
  tools: ['Task', 'Bash', 'Read'],
  mcp_servers: [{ name: 'pencil', status: 'connected' }],
  model: 'fixture-model',
  permissionMode: 'default',
  apiKeySource: 'none',
  output_style: 'default',
}

const EVT_ASSISTANT_TEXT = {
  type: 'assistant',
  message: {
    model: 'fixture-model',
    id: 'msg_fixture_001',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Hi there, operator.' }],
    stop_reason: null,
    stop_sequence: null,
    usage: {
      input_tokens: 6,
      cache_creation_input_tokens: 50615,
      cache_read_input_tokens: 0,
      output_tokens: 4,
      service_tier: 'standard',
    },
  },
  parent_tool_use_id: null,
  session_id: 'session-fixture-001',
  uuid: 'event-fixture-002',
}

const EVT_ASSISTANT_TOOL_USE = {
  type: 'assistant',
  message: {
    model: 'fixture-model',
    id: 'msg_tool',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'text', text: "I'll check that file." },
      {
        type: 'tool_use',
        id: 'toolu_01ABC',
        name: 'Read',
        input: { file_path: '/tmp/foo.py' },
      },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 45 },
  },
  session_id: 'session-fixture-001',
  uuid: 'some-uuid',
}

const EVT_USER_TOOL_RESULT = {
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        tool_use_id: 'toolu_01ABC',
        type: 'tool_result',
        content: 'file contents here',
      },
    ],
  },
  session_id: 'session-fixture-001',
}

const EVT_RATE_LIMIT_ALLOWED = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed',
    resetsAt: 1777061400,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    overageDisabledReason: 'org_level_disabled_until',
    isUsingOverage: false,
  },
  uuid: 'event-fixture-003',
  session_id: 'session-fixture-001',
}

const EVT_RATE_LIMIT_BLOCKED = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'rate_limited',
    resetsAt: 1777061400,
    rateLimitType: 'five_hour',
  },
  session_id: 'session-fixture-001',
}

const EVT_RESULT_SUCCESS = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 7866,
  duration_api_ms: 3360,
  num_turns: 1,
  result: 'Hi there, operator.',
  stop_reason: 'end_turn',
  session_id: 'session-fixture-001',
  total_cost_usd: 0.95009625,
  usage: {
    input_tokens: 6,
    cache_creation_input_tokens: 50615,
    cache_read_input_tokens: 0,
    output_tokens: 13,
    service_tier: 'standard',
  },
  uuid: 'event-fixture-004',
}

const EVT_RESULT_ERROR = {
  type: 'result',
  subtype: 'error_max_turns',
  is_error: true,
  duration_ms: 12000,
  num_turns: 10,
  result: 'Maximum turns reached',
  session_id: 'err-session',
  usage: { input_tokens: 100, output_tokens: 200 },
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('translateEvent — representative CLI wrapper events', () => {
  it('system.init emits ready status + message_start', () => {
    const s = newSessionFixture()
    const out = asArray(translateEvent(EVT_SYSTEM_INIT, s))
    expect(out).toEqual([
      { type: 'cc_status', label: 'ready' },
      {
        type: 'message_start',
        conversation_id: 'c-fixture',
        model: 'fixture-model',
        // The renderer persists this native id for a later --resume spawn.
        cc_session_id: 'session-fixture-001',
      },
    ])
  })

  it('system.hook_started / hook_response are silent (housekeeping)', () => {
    const s = newSessionFixture()
    expect(translateEvent(EVT_SYSTEM_HOOK_STARTED, s)).toBeNull()
  })

  it('assistant with text content emits full delta (no done flag)', () => {
    const s = newSessionFixture()
    const out = asArray(translateEvent(EVT_ASSISTANT_TEXT, s))
    expect(out).toEqual([{ delta: 'Hi there, operator.' }])
    // Tool-use round trips can emit additional assistant events.
    expect(out.some((c) => c.done)).toBe(false)
  })

  it('assistant with mixed text + tool_use emits delta + cc_status', () => {
    const s = newSessionFixture()
    const out = asArray(translateEvent(EVT_ASSISTANT_TOOL_USE, s))
    expect(out).toEqual([
      { delta: "I'll check that file." },
      { type: 'cc_status', label: 'Reading foo.py', tool: 'Read' },
    ])
  })

  it('user (tool_result echo) is silent — already covered by cc_status', () => {
    const s = newSessionFixture()
    expect(translateEvent(EVT_USER_TOOL_RESULT, s)).toBeNull()
  })

  it('rate_limit_event status=allowed is silent (do not spam UI)', () => {
    const s = newSessionFixture()
    expect(translateEvent(EVT_RATE_LIMIT_ALLOWED, s)).toBeNull()
  })

  it('rate_limit_event status=rate_limited emits cc_status', () => {
    const s = newSessionFixture()
    const out = asArray(translateEvent(EVT_RATE_LIMIT_BLOCKED, s))
    expect(out).toEqual([{ type: 'cc_status', label: 'rate_limited' }])
  })

  it('result.success emits done:true + flat usage', () => {
    const s = newSessionFixture()
    const out = asArray(translateEvent(EVT_RESULT_SUCCESS, s))
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      done: true,
      usage: {
        input_tokens: 6,
        output_tokens: 13,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 50615,
      },
    })
  })

  it('result.is_error=true emits done:true + error message', () => {
    const s = newSessionFixture()
    const out = asArray(translateEvent(EVT_RESULT_ERROR, s))
    expect(out).toHaveLength(1)
    expect(out[0].done).toBe(true)
    expect(out[0].error).toBe('Maximum turns reached')
    expect(out[0].usage?.input_tokens).toBe(100)
    expect(out[0].usage?.output_tokens).toBe(200)
  })

  it('end-to-end real stream: init → assistant → rate_limit(allowed) → result.success', () => {
    const s = newSessionFixture()
    const stream = [
      EVT_SYSTEM_HOOK_STARTED,
      EVT_SYSTEM_INIT,
      EVT_ASSISTANT_TEXT,
      EVT_RATE_LIMIT_ALLOWED,
      EVT_RESULT_SUCCESS,
    ]
    const flat: FlatChunk[] = []
    for (const e of stream) {
      const out = translateEvent(e, s)
      if (!out) continue
      if (Array.isArray(out)) flat.push(...out)
      else flat.push(out)
    }

    // Expected renderer-visible chunks:
    //   [ready cc_status, message_start, delta, done+usage ]
    expect(flat).toEqual([
      { type: 'cc_status', label: 'ready' },
      {
        type: 'message_start',
        conversation_id: 'c-fixture',
        model: 'fixture-model',
        cc_session_id: 'session-fixture-001',
      },
      { delta: 'Hi there, operator.' },
      {
        done: true,
        usage: {
          input_tokens: 6,
          output_tokens: 13,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 50615,
        },
      },
    ])

    // Most importantly: the stream produces a non-empty text delta. This is
    // the exact regression T-V8 Bug #5 described — before the fix every
    // event returned null and the chat bubble was empty.
    const textDeltas = flat.map((c) => c.delta).filter((d): d is string => !!d)
    expect(textDeltas.join('')).toBe('Hi there, operator.')
  })
})

describe('translateEvent — raw SDK events still work (back-compat)', () => {
  // fake-cc-cli.js emits SDK-raw shapes; this guards against accidental
  // regression of the other branch while we add wrapper support.

  it('message_start emits flat message_start chunk', () => {
    const s = newSessionFixture()
    const out = asArray(
      translateEvent(
        {
          type: 'message_start',
          message: { id: 'msg_x', role: 'assistant', model: 'fixture-model' },
        },
        s,
      ),
    )
    expect(out).toEqual([
      {
        type: 'message_start',
        conversation_id: 'c-fixture',
        model: 'fixture-model',
      },
    ])
  })

  it('content_block_delta.text_delta emits {delta}', () => {
    const s = newSessionFixture()
    const out = asArray(
      translateEvent(
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
        s,
      ),
    )
    expect(out).toEqual([{ delta: 'hello' }])
  })

  it('message_delta usage → {usage:{...}}', () => {
    const s = newSessionFixture()
    const out = asArray(
      translateEvent(
        {
          type: 'message_delta',
          usage: { input_tokens: 10, output_tokens: 20 },
        },
        s,
      ),
    )
    expect(out).toEqual([{ usage: { input_tokens: 10, output_tokens: 20 } }])
  })

  it('message_stop → {done:true}', () => {
    const s = newSessionFixture()
    const out = asArray(translateEvent({ type: 'message_stop' }, s))
    expect(out).toEqual([{ done: true }])
  })

  it('fake-cc-cli 6-event happy path produces non-empty text + done', () => {
    // Matches the exact stream `fake-cc-cli.js` emits so we guarantee the
    // existing E2E mock still works end-to-end.
    const s = newSessionFixture()
    const stream = [
      { type: 'message_start', message: { model: 'fixture-model' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: {
          input_tokens: 15,
          output_tokens: 1,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        },
      },
      { type: 'message_stop' },
    ]
    const flat: FlatChunk[] = []
    for (const e of stream) {
      const out = translateEvent(e, s)
      if (!out) continue
      if (Array.isArray(out)) flat.push(...out)
      else flat.push(out)
    }
    const textDeltas = flat.map((c) => c.delta).filter((d): d is string => !!d)
    expect(textDeltas.join('')).toBe('ok')
    expect(flat.some((c) => c.done === true)).toBe(true)
    const usageChunk = flat.find((c) => c.usage)
    expect(usageChunk?.usage?.input_tokens).toBe(15)
  })
})

describe('translateEvent — defensive', () => {
  it('returns null for null / non-object input', () => {
    const s = newSessionFixture()
    expect(translateEvent(null, s)).toBeNull()
    expect(translateEvent(undefined, s)).toBeNull()
    expect(translateEvent('not an object', s)).toBeNull()
    expect(translateEvent(42, s)).toBeNull()
  })

  it('returns null for unknown event type', () => {
    const s = newSessionFixture()
    expect(translateEvent({ type: 'something_new' }, s)).toBeNull()
  })

  it('assistant with empty content array returns null', () => {
    const s = newSessionFixture()
    expect(
      translateEvent({ type: 'assistant', message: { content: [] } }, s),
    ).toBeNull()
  })
})
