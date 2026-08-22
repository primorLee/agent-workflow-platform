<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useChatStore } from '@/stores/chat'
import { useSettingsStore } from '@/stores/settings'
import { useToastStore } from '@/stores/toast'
import { isHostedAuthEnabled } from '@/utils/hostedAuth'

declare const __APP_VERSION__: string
const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'

const { t } = useI18n()
const router = useRouter()
const chatStore = useChatStore()
const settings = useSettingsStore()
const toast = useToastStore()
import { useAuthStore } from '@/stores/auth'
const auth = useAuthStore()
const hostedAuthEnabled = isHostedAuthEnabled()

const SIDEBAR_COLLAPSED_KEY = 'awp_sidebar_collapsed'
function _loadCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}
const collapsed = ref(_loadCollapsed())

interface Thread {
  id: string
  title: string
  time: string
  active?: boolean
}

const threads = computed<Thread[]>(() => {
  if (chatStore.threads && chatStore.threads.length > 0) {
    type StoredThread = {
      id: string
      title?: string
      name?: string
      updated_at?: string
      created_at?: string
    }
    return (chatStore.threads as StoredThread[]).map((t) => ({
      id: t.id,
      title: t.title || t.name || 'Untitled',
      time: formatRelativeTime(t.updated_at || t.created_at || ''),
      active: t.id === chatStore.activeThreadId,
    }))
  }
  return []
})

const searchQuery = ref('')
const searchActive = ref(false)
const filteredThreads = computed<Thread[]>(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return threads.value
  return threads.value.filter((thr) => thr.title.toLowerCase().includes(q))
})

const isDark = computed(() => settings.theme === 'dark')

function formatRelativeTime(iso: string): string {
  if (!iso) return '--'
  const d = new Date(iso)
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return t('time.justNow')
  if (diff < 3600_000) return t('time.minutes', { n: Math.floor(diff / 60_000) })
  if (diff < 86400_000) return t('time.hours', { n: Math.floor(diff / 3600_000) })
  if (diff < 604800_000) return t('time.days', { n: Math.floor(diff / 86400_000) })
  return t('time.weeks', { n: Math.floor(diff / 604800_000) })
}

function selectThread(id: string) {
  chatStore.selectThread(id)
  // If the user is currently on Settings / Optimization / VM ops / any
  // non-chat view, picking a thread from the sidebar should take them to
  // the chat surface where the thread is actually rendered. Otherwise the
  // selection is invisible — the bug user reported 2026-05-19.
  if (router.currentRoute.value.name !== 'chat') {
    void router.push({ name: 'chat' })
  }
}

function newThread() {
  chatStore.createThread()
  // Same reason as selectThread: "new chat" from any view must land the
  // user on the chat view, otherwise the thread is created invisibly and
  // the user thinks the button is broken.
  if (router.currentRoute.value.name !== 'chat') {
    void router.push({ name: 'chat' })
  }
}

async function confirmDeleteThread(id: string, ev: Event) {
  ev.stopPropagation()
  ev.preventDefault()
  const msg = t('sidebar.deleteThreadConfirm')
  if (!window.confirm(msg)) return
  try {
    await chatStore.deleteThread(id)
  } catch (err) {
    toast.error(t('sidebar.deleteThreadFailed', { msg: (err as Error).message || '' }))
  }
}

function toggleCollapse() {
  collapsed.value = !collapsed.value
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed.value ? '1' : '0')
  } catch { /* localStorage unavailable — in-memory only */ }
}

function toggleTheme() {
  settings.setTheme(isDark.value ? 'light' : 'dark')
}

function openSettings() {
  router.push('/settings').catch(() => { /* same-page navigation ignore */ })
}

// 1.7.57: goOptimization dropped together with the 优化任务 sidebar button.


async function doLogout() {
  if (!hostedAuthEnabled) return
  const who = auth.user?.email || t('auth.currentUser') || ''
  const msg = who
    ? t('auth.confirmLogoutNamed', { user: who }, { default: `确定退出登录 ${who} 吗？` }) as string
    : (t('auth.confirmLogout', {}, { default: '确定退出当前账号吗？' }) as string)
  if (!window.confirm(msg)) return
  auth.clearAuth()
  void auth.logout().catch(() => { /* already cleared locally */ })
  await router.push('/login')
}
</script>

