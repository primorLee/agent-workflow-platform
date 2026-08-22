import { describe, expect, it } from 'vitest'
import { normalizeServiceBaseUrl, normalizeServiceEndpointUrl } from '../service-base-url'

describe('normalizeServiceBaseUrl', () => {
  it.each([
    ['http://localhost:8787', 'http://localhost:8787'],
    ['http://127.0.0.1:8100/', 'http://127.0.0.1:8100'],
    ['http://[::1]:8787', 'http://[::1]:8787'],
    ['https://API.Example.test:443/', 'https://api.example.test'],
  ])('accepts canonical safe origin %s', (raw, expected) => {
    expect(normalizeServiceBaseUrl(raw)).toBe(expected)
  })

  it.each([
    '',
    ' http://localhost:8787',
    'http://localhost:8787/path',
    'http://localhost:8787?token=value',
    'http://localhost:8787#fragment',
    ['http://user', 'pass@localhost:8787'].join(':'),
    'http://localhost.evil:8787',
    'http://127.0.0.1.evil:8787',
    'http://0.0.0.0:8787',
    `http://${[192, 0, 2, 4].join('.')}:8787`,
    `http://${[192, 168, 10, 2].join('.')}:8787`,
    'http://2130706433:8787',
    'http://0177.0.0.1:8787',
    'http://local%68ost:8787',
    'http://localhost\\@evil.test',
    'javascript:alert(1)',
    'file:///tmp/service',
    'https://example.test/%ZZ',
  ])('rejects unsafe or ambiguous input without throwing: %s', (raw) => {
    expect(normalizeServiceBaseUrl(raw)).toBeNull()
  })
})

describe('normalizeServiceEndpointUrl', () => {
  it('keeps a safe HTTPS path and query on the validated origin', () => {
    expect(normalizeServiceEndpointUrl('https://api.example.test/v1/events?cursor=next'))
      .toBe('https://api.example.test/v1/events?cursor=next')
  })

  it.each([
    'http://example.test/v1/events',
    'http://2130706433/v1/events',
    'https://user@example.test/v1/events',
    'https://example.test//evil',
    'https://example.test/v1/events#secret',
    'https://example.test/%2f%2fevil.test',
  ])('rejects unsafe endpoints %s', (raw) => {
    expect(normalizeServiceEndpointUrl(raw)).toBeNull()
  })
})