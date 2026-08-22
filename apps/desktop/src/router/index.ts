import { createRouter, createWebHashHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { isHostedAuthEnabled } from '@/utils/hostedAuth'
import { useSettingsStore } from '@/stores/settings'
import { api } from '@/api/client'

// Lab mode and hosted-account mode are independent. Lab removes the
// connection wizard; hosted authentication is available only after the exact
// main-process opt-in has been exposed by preload.
const isLabMode: boolean =
  (typeof window !== 'undefined' && window.__AWP_LAB_MODE === true) ||
  import.meta.env.VITE_LAB_MODE === '1'
const hostedAuthEnabled = isHostedAuthEnabled()

const disabledRoutes = new Set<string>()
if (isLabMode) disabledRoutes.add('setup')
if (!hostedAuthEnabled) disabledRoutes.add('login')

const allRoutes = [
  {
    path: '/setup',
    name: 'setup',
    component: () => import('@/views/ConnectionSetupView.vue'),
    meta: { requiresAuth: false, title: 'nav.setup' },
  },
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { requiresAuth: false, title: 'nav.login' },
  },
  {
    path: '/',
    name: 'chat',
    component: () => import('@/views/ChatView.vue'),
    meta: { title: 'nav.chat', requiresAuth: hostedAuthEnabled ? undefined : false },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@/views/SettingsView.vue'),
    meta: { title: 'nav.settings' },
  },
  {
    path: '/about',
    name: 'about',
    component: () => import('@/views/AboutView.vue'),
    meta: { title: 'nav.about' },
  },
]
const router = createRouter({
  history: createWebHashHistory(),
  routes: allRoutes.filter((r) => !disabledRoutes.has(r.name as string)),
})

router.beforeEach(async (to) => {
  const settings = useSettingsStore()
  if (!settings.loaded) await settings.loadSettings()
  if (settings.serverUrl && api.getBaseUrl() !== settings.serverUrl) {
    api.setBaseUrl(settings.serverUrl)
  }

  // Public builds are local/no-account by default. Filtered account routes
  // and stale bookmarks return to chat without reading credentials or making
  // hosted login/validation calls.
  if (!hostedAuthEnabled) {
    if (to.name === undefined || disabledRoutes.has(to.name as string)) {
      return { name: 'chat' }
    }
    return
  }

  const auth = useAuthStore()

  if (!settings.serverUrl && to.name !== 'setup') {
    return { name: 'setup' }
  }

  if (to.meta.requiresAuth !== false && !auth.isLoggedIn) {
    // Explicit hosted mode may restore its cached account session.
    if (api.getBaseUrl()) {
      const restored = await auth.checkSession()
      if (restored) {
        try {
          const { useChatStore } = await import('@/stores/chat')
          await useChatStore().fetchHistory()
        } catch { /* non-fatal */ }
        return
      }
    }
    return { name: 'login' }
  }
})

export default router
