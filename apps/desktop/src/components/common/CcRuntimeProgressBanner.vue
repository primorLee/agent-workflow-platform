<script setup lang="ts">
/**
 * Progress for an explicitly configured managed Agent CLI executable.
 * The updater downloads, verifies, and atomically stages a raw executable.
 */
import { onMounted, onUnmounted, ref, computed } from 'vue'

type Stage = 'idle' | 'downloading' | 'verifying' | 'staging' | 'done' | 'error'

interface Progress {
  stage: Stage
  bytesDownloaded: number
  bytesTotal: number
  version: string | null
  error?: string
}

const progress = ref<Progress>({
  stage: 'idle',
  bytesDownloaded: 0,
  bytesTotal: 0,
  version: null,
})

// 用户手动 dismissed 的状态. error / done 后用户可以关掉横幅, 但下次
// 启动还会重新触发 (新一次安装事件会 reset).
const dismissed = ref(false)

let unsubscribe: (() => void) | null = null

onMounted(async () => {
  type Api = {
    cc_runtime_progress?: () => Promise<Progress>
    on_cc_runtime_progress?: (cb: (info: Progress) => void) => () => void
  }
  const api = (window as unknown as { electronAPI?: Api }).electronAPI
  if (!api) return
  if (typeof api.cc_runtime_progress === 'function') {
    try {
      progress.value = await api.cc_runtime_progress()
    } catch { /* non-electron / IPC not ready */ }
  }
  if (typeof api.on_cc_runtime_progress === 'function') {
    unsubscribe = api.on_cc_runtime_progress((p: Progress) => {
      progress.value = p
      // 新的下载启动 → 取消 dismiss 状态, 重新显示
      if (p.stage === 'downloading' || p.stage === 'verifying' || p.stage === 'staging') {
        dismissed.value = false
      }
    })
  }
})

onUnmounted(() => { unsubscribe?.() })

const visible = computed(() => {
  if (dismissed.value) return false
  const s = progress.value.stage
  return s === 'downloading' || s === 'verifying' || s === 'staging' || s === 'error'
})

const percent = computed(() => {
  const { bytesDownloaded, bytesTotal } = progress.value
  if (!bytesTotal) return 0
  return Math.min(100, Math.round((bytesDownloaded / bytesTotal) * 100))
})

const mbDownloaded = computed(() =>
  (progress.value.bytesDownloaded / (1024 * 1024)).toFixed(1),
)
const mbTotal = computed(() =>
  (progress.value.bytesTotal / (1024 * 1024)).toFixed(0),
)

const statusText = computed(() => {
  switch (progress.value.stage) {
    case 'downloading':
      if (progress.value.bytesTotal) {
        return `下载中 ${mbDownloaded.value} / ${mbTotal.value} MB (${percent.value}%)`
      }
      return `下载中 ${mbDownloaded.value} MB`
    case 'verifying':
      return '校验文件完整性中...'
    case 'staging':
      return '正在原子激活运行时…'
    case 'error':
      return `下载失败: ${progress.value.error ?? '未知错误'}`
    default:
      return ''
  }
})

const isError = computed(() => progress.value.stage === 'error')
</script>

<template>
  <Transition name="banner-fade">
    <div v-if="visible" class="cc-runtime-banner" :class="{ 'is-error': isError }">
      <div class="banner-content">
        <div class="banner-header">
          <span class="banner-icon">{{ isError ? '⚠️' : '🚀' }}</span>
          <span class="banner-title">
            {{ isError ? 'Agent 运行时更新失败' : 'Agent 运行时更新中' }}
          </span>
          <button v-if="isError" class="banner-dismiss" @click="dismissed = true" title="关闭">
            ✕
          </button>
        </div>
        <div class="banner-status">{{ statusText }}</div>
        <div v-if="!isError && progress.bytesTotal > 0" class="banner-progress">
          <div class="banner-progress-bar" :style="{ width: percent + '%' }"></div>
        </div>
        <div v-if="!isError" class="banner-hint">
          ChatBox 已暂时禁用，下载完成会自动激活
        </div>
        <div v-else class="banner-hint">
          可在「设置 → CC Runtime」点「立即更新」重试
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.cc-runtime-banner {
  position: fixed;
  bottom: 16px;
  right: 16px;
  width: 360px;
  background: #ffffff;
  border: 1px solid #d0d7de;
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  z-index: 9999;
  overflow: hidden;
}

.cc-runtime-banner.is-error {
  border-color: #f0c4b8;
  background: #fff7f5;
}

.banner-content {
  padding: 12px 14px;
}

.banner-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 14px;
  color: #1f2937;
  margin-bottom: 6px;
}

.banner-icon {
  font-size: 16px;
}

.banner-title {
  flex: 1;
}

.banner-dismiss {
  background: transparent;
  border: none;
  color: #6b7280;
  cursor: pointer;
  font-size: 14px;
  padding: 0 4px;
}

.banner-dismiss:hover { color: #1f2937; }

.banner-status {
  font-size: 13px;
  color: #4b5563;
  margin-bottom: 8px;
}

.banner-progress {
  height: 6px;
  background: #e5e7eb;
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 8px;
}

.banner-progress-bar {
  height: 100%;
  background: linear-gradient(90deg, #3b82f6, #6366f1);
  transition: width 200ms ease-out;
}

.banner-hint {
  font-size: 12px;
  color: #6b7280;
}

.banner-fade-enter-active,
.banner-fade-leave-active {
  transition: opacity 250ms ease-out, transform 250ms ease-out;
}
.banner-fade-enter-from,
.banner-fade-leave-to {
  opacity: 0;
  transform: translateY(20px);
}
</style>
