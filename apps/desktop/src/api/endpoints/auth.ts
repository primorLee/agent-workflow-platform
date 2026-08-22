import { api, ApiError } from '../client'
import type { LoginResponse } from '../types'
import { isHostedAuthEnabled } from '@/utils/hostedAuth'


function requireHostedAuth(): void {
  if (!isHostedAuthEnabled()) throw new Error('hosted_auth_disabled')
}

export async function login(email: string, password: string): Promise<LoginResponse> {
  requireHostedAuth()
  return api.post<LoginResponse>('/v1/auth/login', { email, password })
}

export async function register(
  email: string,
  password: string,
  username: string = '',
): Promise<LoginResponse & { message?: string }> {
  requireHostedAuth()
  return api.post<LoginResponse & { message?: string }>('/v1/auth/register', {
    email,
    password,
    username,
  })
}

export async function logout(): Promise<void> {
  requireHostedAuth()
  try { await api.post<void>('/v1/auth/logout') } catch { /* server may be unreachable */ }
  try { localStorage.removeItem('awp_token') } catch { /* */ }
}

/**
 * Validate a stored token against the server.
 * - Returns the validation result on success.
 * - Throws ApiError with status 401 if the token is invalid (caller should clear auth).
 * - Returns null on network errors (server unreachable — caller should trust cached token).
 */
export async function validateToken(): Promise<{ valid: boolean; customer_id: string; email: string } | null> {
  requireHostedAuth()
  try {
    return await api.get<{ valid: boolean; customer_id: string; email: string }>('/v1/auth/validate', undefined, { silent: true })
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      throw err  // Re-throw auth errors so caller can clear the stale token
    }
    return null  // Network error — server unreachable
  }
}