<template>
  <aside class="sidebar" :class="{ collapsed }">
    <!-- Brand header -->
    <div class="brand">
      <div class="brand-mark" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">
          <path d="M12 2.5 L20.5 7 V17 L12 21.5 L3.5 17 V7 Z" />
          <path d="M12 7 L17 9.5 V14.5 L12 17 L7 14.5 V9.5 Z" />
          <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
        </svg>
      </div>
      <span v-if="!collapsed" class="brand-title">{{ t('sidebar.brandLabel') }}</span>
      <button
        class="brand-collapse"
        @click="toggleCollapse"
        :title="collapsed ? t('sidebar.expandSidebar') : t('sidebar.collapseSidebar')"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
          <line x1="9.5" y1="4" x2="9.5" y2="20" />
        </svg>
      </button>
    </div>

    <!-- Primary: new thread -->
    <button
      class="new-thread-btn"
      @click="newThread"
      :title="t('sidebar.newThread')"
    >
      <svg class="new-thread-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
      <span v-if="!collapsed" class="new-thread-label">{{ t('sidebar.newThread') }}</span>
      <span v-if="!collapsed" class="new-thread-kbd">{{ t('sidebar.newThreadShortcut') }}</span>
    </button>

    <!-- Threads section — search input removed per maintainer v1.7 2nd pass spec,
         only the magnifier icon-button remains. Icon click focuses a hidden
         input so existing `searchQuery`-driven filter still works when a user
         wants to search; default (no query) shows the full thread list. -->
    <div class="section threads" v-if="!collapsed">
      <div class="section-header">
        <span class="section-title">{{ t('sidebar.threadsHeader') }}</span>
        <button
          class="search-icon-btn"
          :title="t('sidebar.threadsSearch')"
          :aria-label="t('sidebar.threadsSearch')"
          @click="searchActive = !searchActive"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="7" /><line x1="16.5" y1="16.5" x2="21" y2="21" />
          </svg>
        </button>
      </div>
      <div v-if="searchActive" class="search-wrap-inline">
        <input
          v-model="searchQuery"
          class="search-input"
          type="search"
          :placeholder="t('sidebar.threadsSearch')"
          :aria-label="t('sidebar.threadsSearch')"
        />
      </div>
      <div class="folder-label" aria-hidden="true">AGENT-WORKFLOW-PLATFORM</div>
      <div class="thread-list">
        <div
          v-for="thread in filteredThreads"
          :key="thread.id"
          class="thread-item"
          :class="{ active: thread.active }"
          role="button"
          tabindex="0"
          @click="selectThread(thread.id)"
          @keydown.enter="selectThread(thread.id)"
        >
          <svg class="thread-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          <span class="thread-title">{{ thread.title }}</span>
          <span class="thread-time">{{ thread.time }}</span>
          <button
            class="thread-delete-btn"
            :title="t('sidebar.deleteThread')"
            :aria-label="t('sidebar.deleteThread')"
            @click="confirmDeleteThread(thread.id, $event)"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6M14 11v6"/>
              <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Collapsed: just icons -->
    <div class="thread-list-collapsed" v-else>
      <button
        v-for="thread in threads"
        :key="thread.id"
        class="thread-icon-btn"
        :class="{ active: thread.active }"
        :title="thread.title"
        @click="selectThread(thread.id)"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      </button>
    </div>

    <!-- Tools & Settings section -->
    <!-- `sidebar-footer` class retained as alias for existing e2e specs
         (sidebar-buttons-real / optimization-vm-views / i18n-switch / etc).
         Prefer `.section.tools` for new tests. -->
    <div class="section tools sidebar-footer">
      <div v-if="!collapsed" class="section-divider">
        <span class="section-title">{{ t('sidebar.toolsHeader') }}</span>
      </div>



      <!-- Theme: shown as a row with an actual switch control -->
      <button
        class="tool-item footer-item theme-row"
        @click="toggleTheme"
        :title="isDark ? t('sidebar.switchToLight') : t('sidebar.switchToDark')"
      >
        <svg v-if="isDark" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>
        </svg>
        <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="4.5"/>
          <line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/>
          <line x1="4.5" y1="4.5" x2="5.9" y2="5.9"/><line x1="18.1" y1="18.1" x2="19.5" y2="19.5"/>
          <line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/>
          <line x1="4.5" y1="19.5" x2="5.9" y2="18.1"/><line x1="18.1" y1="5.9" x2="19.5" y2="4.5"/>
        </svg>
        <span v-if="!collapsed" class="tool-label">{{ t('sidebar.lightMode') }}</span>
        <span v-if="!collapsed" class="switch" :class="{ on: !isDark }" aria-hidden="true">
          <span class="switch-knob"></span>
        </span>
      </button>

      <!-- 1.7.57 removed: 通知 sidebar button (低 ROI; AI 主动 toast/上报已经覆盖). -->


      <button class="tool-item footer-item" @click="openSettings" :title="t('sidebar.settings')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
        </svg>
        <span v-if="!collapsed">{{ t('sidebar.settings') }}</span>
      </button>

      <button v-if="hostedAuthEnabled && auth.isLoggedIn" class="tool-item footer-item tool-logout footer-logout" @click="doLogout" :title="t('auth.logout')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
          <polyline points="16 17 21 12 16 7"/>
          <line x1="21" y1="12" x2="9" y2="12"/>
        </svg>
        <span v-if="!collapsed">{{ t('auth.logout') }}</span>
      </button>
    </div>

    <!-- Footer status — real app version + real auth-based online/offline. -->
    <div v-if="!collapsed" class="footer-status">
      <span class="footer-version">v{{ appVersion }}</span>
      <span class="footer-dot" aria-hidden="true"></span>
      <span class="footer-online" :class="{ offline: hostedAuthEnabled && !auth.isLoggedIn }">
        <span class="status-dot" :class="{ offline: hostedAuthEnabled && !auth.isLoggedIn }"></span>
        {{ hostedAuthEnabled
          ? (auth.isLoggedIn ? t('sidebar.online') : t('sidebar.offline'))
          : t('sidebar.localMode') }}
      </span>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: 100%;
  height: 100%;
  background: var(--panel-bg);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  padding: 0;
  transition: width 0.2s ease;
  gap: 0;
  font-family: var(--font-sans);
  border: 1px solid var(--border);
  border-radius: var(--radius-panel);
  box-shadow: var(--shadow-soft);
  -webkit-app-region: no-drag;
  overflow: hidden;
}
.sidebar.collapsed {
  width: 64px;
  padding: 14px 8px 12px;
}

