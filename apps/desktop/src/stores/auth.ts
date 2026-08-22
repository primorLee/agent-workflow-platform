import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api, ApiError } from '@/api/client'
import * as authApi from '@/api/endpoints/auth'
import { useChatStore } from '@/stores/chat'
import { useSettingsStore } from '@/stores/settings'
import { bridge, waitForBridge, setCredential, getCredential, deleteCredential } from '@/bridge'
import { isHostedAuthEnabled } from '@/utils/hostedAuth'

function warnAuth(context: string, error: unknown): void {
  const raw = error instanceof Error ? error.message : ''
  const kind = /^[a-z][a-z0-9_]{0,63}$/u.test(raw) ? raw : 'operation_failed'
  console.warn(`[auth] context=${context} error_kind=${kind}`)
}

export const useAuthStore = defineStore('auth', () => {
  const user = ref<{ email: string; customer_id: string } | null>(null)
  const token = ref('')
  const loading = ref(false)
  const error = ref<string | null>(null)

  const isLoggedIn = computed(() => !!token.value)

  // --- 凭据持久化 —— token 单一汇：Electron safeStorage ---
  //
  // 安全模型（review 2026-04-17 加固）：
  // - token 只有**一条**持久化路径：`setCredential('auth_token', ...)` → Electron safeStorage (DPAPI/keyring)
  // - customer_id / email 非敏感，localStorage 明文存储
  // - browser 环境无 safeStorage：token 只保留在内存 ref 中，刷新即失效（不再写 localStorage 明文旁路）

  const TOKEN_KEY = 'auth_token' as const

  /**
   * 保存凭据：token 仅入 safeStorage；customer_id/email 入 localStorage。
   * safeStorage 不可用时 token 仅驻内存，不再降级到明文存储。
   */
  async function saveCredentials(tokenVal: string, customerId: string, emailVal: string): Promise<void> {
    // token 仅走 safeStorage；失败就只留内存（ref）
    await setCredential(TOKEN_KEY, tokenVal)

    // 彻底清除任何历史明文旁路
    try {
      localStorage.removeItem('awp_token')
      localStorage.removeItem('awp_password')
    } catch (err) {
      warnAuth('saveCredentials: clear legacy plaintext keys from localStorage', err)
    }

    // customer_id 和 email 非敏感，localStorage 持久化
    try {
      localStorage.setItem('awp_customer_id', customerId)
      localStorage.setItem('awp_email', emailVal)
    } catch (err) {
      warnAuth('saveCredentials: persist customer_id/email to localStorage', err)
    }

    // Persist only the non-sensitive identifier through the desktop bridge.
    try {
      if (bridge) bridge.save_customer_id(customerId)
    } catch (err) {
      warnAuth('saveCredentials: bridge.save_customer_id', err)
    }
  }

  /**
   * 读取凭据：token 只从 safeStorage；customer_id/email 从 localStorage。
   * 返回 {token, customer_id, email} 或 null。
   */
  async function loadCredentials(): Promise<{ token: string; customer_id: string; email: string } | null> {
    // token 只认 safeStorage
    const candidateToken = (await getCredential(TOKEN_KEY)) || ''

    // customer_id/email 从 localStorage
    let candidateCustomerId = ''
    let candidateEmail = ''
    try {
      candidateCustomerId = localStorage.getItem('awp_customer_id') || ''
      candidateEmail = localStorage.getItem('awp_email') || ''
    } catch (err) {
      warnAuth('loadCredentials: read customer_id/email from localStorage', err)
    }

    // 如果 localStorage 没 customer_id/email，尝试一次性从 bridge.get_auth 读非 token 字段补齐
    // （老 auth.json 残留的 customer_id/email 迁移）
    if (!candidateCustomerId || !candidateEmail) {
      try {
        const b = await waitForBridge(3000)
        if (b) {
          const authData = await b.get_auth()
          if (authData) {
            candidateCustomerId = candidateCustomerId || authData.customer_id || ''
            candidateEmail = candidateEmail || authData.email || ''
          }
        }
      } catch (err) {
        warnAuth('loadCredentials: bridge.get_auth fallback', err)
      }
    }

    if (!candidateToken || !candidateCustomerId) return null
    return { token: candidateToken, customer_id: candidateCustomerId, email: candidateEmail }
  }

  // --- Actions ---

  async function login(email: string, password: string): Promise<boolean> {
    if (!isHostedAuthEnabled()) {
      error.value = 'hosted_auth_disabled'
      loading.value = false
      return false
    }
    loading.value = true
    error.value = null
    try {
      const res = await authApi.login(email, password)
      token.value = res.api_key
      user.value = { email, customer_id: res.customer_id }
      api.setToken(res.api_key)

      // Persist the token only when OS-backed encryption is available.
      await saveCredentials(res.api_key, res.customer_id, email)

      // Reload user-scoped data (threads, settings) for the new customer_id
      useChatStore().onUserChanged()
      useSettingsStore().loadSettings()

      return true
    } catch (err) {
      if (err instanceof ApiError) {
        error.value = err.detail
      } else {
        error.value = (err as Error).message || '登录失败'
      }
      return false
    } finally {
      loading.value = false
    }
  }

  async function register(
    email: string,
    password: string,
    username: string = '',
  ): Promise<boolean> {
    if (!isHostedAuthEnabled()) {
      error.value = 'hosted_auth_disabled'
      loading.value = false
      return false
    }
    loading.value = true
    error.value = null
    try {
      const res = await authApi.register(email, password, username)
      token.value = res.api_key
      user.value = { email, customer_id: res.customer_id }
      api.setToken(res.api_key)

      // Persist the token only when OS-backed encryption is available.
      await saveCredentials(res.api_key, res.customer_id, email)

      // Reload user-scoped data for the new customer_id
      useChatStore().onUserChanged()
      useSettingsStore().loadSettings()

      return true
    } catch (err) {
      if (err instanceof ApiError) {
        error.value = err.detail
      } else {
        error.value = (err as Error).message || '注册失败'
      }
      return false
    } finally {
      loading.value = false
    }
  }

  async function logout() {
    if (!isHostedAuthEnabled()) {
      clearAuth()
      return
    }
    await authApi.logout()
    clearAuth()
  }

  function clearAuth() {
    token.value = ''
    user.value = null
    api.setToken('')

    // Clear the encrypted token and non-sensitive local account metadata.
    deleteCredential(TOKEN_KEY).catch((err) => warnAuth('clearAuth: deleteCredential(auth_token)', err))
    // 兼容历史 key：旧版本用 'token'，新版用 'auth_token'
    deleteCredential('token').catch((err) => warnAuth('clearAuth: deleteCredential(legacy:token)', err))
    try {
      localStorage.removeItem('awp_token')
      localStorage.removeItem('awp_customer_id')
      localStorage.removeItem('awp_email')
      // 清理历史遗留的明文密码
      localStorage.removeItem('awp_password')
    } catch (err) {
      warnAuth('clearAuth: localStorage.removeItem', err)
    }
    // Reload stores with anonymous/global scope (customer_id now cleared)
    useChatStore().onUserChanged()
    useSettingsStore().loadSettings()
  }

  async function checkSession(): Promise<boolean> {
    if (!isHostedAuthEnabled()) return false
    if (token.value) return true
    // Token comes only from encrypted storage; localStorage carries non-sensitive metadata.
    const creds = await loadCredentials()
    if (!creds) return false

    let { token: candidateToken, customer_id: candidateCustomerId, email: candidateEmail } = creds

    // 服务端校验 token 有效性，防止过期/吊销的 token 静默使用。
    // 如果网络不可达，信任缓存 token（离线优先策略）。
    api.setToken(candidateToken)
    try {
      const validation = await authApi.validateToken()
      if (validation && validation.valid) {
        candidateCustomerId = validation.customer_id || candidateCustomerId
        candidateEmail = validation.email || candidateEmail
      } else if (validation && !validation.valid) {
        // 服务端明确拒绝 — 清除凭据并强制重新登录
        api.setToken('')
        clearAuth()
        return false
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        api.setToken('')
        clearAuth()
        return false
      }
      // 网络错误 — 信任缓存 token
    }

    // 恢复 session 状态
    token.value = candidateToken
    user.value = { email: candidateEmail, customer_id: candidateCustomerId }

    // 同步非敏感数据到 localStorage（customer_id/email）
    try {
      localStorage.setItem('awp_customer_id', candidateCustomerId)
      localStorage.setItem('awp_email', candidateEmail)
    } catch (err) {
      warnAuth('checkSession: sync customer_id/email to localStorage', err)
    }

    // Keep non-sensitive account metadata synchronized for the optional adapter.
    try {
      if (bridge) bridge.save_customer_id(candidateCustomerId)
    } catch (err) {
      warnAuth('checkSession: bridge.save_customer_id', err)
    }

    return true
  }

  function handleUnauthorized() {
    if (!isHostedAuthEnabled()) return
    clearAuth()
  }

  return {
    // State
    user,
    token,
    loading,
    error,
    // Computed
    isLoggedIn,
    // Actions
    login,
    register,
    logout,
    checkSession,
    handleUnauthorized,
    clearAuth,
  }
})
