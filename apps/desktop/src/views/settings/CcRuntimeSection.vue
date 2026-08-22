<script setup lang="ts">
/**
 * Provider-neutral Agent CLI runtime status.
 *
 * External mode uses an explicitly configured absolute executable path.
 * Managed mode is disabled until a signed HTTPS manifest is configured.
 * No provider package is downloaded or selected implicitly.
 */

import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'

interface CcRuntimeStatus {
  currentVersion: string | null
  lastCheckMs: number
  lastUpdateMs: number
  updating: boolean
  available: boolean
  source: 'external' | 'managed' | 'disabled'
}

interface CcRuntimeCheckResult {
  updated: boolean
  from?: string
  to?: string
  error?: string
}

// The CC runtime bridge calls are injected on `window.electronAPI` by
// preload.ts. We type them narrowly here (the global `DesktopBridge` type
// doesn't include them yet — owners of that type can add them in a later
// refactor without touching this file).
interface CcRuntimeBridge {
  cc_runtime_status?: () => Promise<CcRuntimeStatus>
  cc_runtime_check_now?: () => Promise<CcRuntimeCheckResult>
}

function getBridge(): CcRuntimeBridge | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { electronAPI?: CcRuntimeBridge }
  return w.electronAPI ?? null
}

const { t } = useI18n()

const bridge = getBridge()
const hasCcRuntime = computed(
  () => typeof bridge?.cc_runtime_status === 'function',
)

const status = ref<CcRuntimeStatus>({
  currentVersion: null,
  lastCheckMs: 0,
  lastUpdateMs: 0,
  updating: false,
  available: false,
  source: 'disabled',
})
const checking = ref(false)
const message = ref('')
const messageKind = ref<'success' | 'danger' | 'muted'>('muted')

let pollTimer: ReturnType<typeof setInterval> | null = null

function formatRelative(ms: number): string {
  if (!ms || ms <= 0) return t('settings.ccRuntime.never')
  const now = Date.now()
  const deltaSec = Math.max(0, Math.floor((now - ms) / 1000))
  if (deltaSec < 60) return t('settings.ccRuntime.justNow')
  if (deltaSec < 3600) {
    const m = Math.floor(deltaSec / 60)
    return t('settings.ccRuntime.minutesAgo', { n: m })
  }
  if (deltaSec < 86400) {
    const h = Math.floor(deltaSec / 3600)
    return t('settings.ccRuntime.hoursAgo', { n: h })
  }
  const d = Math.floor(deltaSec / 86400)
  return t('settings.ccRuntime.daysAgo', { n: d })
}

async function fetchStatus(): Promise<void> {
  if (!bridge?.cc_runtime_status) return
  try {
    const s = await bridge.cc_runtime_status()
    // Accept whatever main returns — we already type-guarded the function
    // itself. Missing fields fall back to safe defaults so the UI never
    // renders `NaN minutes ago`.
    status.value = {
      currentVersion: s?.currentVersion ?? null,
      lastCheckMs: typeof s?.lastCheckMs === 'number' ? s.lastCheckMs : 0,
      lastUpdateMs: typeof s?.lastUpdateMs === 'number' ? s.lastUpdateMs : 0,
      updating: s?.updating === true,
      available: s?.available === true,
      source: s?.source === 'external' || s?.source === 'managed' ? s.source : 'disabled',
    }
  } catch (err) {
    // Non-fatal — leave prior values on the card. Logging here would spam
    // every 30 s if the IPC is temporarily broken; the "check now" click
    // path surfaces errors to the user directly.
    console.warn('[CcRuntimeSection] fetchStatus failed:', err)
  }
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  return String(e)
}

async function onCheckNow(): Promise<void> {
  if (!bridge?.cc_runtime_check_now) {
    message.value = t('settings.ccRuntime.notAvailable')
    messageKind.value = 'danger'
    return
  }
  checking.value = true
  message.value = ''
  try {
    const r = await bridge.cc_runtime_check_now()
    if (r?.error) {
      message.value = t('settings.ccRuntime.checkError', { msg: r.error })
      messageKind.value = 'danger'
    } else if (r?.updated) {
      message.value = t('settings.ccRuntime.updated', {
        from: r.from ?? '?',
        to: r.to ?? '?',
      })
      messageKind.value = 'success'
    } else {
      message.value = t('settings.ccRuntime.upToDate')
      messageKind.value = 'muted'
    }
  } catch (err) {
    message.value = t('settings.ccRuntime.checkError', { msg: errMessage(err) })
    messageKind.value = 'danger'
  } finally {
    checking.value = false
    // Re-fetch status — on an actual upgrade `currentVersion` + `lastUpdateMs`
    // will have moved, and we don't want to make the user wait for the 30 s
    // poll to see that.
    await fetchStatus()
  }
}

