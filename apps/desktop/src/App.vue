<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { isHostedAuthEnabled } from '@/utils/hostedAuth'
import { useRoute } from 'vue-router'
import { useKeyboardShortcuts } from '@/composables/useKeyboardShortcuts'
import { useAwpIdeBridge } from '@/composables/useAwpIdeBridge'
import { useSettingsStore } from '@/stores/settings'
import { useAuthStore } from '@/stores/auth'
import { useConnectionStore } from '@/stores/connection'
import { useArtifactStore } from '@/stores/artifact'
import { api, bindConnectionStore } from '@/api/client'
import ErrorBoundary from '@/components/common/ErrorBoundary.vue'
import NotificationToast from '@/components/common/NotificationToast.vue'
import CommandPalette from '@/components/common/CommandPalette.vue'
import KeyboardShortcuts from '@/components/common/KeyboardShortcuts.vue'
import AppSidebar from '@/components/layout/AppSidebar.vue'
import ArtifactPanel from '@/components/artifact/ArtifactPanel.vue'
import ToastContainer from '@/components/common/ToastContainer.vue'
import UpdateBanner from '@/components/common/UpdateBanner.vue'
import MaintenanceBanner from '@/components/common/MaintenanceBanner.vue'
import HostKeyMismatchToast from '@/components/common/HostKeyMismatchToast.vue'
import ConnectionStatusDot from '@/components/common/ConnectionStatusDot.vue'
import CcRuntimeProgressBanner from '@/components/common/CcRuntimeProgressBanner.vue'
// ConnectionHealth removed from App.vue in v1.5.8 — see the usage site below
// for the rationale. The component file is kept in the codebase so we can
// bring it back in a later release if support needs it again.

const { t } = useI18n()
const route = useRoute()
useKeyboardShortcuts()
// Wire the real local MCP notification event and validated artifact focus.
useAwpIdeBridge()
const settings = useSettingsStore()
const auth = useAuthStore()
const connection = useConnectionStore()
const artifactStore = useArtifactStore()
// ── Resizable split between chat and artifact ──
const artifactWidth = ref(480)
let isResizing = false
let resizeStartX = 0
let resizeStartW = 0

function onResizeStart(e: PointerEvent) {
  isResizing = true
  resizeStartX = e.clientX
  resizeStartW = artifactWidth.value
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
}
function onResizeMove(e: PointerEvent) {
  if (!isResizing) return
  const dx = resizeStartX - e.clientX // drag left = bigger panel
  artifactWidth.value = Math.max(300, Math.min(900, resizeStartW + dx))
}
function onResizeEnd(e: PointerEvent) {
  if (!isResizing) return
  isResizing = false
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
}

// ADR-014a Lab mode flag — set by electron/preload.ts. Lab APP has no login
// flow, so auth.isLoggedIn never goes true; we still need the sidebar / app
// chrome to render around ChatView.
const isLabMode: boolean = typeof window !== 'undefined' &&
  window.__AWP_LAB_MODE === true
const hostedAuthEnabled = isHostedAuthEnabled()

const showChrome = computed(() => {
  if (!hostedAuthEnabled) {
    return route.name !== 'setup' && route.name !== 'login'
  }
  return auth.isLoggedIn && route.name !== 'setup' && route.name !== 'login'
})

onMounted(async () => {

  // In kiosk/lab mode, close a persisted artifact panel so the chat input
  // starts unobstructed for the next local session.
  if (isLabMode) {
    try { artifactStore.close() } catch { /* store init race — non-fatal */ }
  }

  await settings.loadSettings()
  document.documentElement.setAttribute('data-theme', settings.theme)

  // Set API base URL before anything tries to use it
  if (settings.serverUrl) {
    api.setBaseUrl(settings.serverUrl)
  }

  // Wire API client ↔ connection store and start health polling
  const { connected: connectedRef } = storeToRefs(connection)
  bindConnectionStore({ connected: connectedRef })

  // Only start health polling if we have a server URL
  if (api.getBaseUrl()) {
    connection.startHealthPolling()
  }

  // Cache provider-neutral runtime availability for local CLI routing and
  // capability headers. Missing or disabled configuration fails closed.
  const w = window as unknown as { __CC_LOCAL_RUNTIME_AVAILABLE?: boolean }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const electronAPI = (window as any).electronAPI
    if (electronAPI && typeof electronAPI.cc_runtime_status === 'function') {
      const status = await electronAPI.cc_runtime_status()
      w.__CC_LOCAL_RUNTIME_AVAILABLE = status?.available === true
    } else {
      w.__CC_LOCAL_RUNTIME_AVAILABLE = false
    }

    if (electronAPI && typeof electronAPI.on_cc_runtime_installed === 'function') {
      electronAPI.on_cc_runtime_installed(() => {
        w.__CC_LOCAL_RUNTIME_AVAILABLE = true
      })
    }
  } catch {
    w.__CC_LOCAL_RUNTIME_AVAILABLE = false
  }

})

</script>

