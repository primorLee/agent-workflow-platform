<script setup lang="ts">
/**
 * Host-key mismatch banner (MITM guard UI).
 *
 * Subscribes to the `transport:host-key-mismatch` IPC event fired by
 * the shared SSH transport when the remote host key changes
 * since the last successful connection. The transport REFUSES the new
 * connection (MITM guard); this banner surfaces the warning + a "清除并重试"
 * button that removes only the offending hostId entry from known_hosts via
 * the `bridge:clear-known-hosts` IPC handler, so the next reconnect goes
 * through TOFU again.
 *
 * Why a red banner (not a toast): a changed host key is either a legitimate
 * VM reinstall or an active MITM attack — either way the user must make a
 * conscious decision. Dismissable toasts get swiped away; a persistent banner
 * with an explicit action button forces acknowledgment.
 *
 * Safety: we only clear the specific hostId from the payload. The user cannot
 * nuke the entire known_hosts file from this UI.
 */
import { onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { waitForBridge } from '@/bridge'
import type { HostKeyMismatchPayload } from '@/types/bridge'

const { t } = useI18n()

const current = ref<HostKeyMismatchPayload | null>(null)
const busy = ref(false)
const error = ref<string | null>(null)
let unsubscribe: (() => void) | null = null

onMounted(async () => {
  const bridge = await waitForBridge(3000)
  if (!bridge?.on_host_key_mismatch) return
  unsubscribe = bridge.on_host_key_mismatch((payload: HostKeyMismatchPayload) => {
    current.value = payload
    error.value = null
  })
})

onUnmounted(() => {
  if (unsubscribe) unsubscribe()
})

async function onClearAndRetry(): Promise<void> {
  if (!current.value || busy.value) return
  busy.value = true
  error.value = null
  try {
    const bridge = await waitForBridge(1000)
    if (!bridge?.clear_known_hosts) {
      error.value = t('hostKeyMismatch.errUnsupported')
      return
    }
    const r = await bridge.clear_known_hosts(current.value.hostId)
    if (r.ok) {
      // 关闭 banner；下次 SSH 重连会走 TOFU 再次保存新 key
      current.value = null
    } else {
      error.value = r.error || t('hostKeyMismatch.errClearFailed')
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

function onDismiss(): void {
  current.value = null
  error.value = null
}
</script>

<template>
  <Transition name="host-key-banner">
    <div v-if="current" class="host-key-banner" role="alert">
      <span class="icon" aria-hidden="true">⚠</span>
      <div class="body">
        <div class="title">{{ t('hostKeyMismatch.title') }}</div>
        <div class="detail">
          <code>{{ current.stored_fp }} → {{ current.received_fp }}</code>{{ t('hostKeyMismatch.detailPrefix') }}
          <strong>{{ t('hostKeyMismatch.detailWarning') }}</strong>{{ t('hostKeyMismatch.detailSuffix') }}
        </div>
        <div v-if="error" class="error-row">{{ error }}</div>
      </div>
      <div class="actions">
        <button
          class="btn-primary"
          type="button"
          :disabled="busy"
          @click="onClearAndRetry"
        >
          {{ busy ? t('hostKeyMismatch.btnClearing') : t('hostKeyMismatch.btnClearRetry') }}
        </button>
        <button class="btn-secondary" type="button" @click="onDismiss">
          {{ t('hostKeyMismatch.btnDismiss') }}
        </button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.host-key-banner {
  position: fixed;
  top: 48px;
  left: 50%;
  transform: translateX(-50%);
  min-width: 480px;
  max-width: 80vw;
  padding: 12px 16px;
  border-radius: 10px;
  background: rgba(220, 38, 38, 0.96);
  color: #fff;
  box-shadow: 0 6px 24px rgba(220, 38, 38, 0.32);
  z-index: 9500;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 13px;
}
.icon {
  font-size: 18px;
  line-height: 1;
  flex-shrink: 0;
}
.body {
  flex: 1 1 auto;
  min-width: 0;
}
.title {
  font-weight: 600;
  margin-bottom: 2px;
}
.detail {
  opacity: 0.92;
  font-size: 12px;
  line-height: 1.5;
}
.detail code {
  background: rgba(0, 0, 0, 0.18);
  padding: 1px 5px;
  border-radius: 3px;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
}
.error-row {
  margin-top: 6px;
  font-size: 11px;
  background: rgba(0, 0, 0, 0.22);
  padding: 4px 8px;
  border-radius: 4px;
}
.actions {
  margin-left: auto;
  display: flex;
  gap: 6px;
  align-items: center;
  flex-shrink: 0;
}
.btn-primary {
  padding: 6px 14px;
  border-radius: 6px;
  border: none;
  background: #fff;
  color: #b91c1c;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.btn-primary:disabled {
  opacity: 0.6;
  cursor: default;
}
.btn-secondary {
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.4);
  background: transparent;
  color: #fff;
  font-size: 12px;
  cursor: pointer;
}
.btn-secondary:hover {
  background: rgba(255, 255, 255, 0.08);
}
.host-key-banner-enter-active,
.host-key-banner-leave-active {
  transition: transform 0.24s ease, opacity 0.24s ease;
}
.host-key-banner-enter-from,
.host-key-banner-leave-to {
  opacity: 0;
  transform: translate(-50%, -8px);
}
</style>
