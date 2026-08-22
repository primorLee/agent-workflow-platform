import { describe, expect, it } from 'vitest'
import {
  DEMO_TOKEN_HEADER,
  isSemanticLoopbackHttpUrl,
  withDemoAuthHeaders,
} from '../demo-auth'

const token = 'a'.repeat(43)
const demoOrigin = 'http://127.0.0.1:8787'

describe('demo auth header boundary', () => {
  it.each([
    '/api/health',
    '/v1/chat/history?offset=0',
    '/v1/chat/history/conversation-1/messages',
    '/v1/chat/artifacts/artifact-1/download',
    '/v1/chat/completions',
    '/v1/activity/stream',
  ])('attaches the in-memory token only to an allowed route on the exact demo origin: %s', (path) => {
    const url = demoOrigin + path
    expect(withDemoAuthHeaders(url, { Accept: 'application/json' }, token, demoOrigin)).toEqual({
      Accept: 'application/json',
      [DEMO_TOKEN_HEADER]: token,
    })
  })

  it.each([
    ['cross-port', 'http://127.0.0.1:8788/v1/chat/history'],
    ['host-alias', 'http://localhost:8787/v1/chat/history'],
    ['scheme-change', 'https://127.0.0.1:8787/v1/chat/history'],
    ['non-demo-path', 'http://127.0.0.1:8787/internal/debug'],
    ['public-health', 'http://127.0.0.1:8787/health'],
    ['userinfo', 'http://user@127.0.0.1:8787/v1/chat/history'],
    ['malformed', 'http://localhost\\@example.invalid/v1/chat/history'],
  ])('never forwards a token for %s', (_label, url) => {
    const result = withDemoAuthHeaders(url, {
      [DEMO_TOKEN_HEADER.toLowerCase()]: 'caller-controlled',
      Accept: 'application/json',
    }, token, demoOrigin)
    expect(result).toEqual({ Accept: 'application/json' })
  })

  it.each([
    'http://0.0.0.0:8787/',
    'http://' + ['192', '0', '2', '10'].join('.') + ':8787/',
    'http://127.0.0.1.evil.invalid/',
    'https://example.invalid/',
    ' http://127.0.0.1:8787/',
  ])('rejects a non-loopback or ambiguous configured origin: %s', (origin) => {
    expect(isSemanticLoopbackHttpUrl(origin)).toBe(false)
    expect(withDemoAuthHeaders(demoOrigin + '/v1/chat/history', {}, token, origin)).toEqual({})
  })

  it('rejects malformed tokens and missing configured origins', () => {
    expect(withDemoAuthHeaders(demoOrigin + '/v1/chat/history', {}, 'short', demoOrigin)).toEqual({})
    expect(withDemoAuthHeaders(demoOrigin + '/v1/chat/history', {}, token, '')).toEqual({})
  })
})
