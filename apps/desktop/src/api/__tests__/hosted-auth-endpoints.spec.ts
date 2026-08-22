import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockPost, mockGet } = vi.hoisted(() => ({
  mockPost: vi.fn(),
  mockGet: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  api: { post: mockPost, get: mockGet },
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number) {
      super(`HTTP ${status}`)
      this.status = status
    }
  },
}))

import * as authApi from '@/api/endpoints/auth'

describe('hosted auth endpoint opt-in', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete window.__AWP_HOSTED_AUTH_ENABLED
  })

  afterEach(() => {
    delete window.__AWP_HOSTED_AUTH_ENABLED
  })

  it('rejects hosted account calls before networking by default', async () => {
    await expect(authApi.login('local@example.invalid', 'unused')).rejects.toThrow('hosted_auth_disabled')
    await expect(authApi.register('local@example.invalid', 'unused')).rejects.toThrow('hosted_auth_disabled')
    await expect(authApi.logout()).rejects.toThrow('hosted_auth_disabled')
    await expect(authApi.validateToken()).rejects.toThrow('hosted_auth_disabled')
    expect(mockPost).not.toHaveBeenCalled()
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('retains the adapter behind the explicit preload boolean', async () => {
    window.__AWP_HOSTED_AUTH_ENABLED = true
    mockPost.mockResolvedValue({ api_key: 'synthetic-token', customer_id: 'tenant-example' })
    mockGet.mockResolvedValue({ valid: true, customer_id: 'tenant-example', email: 'user@example.invalid' })

    await expect(authApi.login('user@example.invalid', 'unused')).resolves.toMatchObject({
      customer_id: 'tenant-example',
    })
    await expect(authApi.validateToken()).resolves.toMatchObject({ valid: true })
    expect(mockPost).toHaveBeenCalledWith('/v1/auth/login', {
      email: 'user@example.invalid',
      password: 'unused',
    })

    expect(mockGet).toHaveBeenCalledWith('/v1/auth/validate', undefined, { silent: true })
  })
})