const buttonDisabled = computed(() => checking.value || status.value.updating)
const canCheckManagedFeed = computed(() => status.value.source === 'managed')
const sourceKey: Record<CcRuntimeStatus['source'], string> = {
  external: 'settings.ccRuntime.sourceExternal',
  managed: 'settings.ccRuntime.sourceManaged',
  disabled: 'settings.ccRuntime.sourceDisabled',
}
const sourceLabel = computed(() => t(sourceKey[status.value.source]))

onMounted(() => {
  if (!hasCcRuntime.value) return
  void fetchStatus()
  pollTimer = setInterval(() => {
    void fetchStatus()
  }, 30_000)
})

onUnmounted(() => {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
})
</script>

<template>
  <section
    v-if="hasCcRuntime"
    class="card settings-section cc-runtime-section"
    data-testid="cc-runtime-section"
  >
    <h3 class="section-title">{{ t('settings.ccRuntime.section') }}</h3>
    <p class="text-xs text-muted mb-3">{{ t('settings.ccRuntime.helper') }}</p>

    <div class="cc-runtime-grid">
      <div class="cc-runtime-row">
        <span class="cc-runtime-label text-muted">{{ t('settings.ccRuntime.source') }}</span>
        <span class="cc-runtime-value" data-testid="cc-runtime-source">{{ sourceLabel }}</span>
      </div>

      <div class="cc-runtime-row">
        <span class="cc-runtime-label text-muted">{{ t('settings.ccRuntime.availability') }}</span>
        <span class="cc-runtime-value" data-testid="cc-runtime-availability">
          {{ t(status.available ? 'settings.ccRuntime.available' : 'settings.ccRuntime.unavailable') }}
        </span>
      </div>

      <div class="cc-runtime-row">
        <span class="cc-runtime-label text-muted">
          {{ t('settings.ccRuntime.currentVersion') }}
        </span>
        <span
          class="cc-runtime-value font-mono"
          data-testid="cc-runtime-current-version"
        >
          {{ status.currentVersion ?? t('settings.ccRuntime.notInstalled') }}
        </span>
      </div>

      <div class="cc-runtime-row">
        <span class="cc-runtime-label text-muted">
          {{ t('settings.ccRuntime.lastCheck') }}
        </span>
        <span
          class="cc-runtime-value"
          data-testid="cc-runtime-last-check"
        >
          {{ formatRelative(status.lastCheckMs) }}
        </span>
      </div>

      <div class="cc-runtime-row">
        <span class="cc-runtime-label text-muted">
          {{ t('settings.ccRuntime.lastUpdate') }}
        </span>
        <span
          class="cc-runtime-value"
          data-testid="cc-runtime-last-update"
        >
          {{ formatRelative(status.lastUpdateMs) }}
        </span>
      </div>
    </div>

    <div class="field-row mt-3">
      <button
        v-if="canCheckManagedFeed"
        class="btn btn-primary"
        type="button"
        data-testid="cc-runtime-check-now-btn"
        :disabled="buttonDisabled"
        @click="onCheckNow"
      >
        <LoadingSpinner v-if="checking || status.updating" size="sm" />
        {{
          status.updating
            ? t('settings.ccRuntime.updating')
            : checking
              ? t('settings.ccRuntime.checking')
              : t('settings.ccRuntime.checkNow')
        }}
      </button>
    </div>

    <p
      v-if="message"
      class="text-sm mt-2"
      data-testid="cc-runtime-message"
      :class="{
        'text-success': messageKind === 'success',
        'text-danger': messageKind === 'danger',
        'text-muted': messageKind === 'muted',
      }"
    >
      {{ message }}
    </p>
  </section>
</template>

<style scoped>
/* Mirrors the typography + spacing tokens used by the About section and
/* Uses the same typography and spacing tokens as other settings cards. */
.cc-runtime-section {
  display: flex;
  flex-direction: column;
}

.cc-runtime-grid {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.cc-runtime-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--border);
  font-size: 13px;
  gap: var(--space-2);
}

.cc-runtime-row:last-child {
  border-bottom: none;
}

.cc-runtime-label {
  font-size: 13px;
  flex-shrink: 0;
}

.cc-runtime-value {
  font-size: 13px;
  text-align: right;
  word-break: break-all;
}
</style>
