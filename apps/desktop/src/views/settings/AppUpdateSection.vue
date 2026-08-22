<script setup lang="ts">
/**
 * AppUpdateSection — Settings panel surface for the Electron auto-updater.
 *
 * Why this exists alongside CcRuntimeSection: CcRuntimeSection updates the
 * AI engine bundled inside the app. AppUpdateSection updates the app
 * shell itself (NSIS-installed AgentWorkflowPlatform.exe). Two distinct upgrade
 * channels — keeping them in separate components avoids the confusion
 * the user reported where the "checking-update" banner flashed by too
 * fast to see.
 *
 * Behaviour:
 *   - Mount → pull current snapshot via bridge.get_updater_state()
 *   - Subscribe to bridge.on_updater_status() for live phase updates
 *   - "检查更新" button → bridge.updater_check_now() (synchronous IPC,
 *     status flows back asynchronously via the same subscription)
 *   - When phase === 'ready' → show "立即重启" button calling
 *     bridge.updater_quit_install()
 *   - Renders inline, not a transient banner, so the user can always
 *     read the current status no matter how brief the underlying check
 *     was.
 */
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { bridge } from '@/bridge'
import type { UpdaterState } from '@/types/bridge'

declare const __APP_VERSION__: string

const { t } = useI18n()

const state = ref<UpdaterState>({ phase: 'idle' })
const busy = ref(false)
const errorMsg = ref('')
let unsubscribe: (() => void) | null = null

// Hide entire section on non-Electron runtimes (pywebview / browser dev).
const supported = computed(() => typeof bridge?.updater_check_now === 'function')

const phaseLabel = computed(() => {
  switch (state.value.phase) {
    case 'idle': return t('settings.appUpdate.idle')
    case 'checking': return t('settings.appUpdate.checking')
    case 'not-available': return t('settings.appUpdate.upToDate', { v: __APP_VERSION__ })
    case 'available': return t('settings.appUpdate.available', { v: state.value.version })
    case 'downloading': {
      const pct = Math.round(state.value.percent || 0)
      return t('settings.appUpdate.downloading', { v: state.value.version, pct })
    }
    case 'ready': return t('settings.appUpdate.ready', { v: state.value.version })
    case 'error': return t('settings.appUpdate.error', { msg: state.value.message })
  }
  return ''
})

const phaseClass = computed(() => {
  switch (state.value.phase) {
    case 'error': return 'text-danger'
    case 'ready':
    case 'available': return 'text-success'
    case 'downloading':
    case 'checking': return 'text-muted'
    default: return 'text-muted'
  }
})

async function checkNow() {
  if (!bridge?.updater_check_now) return
  busy.value = true
  errorMsg.value = ''
  try {
    const r = await bridge.updater_check_now()
    if (!r.ok && r.error) errorMsg.value = r.error
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function installNow() {
  if (!bridge?.updater_quit_install) return
  busy.value = true
  errorMsg.value = ''
  try {
    const r = await bridge.updater_quit_install()
    if (!r.ok && r.error) errorMsg.value = r.error
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  if (!bridge?.get_updater_state || !bridge?.on_updater_status) return
  try {
    state.value = await bridge.get_updater_state()
  } catch {
    /* leave at idle — subscription will update once a real event lands */
  }
  unsubscribe = bridge.on_updater_status((s) => {
    state.value = s
  })
})

onBeforeUnmount(() => {
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
})
</script>

<template>
  <section v-if="supported" class="card settings-section mb-4">
    <h3 class="section-title">{{ $t('settings.appUpdate.section') }}</h3>
    <div class="version-row">
      <span class="text-muted text-sm">{{ $t('settings.appUpdate.currentVersion') }}</span>
      <span class="font-mono">v{{ __APP_VERSION__ }}</span>
    </div>
    <p class="status-line mt-2" :class="phaseClass">
      {{ phaseLabel }}
    </p>
    <p v-if="errorMsg" class="text-sm text-danger mt-1">{{ errorMsg }}</p>
    <div class="actions mt-3">
      <button
        class="btn"
        :disabled="busy || state.phase === 'checking' || state.phase === 'downloading'"
        @click="checkNow"
      >
        {{ $t('settings.appUpdate.checkButton') }}
      </button>
      <button
        v-if="state.phase === 'ready'"
        class="btn btn-primary"
        :disabled="busy"
        @click="installNow"
      >
        {{ $t('settings.appUpdate.installButton') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.version-row {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}
.status-line {
  font-size: 14px;
}
.actions {
  display: flex;
  gap: var(--space-2);
}
</style>
