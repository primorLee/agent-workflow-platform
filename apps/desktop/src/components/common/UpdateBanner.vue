<script setup lang="ts">
/**
 * Top-of-app auto-updater progress banner.
 *
 * Subscribes to IPC `updater:status` events from electron-updater and renders
 * one of: "checking", "available", "downloading (progress%)", or "ready".
 * Hidden when idle / not-available / error.
 *
 * "立即重启" button triggers quitAndInstall → APP closes, installer runs,
 * new version launches. "以后再说" hides the banner for the current session.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { UpdaterState } from '@/types/bridge'
import { waitForBridge } from '@/bridge'

const { t } = useI18n()

const state = ref<UpdaterState>({ phase: 'idle' })
const dismissed = ref(false)
let unsubscribe: (() => void) | null = null

onMounted(async () => {
  const bridge = await waitForBridge(3000)
  if (!bridge?.on_updater_status) return

  // Pull current state in case we mounted after the first broadcast
  if (bridge.get_updater_state) {
    try {
      const s = await bridge.get_updater_state()
      if (s) state.value = s
    } catch { /* bridge may not be ready yet */ }
  }

  unsubscribe = bridge.on_updater_status((s: UpdaterState) => {
    state.value = s
    // Any non-terminal transition re-shows the banner even if previously dismissed.
    if (s.phase === 'available' || s.phase === 'downloading' || s.phase === 'ready') {
      dismissed.value = false
    }
  })
})

onUnmounted(() => {
  if (unsubscribe) unsubscribe()
})

const visible = computed(() => {
  if (dismissed.value) return false
  const p = state.value.phase
  return p === 'checking' || p === 'available' || p === 'downloading' || p === 'ready'
})

const percent = computed(() => {
  if (state.value.phase !== 'downloading') return 0
  return Math.max(0, Math.min(100, state.value.percent ?? 0))
})

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatSpeed(bps: number): string {
  return `${formatBytes(bps)}/s`
}

const downloadSubtext = computed(() => {
  if (state.value.phase !== 'downloading') return ''
  const s = state.value
  return t('update.downloadSubtext', {
    transferred: formatBytes(s.transferred),
    total: formatBytes(s.total),
    speed: formatSpeed(s.bytes_per_second),
  })
})

async function onRestart() {
  const bridge = await waitForBridge(1500)
  if (!bridge?.updater_quit_install) return
  await bridge.updater_quit_install()
  // APP will exit; no need to update local state.
}

const downloading = ref(false)

async function onDownload() {
  if (downloading.value) return
  downloading.value = true
  try {
    const bridge = await waitForBridge(1500)
    if (!bridge?.updater_download) return
    const r = await bridge.updater_download()
    if (!r.ok) {
      console.warn('[updater] download click failed:', r.error)
    }
  } finally {
    downloading.value = false
  }
}

function onDismiss() {
  dismissed.value = true
}
</script>

<template>
  <Transition name="update-banner">
    <div v-if="visible" class="update-banner" :class="state.phase">
      <!-- Checking -->
      <template v-if="state.phase === 'checking'">
        <span class="dot spinning">↻</span>
        <span class="msg">{{ t('update.checking') }}</span>
      </template>

      <!-- Update found, not yet downloading -->
      <template v-else-if="state.phase === 'available'">
        <span class="dot">⬇</span>
        <span class="msg">{{ t('update.available', { version: state.version }) }}</span>
        <div class="actions">
          <button class="btn-restart" :disabled="downloading" @click="onDownload">
            {{ downloading ? t('update.downloadStarting') : t('update.downloadNow') }}
          </button>
          <button class="btn-later" @click="onDismiss">{{ t('update.later') }}</button>
        </div>
      </template>

      <!-- Downloading with progress bar -->
      <template v-else-if="state.phase === 'downloading'">
        <div class="progress-block">
          <div class="progress-row">
            <span class="dot">⬇</span>
            <span class="msg">{{ t('update.downloading', { percent: percent.toFixed(1) }) }}</span>
            <span class="subtext">{{ downloadSubtext }}</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill" :style="{ width: percent + '%' }" />
          </div>
        </div>
      </template>

      <!-- Ready to install -->
      <template v-else-if="state.phase === 'ready'">
        <span class="dot ready">✓</span>
        <span class="msg">{{ t('update.ready', { version: state.version }) }}</span>
        <div class="actions">
          <button class="btn-restart" @click="onRestart">{{ t('update.restartNow') }}</button>
          <button class="btn-later" @click="onDismiss">{{ t('update.later') }}</button>
        </div>
      </template>
    </div>
  </Transition>
</template>

<style scoped>
.update-banner {
  position: fixed;
  /* titleBarOverlay 占 36px（见 main.ts BrowserWindow.titleBarOverlay.height）
     + 12px 呼吸空间，避开 Windows 三合一窗口控制按钮（最小化/最大化/关闭） */
  top: 48px;
  left: 50%;
  transform: translateX(-50%);
  min-width: 360px;
  max-width: 80vw;
  padding: 10px 16px;
  border-radius: 10px;
  background: var(--card-bg, rgba(30, 30, 30, 0.96));
  color: var(--text, #fff);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.28);
  z-index: 9000;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  backdrop-filter: blur(12px);
}

.update-banner.checking { border-color: #6b7280; }
.update-banner.available { border-color: #3b82f6; }
.update-banner.downloading { border-color: #f59e0b; }
.update-banner.ready { border-color: #22c55e; }

.dot {
  font-size: 14px;
  opacity: 0.9;
  min-width: 16px;
  text-align: center;
}
.dot.spinning { animation: spin 1.6s linear infinite; display: inline-block; }
.dot.ready { color: #22c55e; }

.msg { font-weight: 500; }
.subtext { opacity: 0.72; font-variant-numeric: tabular-nums; margin-left: 6px; font-size: 12px; }

.progress-block { display: flex; flex-direction: column; gap: 6px; width: 100%; }
.progress-row { display: flex; align-items: center; gap: 8px; }
.progress-bar {
  width: 100%;
  height: 3px;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 2px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #f59e0b, #fbbf24);
  transition: width 0.2s linear;
}

.actions { margin-left: auto; display: flex; gap: 6px; }
.btn-restart {
  padding: 4px 12px;
  border-radius: 6px;
  border: none;
  background: #22c55e;
  color: white;
  font-size: 12px;
  cursor: pointer;
  font-weight: 500;
}
.btn-restart:hover { background: #16a34a; }
.btn-later {
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: transparent;
  color: var(--text-muted, #9ca3af);
  font-size: 12px;
  cursor: pointer;
}
.btn-later:hover { border-color: rgba(255, 255, 255, 0.32); }

@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

.update-banner-enter-active, .update-banner-leave-active { transition: transform 0.24s ease, opacity 0.24s ease; }
.update-banner-enter-from, .update-banner-leave-to { opacity: 0; transform: translate(-50%, -8px); }
</style>
