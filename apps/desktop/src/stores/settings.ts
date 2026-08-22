import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import {
  bridge,
  isDesktop,
  waitForBridge,
  setCredential,
  getCredential,
  deleteCredential,
} from '@/bridge'
import { normalizeServiceBaseUrl } from '@/utils/service-base-url'

export type Theme = 'dark' | 'light'
export type Language = 'zh-CN' | 'en'

interface RemoteSettings {
  vmHost: string
  sshPort: number
  sshUser: string
  activeAgentId?: string
}

interface SettingsData {
  serverUrl?: string
  theme?: Theme
  language?: Language
  remote?: Partial<RemoteSettings>
}

const STORAGE_KEY_PREFIX = 'awp_settings'
const DEFAULT_REMOTE: RemoteSettings = {
  vmHost: '127.0.0.1',
  sshPort: 2222,
  sshUser: '',
}

function storageKey(): string {
  try {
    const customerId = localStorage.getItem('awp_customer_id')
    if (customerId) return `${STORAGE_KEY_PREFIX}_${customerId}`
  } catch { /* localStorage may be disabled */ }
  return STORAGE_KEY_PREFIX
}

export const useSettingsStore = defineStore('settings', () => {
  const serverUrl = ref(
    normalizeServiceBaseUrl(import.meta.env.VITE_AWP_CHAT_ADAPTER_URL)
      ?? 'http://127.0.0.1:8787',
  )
  const theme = ref<Theme>('light')
  const language = ref<Language>('zh-CN')
  const loaded = ref(false)
  const showSettingsPanel = ref(false)

  const vmHost = ref(DEFAULT_REMOTE.vmHost)
  const sshPort = ref(DEFAULT_REMOTE.sshPort)
  const sshUser = ref(DEFAULT_REMOTE.sshUser)
  const sshPassword = ref('')


  function applyData(data: SettingsData): void {
    if (typeof data.serverUrl === 'string' && data.serverUrl) {
      const normalized = normalizeServiceBaseUrl(data.serverUrl)
      if (normalized) serverUrl.value = normalized
    }
    if (data.theme === 'dark' || data.theme === 'light') theme.value = data.theme
    if (data.language === 'zh-CN' || data.language === 'en') language.value = data.language

    const remote = data.remote
    if (!remote) return
    if (typeof remote.vmHost === 'string') vmHost.value = remote.vmHost
    if (typeof remote.sshPort === 'number' && Number.isFinite(remote.sshPort)) {
      sshPort.value = remote.sshPort
    }
    if (typeof remote.sshUser === 'string') sshUser.value = remote.sshUser
  }

  async function readPersisted(): Promise<SettingsData | null> {
    try {
      const b = bridge ?? await waitForBridge(1500)
      if (b?.load_settings) {
        const customerId = localStorage.getItem('awp_customer_id') || undefined
        const saved = await b.load_settings(customerId)
        if (saved && typeof saved === 'object') return saved as SettingsData
      }
    } catch { /* bridge unavailable */ }

    try {
      const key = storageKey()
      const scoped = localStorage.getItem(key)
      if (scoped) return JSON.parse(scoped) as SettingsData
      if (key !== STORAGE_KEY_PREFIX) {
        const legacy = localStorage.getItem(STORAGE_KEY_PREFIX)
        if (legacy) return JSON.parse(legacy) as SettingsData
      }
    } catch { /* missing or malformed local state */ }
    return null
  }

  async function loadSettings(): Promise<void> {
    const data = await readPersisted()
    if (data) applyData(data)

    try {
      const savedPassword = await getCredential('sshPassword')
      if (savedPassword) sshPassword.value = savedPassword
    } catch { /* safeStorage unavailable in browser-only mode */ }

    applyTheme()
    applyLanguage()
    loaded.value = true

    // pywebview injects its bridge after page load; re-read once it arrives.
    if (!isDesktop && typeof window !== 'undefined') {
      window.addEventListener('pywebviewready', async () => {
        const lateData = await readPersisted()
        if (lateData) applyData(lateData)
        applyTheme()
        applyLanguage()
      }, { once: true })
    }
  }

  async function saveSettings(): Promise<void> {
    const normalizedServerUrl = normalizeServiceBaseUrl(serverUrl.value)
    if (!normalizedServerUrl) return
    serverUrl.value = normalizedServerUrl
    const data: SettingsData = {
      serverUrl: normalizedServerUrl,
      theme: theme.value,
      language: language.value,
      remote: {
        vmHost: vmHost.value,
        sshPort: sshPort.value,
        sshUser: sshUser.value,
      },
    }

    try {
      const b = bridge ?? await waitForBridge(1000)
      if (b?.save_settings) {
        const customerId = localStorage.getItem('awp_customer_id') || undefined
        await b.save_settings(data, customerId)
      }
    } catch { /* browser fallback below remains authoritative */ }

    try { localStorage.setItem(storageKey(), JSON.stringify(data)) } catch { /* disabled */ }

    if (sshPassword.value) {
      await setCredential('sshPassword', sshPassword.value).catch(() => {})
    } else {
      await deleteCredential('sshPassword').catch(() => {})
    }
  }

  function applyTheme(): void {
    if (typeof document === 'undefined') return
    document.documentElement.setAttribute('data-theme', theme.value)
    document.documentElement.classList.toggle('dark', theme.value === 'dark')
  }

  function applyLanguage(): void {
    if (typeof document === 'undefined') return
    document.documentElement.setAttribute('lang', language.value)
  }

  function setTheme(next: Theme): void {
    theme.value = next
    applyTheme()
  }

  function setLanguage(next: Language): void {
    language.value = next
    applyLanguage()
  }

  function setServerUrl(next: string): boolean {
    const normalized = normalizeServiceBaseUrl(next)
    if (!normalized) return false
    serverUrl.value = normalized
    return true
  }

  function resetRemoteDefaults(): void {
    vmHost.value = DEFAULT_REMOTE.vmHost
    sshPort.value = DEFAULT_REMOTE.sshPort
    sshUser.value = DEFAULT_REMOTE.sshUser
    sshPassword.value = ''
  }

  watch(
    [serverUrl, theme, language, vmHost, sshPort, sshUser, sshPassword],
    () => { if (loaded.value) void saveSettings() },
  )

  return {
    serverUrl,
    theme,
    language,
    loaded,
    showSettingsPanel,
    vmHost,
    sshPort,
    sshUser,
    sshPassword,
    loadSettings,
    saveSettings,
    setTheme,
    setLanguage,
    setServerUrl,
    resetRemoteDefaults,
    applyTheme,
    applyLanguage,
  }
})