<template>
  <div
    class="app"
    :class="{
      'has-chrome': showChrome,
      'artifact-open': artifactStore.isOpen,
      'artifact-maximized': artifactStore.isMaximized,
    }"
  >
    <div class="titlebar-drag">
      <!-- SSE connection indicator — pinned to the top-right of the
           Electron titlebar. Always mounted so users see status even on
           the login / setup screens. The component opts out of the drag
           region so tooltips remain interactive. -->
      <ConnectionStatusDot class="titlebar-status-dot" />
    </div>
    <!-- 1.7.41 — AI 引擎 (cc-runtime tarball) 首次下载进度横幅. 自隐藏:
         stage=done / dismissed=true 时不显示. Mount 在顶层确保 login /
         setup / chat 任何页面都能看到. -->
    <CcRuntimeProgressBanner />
    <AppSidebar v-if="showChrome" />
    <div class="app-main">
      <main class="app-content">
        <ErrorBoundary>
          <RouterView />
        </ErrorBoundary>
      </main>
    </div>
    <Transition name="artifact-shell">
      <div v-if="artifactStore.isOpen && route.name !== 'login'" class="artifact-shell">
        <div
          v-if="!artifactStore.isMaximized"
          class="resize-handle"
          @pointerdown="onResizeStart"
          @pointermove="onResizeMove"
          @pointerup="onResizeEnd"
        ></div>
        <ArtifactPanel
          :style="artifactStore.isMaximized
            ? { width: '100%', minWidth: '100%' }
            : { width: artifactWidth + 'px', minWidth: artifactWidth + 'px' }"
        />
      </div>
    </Transition>
    <NotificationToast />
    <ToastContainer />
    <UpdateBanner />
    <MaintenanceBanner />
    <HostKeyMismatchToast />
    <!-- ConnectionHealth popover removed in v1.5.8 — real-time status /
         transport / events were visual noise for most users. Connection
         health is now only surfaced on demand via the settings slide-over's
         "连接 VM" button (which shows latency or an inline error). -->
    <!-- <ConnectionHealth v-if="showChrome" /> -->

    <CommandPalette />
    <KeyboardShortcuts />
  </div>
</template>

<style>
@import '@/styles/variables.css';
@import '@/styles/base.css';
</style>

<style scoped>
/* v1.6.6 UI port — production desktop shell extraction.
 * Outer frame: 3-col window with 244px sidebar | 1fr main | 340px preview,
 * 10px gap, 14px panel radius, flush against a 36px Electron titlebar. */
.app {
  --app-bg: oklch(0.955 0.004 252);
  --sidebar-bg: oklch(0.976 0.004 252);
  --panel-bg: #ffffff;
  --border: oklch(0.922 0.005 252);
  --border-soft: oklch(0.955 0.004 252);
  --primary: oklch(0.58 0.145 255);
  --primary-hover: oklch(0.50 0.14 258);
  --primary-soft: oklch(0.965 0.020 255);
  --primary-soft-2: oklch(0.935 0.035 255);
  --brand-ink: oklch(0.40 0.12 258);
  --text-primary: oklch(0.24 0.012 252);
  --text-secondary: oklch(0.44 0.012 252);
  --text-tertiary: oklch(0.62 0.010 252);
  --chip-bg: oklch(0.96 0.005 252);

  display: grid;
  grid-template-columns: 244px minmax(0, 1fr) 340px;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: var(--app-bg);
  color: var(--text-primary);
  padding: 36px 10px 10px;
  gap: 10px;
  position: relative;
  font-family: 'Inter', 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif;
}

.app:not(.artifact-open) {
  grid-template-columns: 244px minmax(0, 1fr);
}

.app.artifact-maximized {
  grid-template-columns: 1fr;
}
.app.artifact-maximized .sidebar,
.app.artifact-maximized .app-main {
  display: none;
}

.titlebar-drag {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 36px;
  -webkit-app-region: drag;
  z-index: 9999;
  background: var(--app-bg, oklch(0.955 0.004 252));
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding-right: 12px;
  /* Give the status dot a comfortable buffer from the Windows native
   * min/max/close controls on the right edge (roughly 140px wide). */
  padding-inline-end: 148px;
}

.titlebar-status-dot {
  /* The dot itself manages its own no-drag region; this just ensures the
   * hover target sits flush-right inside the titlebar flex row. */
  margin-left: auto;
}

.app-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  background: var(--panel-bg);
  border-radius: 12px;
  border: 1px solid var(--border);
  box-shadow: none;
}

.app-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  border-radius: inherit;
}

.artifact-shell {
  display: flex;
  min-width: 0;
  height: 100%;
  border-radius: 12px;
  border: 1px solid var(--border);
  box-shadow: none;
  overflow: hidden;
  background: var(--panel-bg);
}

.app.artifact-maximized .app-main {
  display: none;
}

.app:not(.has-chrome) {
  grid-template-columns: 1fr;
  justify-items: center;
  align-items: center;
}

.app:not(.has-chrome) .app-main,
.app:not(.has-chrome) .app-content {
  max-width: 480px;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.resize-handle {
  width: 4px;
  background: transparent;
  cursor: col-resize;
  flex-shrink: 0;
  transition: background 0.15s;
  margin-left: -4px;
  position: relative;
  z-index: 2;
}

.resize-handle::before {
  content: '';
  position: absolute;
  left: 1px;
  right: 1px;
  top: 25%;
  bottom: 25%;
  border-radius: 2px;
  background: transparent;
  transition: background 0.15s;
}

.resize-handle:hover::before,
.resize-handle:active::before {
  background: var(--border-strong);
}

.artifact-shell-enter-active,
.artifact-shell-leave-active {
  transition: opacity 0.15s ease;
}

.artifact-shell-enter-from,
.artifact-shell-leave-to {
  opacity: 0;
}

</style>
