import { describe, expect, it } from 'vitest'
import { normalizeServiceBaseUrl, normalizeServiceEndpointUrl } from '../service-base-url'

describe('renderer normalizeServiceBaseUrl', () => {
  it.each([
    ['http://localhost:8787', 'http://localhost:8787'],
    ['http://127.0.0.1:8100/', 'http://127.0.0.1:8100'],
    ['http://[::1]:8787', 'http://[::1]:8787'],
    ['https://Service.Example.test/', 'https://service.example.test'],
  ])('normalizes safe origin %s', (raw, expected) => {
    expect(normalizeServiceBaseUrl(raw)).toBe(expected)
  })

  it.each([
    undefined,
    null,
    '',
    'https://',
    'https:///missing-authority',
    'https://?query-without-authority',
  ])('rejects absent or malformed authority %s', (raw) => {
    expect(normalizeServiceBaseUrl(raw)).toBeNull()
  })

  it.each([
    ' http://localhost:8787',
    'http://localhost.evil:8787',
    'http://0.0.0.0:8787',
    `http://${[10, 0, 0, 4].join('.')}:8787`,
    'http://2130706433:8787',
    'http://local%68ost:8787',
    'https://user@example.test',
    'https://example.test/api',
    'https://example.test?key=value',
    'https://example.test/#fragment',
    'https://example.test\\@evil.test',
  ])('rejects unsafe input %s', (raw) => {
    expect(normalizeServiceBaseUrl(raw)).toBeNull()
  })
})

describe('renderer normalizeServiceEndpointUrl', () => {
  it('allows a relative contract path on a safe origin', () => {
    expect(normalizeServiceEndpointUrl('http://127.0.0.1:8787/v1/chat?cursor=next'))
      .toBe('http://127.0.0.1:8787/v1/chat?cursor=next')
  })

  it.each([
    'http://localhost.evil/v1/chat',
    'http://2130706433/v1/chat',
    'https://user@example.test/v1/chat',
    'https://example.test//evil',
    'https://example.test/v1/chat#secret',
    'https://example.test/%2F%2Fevil.test',
  ])('rejects unsafe endpoint %s', (raw) => {
    expect(normalizeServiceEndpointUrl(raw)).toBeNull()
  })
})