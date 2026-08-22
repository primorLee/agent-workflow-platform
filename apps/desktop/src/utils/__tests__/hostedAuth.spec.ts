import { afterEach, describe, expect, it } from 'vitest'
import { isHostedAuthEnabled } from '../hostedAuth'

describe('isHostedAuthEnabled', () => {
  afterEach(() => {
    delete window.__AWP_HOSTED_AUTH_ENABLED
  })

  it('fails closed when preload did not expose the flag', () => {
    expect(isHostedAuthEnabled()).toBe(false)
  })

  it('accepts only the boolean true exposed by preload', () => {
    window.__AWP_HOSTED_AUTH_ENABLED = false
    expect(isHostedAuthEnabled()).toBe(false)

    ;(window as unknown as Record<string, unknown>).__AWP_HOSTED_AUTH_ENABLED = '1'
    expect(isHostedAuthEnabled()).toBe(false)

    window.__AWP_HOSTED_AUTH_ENABLED = true
    expect(isHostedAuthEnabled()).toBe(true)
  })
})
