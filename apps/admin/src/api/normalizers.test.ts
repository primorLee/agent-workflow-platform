import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeApiBase,
  normalizeReady,
  normalizeSessions,
  normalizeTasks,
} from './normalizers.ts'

test('normalizes the control-plane readiness response', () => {
  const ready = normalizeReady({
    status: 'ok',
    database: 'ok',
    broker: {
      backend: 'redis',
      redis_connected: true,
      fallback_triggered: false,
      last_ping_ms: 1.25,
      last_ping_at: '2026-08-22T00:00:00Z',
    },
  })

  assert.deepEqual(ready, {
    status: 'ok',
    database: 'ok',
    broker: {
      backend: 'redis',
      redisConnected: true,
      fallbackTriggered: false,
      lastPingMs: 1.25,
      lastPingAt: '2026-08-22T00:00:00Z',
    },
  })
})

test('maps task and session snake_case fields without inventing backend data', () => {
  const [task] = normalizeTasks([{
    id: 'task-1',
    tenant_id: 'local',
    task_type: 'command',
    status: 'running',
    created_at: '2026-08-22T00:00:00Z',
    assigned_agent_id: 'agent-1',
    payload: { command: 'echo synthetic' },
  }])
  const [session] = normalizeSessions([{
    session_id: 'session-1',
    user_id: 'local',
    session_type: 'interactive',
    status: 'active',
    resources: { cpu_limit: 2, mem_limit_mb: 2048 },
    metadata: { source: 'test' },
  }])

  assert.equal(task.id, 'task-1')
  assert.equal(task.type, 'command')
  assert.equal(task.assignedAgentId, 'agent-1')
  assert.deepEqual(task.payload, { command: 'echo synthetic' })
  assert.equal(session.id, 'session-1')
  assert.equal(session.type, 'interactive')
  assert.equal(session.resources.mem_limit_mb, 2048)
})

test('rejects non-array collection responses', () => {
  assert.throws(() => normalizeTasks({ tasks: [] }), /Unexpected tasks response/)
  assert.throws(() => normalizeSessions(null), /Unexpected sessions response/)
})

test('accepts only explicit loopback API addresses', () => {
  assert.equal(normalizeApiBase('localhost:8100'), 'http://localhost:8100')
  assert.equal(normalizeApiBase('http://127.0.0.1:8100/'), 'http://127.0.0.1:8100')
  assert.throws(() => normalizeApiBase('https://api.example.test'), /loopback address/)
  assert.throws(() => normalizeApiBase('file:///tmp/socket'), /HTTP or HTTPS/)
})