/* ========== Brand ========== */
.brand {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 20px 20px 16px;
  border-bottom: 1px solid var(--border-soft);
}
.brand-mark {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel-bg);
}
.brand-title {
  flex: 1;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.brand-collapse {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel-bg);
  color: var(--icon-muted);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.brand-collapse:hover {
  background: var(--panel-soft);
}
.sidebar.collapsed .brand {
  justify-content: center;
  padding: 2px 0 8px;
}

/* ========== Primary: New thread ========== */
.new-thread-btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 16px 20px 20px;
  height: 48px;
  padding: 0 14px 0 16px;
  border: none;
  border-radius: 14px;
  background: var(--primary);
  color: #fff;
  font-family: var(--font-sans);
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: none;
  transition: background 0.15s;
}
.new-thread-btn:hover {
  background: var(--primary-hover);
}
.new-thread-icon {
  color: #fff;
  margin-right: 10px;
  flex-shrink: 0;
}
.new-thread-label {
  flex: 1;
  text-align: left;
  font-size: 16px;
  font-weight: 600;
}
.new-thread-kbd {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 8px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.18);
  color: rgba(255, 255, 255, 0.92);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  flex-shrink: 0;
}
.sidebar.collapsed .new-thread-btn {
  justify-content: center;
  padding: 0;
  width: 40px;
  height: 40px;
  margin: 0 auto;
}

/* ========== Section ========== */
.section {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
}
.section.threads {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 0 12px;
}
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 8px 10px;
}
.section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  letter-spacing: normal;
  text-transform: none;
  user-select: none;
}
.search-icon-btn {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--icon-muted);
  cursor: pointer;
  transition: background 0.15s;
}
.search-icon-btn:hover {
  background: var(--panel-soft);
}
.search-wrap-inline {
  padding: 0 4px 8px;
}
.search-input {
  width: 100%;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  outline: none;
  background: var(--panel-soft);
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: 13px;
  transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
}
.search-input:focus {
  background: var(--panel-bg);
  border-color: rgba(91, 123, 234, 0.32);
  box-shadow: 0 0 0 3px rgba(91, 123, 234, 0.10);
}
.search-input::placeholder {
  color: var(--text-tertiary);
}
.search-input::-webkit-search-cancel-button { display: none; }

.section-divider {
  margin: 6px 4px 4px;
  padding: 8px 6px 6px;
  border-top: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
}

.folder-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-placeholder);
  padding: 2px 8px 4px;
  letter-spacing: 0.08em;
  user-select: none;
  display: none; /* Keep legacy element for DOM-stable tests but hide visually */
}

/* ========== Thread list ========== */
.thread-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0 2px;
  overflow-y: auto;
  overflow-x: hidden;
}
.thread-list::-webkit-scrollbar { width: 6px; }
.thread-list::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 3px;
}
.thread-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 44px;
  padding: 0 12px;
  border: 1px solid transparent;
  border-radius: 12px;
  background: transparent;
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
  text-align: left;
  position: relative;
}
.thread-item:hover {
  background: #F7F9FD;
}
.thread-item.active {
  background: var(--panel-blue-soft);
  border-color: transparent;
}
.thread-icon {
  flex-shrink: 0;
  color: var(--icon-muted);
  width: 16px;
  height: 16px;
}
.thread-item.active .thread-icon {
  color: var(--primary);
}
.thread-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.thread-time {
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 400;
  color: var(--text-tertiary);
  transition: opacity 0.12s;
  font-variant-numeric: tabular-nums;
  margin-left: auto;
}
.thread-item.active .thread-time {
  color: var(--text-secondary);
}
.thread-delete-btn {
  flex-shrink: 0;
  display: none;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-left: 2px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0;
  transition: background 0.12s, color 0.12s;
}
.thread-delete-btn:hover {
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
}
.thread-delete-btn:focus-visible {
  outline: 1px solid var(--border-strong, var(--border));
  outline-offset: 1px;
}
.thread-item:hover .thread-delete-btn,
.thread-item:focus-within .thread-delete-btn {
  display: inline-flex;
}
.thread-item:hover .thread-time,
.thread-item:focus-within .thread-time {
  opacity: 0;
}

.thread-list-collapsed {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  overflow-y: auto;
  padding: 4px 0;
}
.thread-icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.thread-icon-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.thread-icon-btn.active {
  background: var(--sidebar-active-bg);
  color: var(--primary);
}

/* ========== Tools ========== */
.section.tools {
  flex-shrink: 0;
  margin-top: auto;
  padding: 16px 20px 0;
  border-top: 1px solid var(--border-soft);
}
.section.tools .section-divider {
  margin: 0 0 10px;
  padding: 0;
  border: none;
}
.section.tools .section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: none;
  letter-spacing: normal;
}
.tool-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 40px;
  padding: 0 10px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-sans);
  font-size: 13px;
  font-weight: 400;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
  text-align: left;
}
.tool-item {
  border-radius: 10px;
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 500;
}
.tool-item:hover {
  background: var(--panel-soft);
}
.tool-item > svg {
  color: var(--icon-muted);
  flex-shrink: 0;
  width: 16px;
  height: 16px;
}
.tool-item .tool-label {
  flex: 1;
}
.tool-icon-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.unread-badge {
  position: absolute;
  top: -6px;
  right: -8px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: #ef4444;
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  text-align: center;
  pointer-events: none;
  box-shadow: 0 0 0 2px var(--panel-bg);
}

/* ========== Theme switch (spec: 36*20, knob 16px white, on=primary) ========== */
.theme-row {
  position: relative;
}
.switch {
  flex-shrink: 0;
  width: 36px;
  height: 20px;
  border-radius: 999px;
  background: var(--border-strong);
  position: relative;
  transition: background 0.18s ease;
  margin-left: auto;
}
.switch-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.18);
  transition: left 0.18s ease;
}
.switch.on {
  background: var(--primary);
}
.switch.on .switch-knob {
  left: 18px;
}

/* ========== Collapsed overrides ========== */
.sidebar.collapsed .tool-item {
  justify-content: center;
  padding: 0;
  width: 40px;
  height: 40px;
  margin: 0 auto;
}
.sidebar.collapsed .tool-item span,
.sidebar.collapsed .tool-item .tool-label,
.sidebar.collapsed .tool-item .switch {
  display: none;
}

/* ========== Footer ========== */
.footer-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px 18px;
  font-size: 12px;
  color: var(--text-tertiary);
}
.footer-version {
  font-size: 12px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}
.footer-dot {
  width: 2px;
  height: 2px;
  border-radius: 50%;
  background: var(--text-placeholder);
}
.footer-online {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
  font-size: 12px;
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--success);
}

.tool-logout {
  color: var(--text-secondary);
}
.tool-logout:hover {
  background: rgba(239, 68, 68, 0.08);
  color: #d93025;
}
.tool-logout:hover > svg {
  color: #d93025;
}
</style>
