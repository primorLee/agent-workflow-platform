<script setup lang="ts">
import { ref, watch, nextTick, onMounted, computed } from 'vue'
import type { ChatMessage } from '@/api/types'
import type { ActivityEvent } from '@/types/activity'
import WorkPhaseIndicator from './WorkPhaseIndicator.vue'
import DiagnosticCard from './DiagnosticCard.vue'
import MessageBubble from './MessageBubble.vue'
import QuickPrompts from './QuickPrompts.vue'
import StreamStatus from './StreamStatus.vue'

const props = withDefaults(defineProps<{
  messages: ChatMessage[]
  streaming: string
  loading: boolean
  activities?: ActivityEvent[]
}>(), {
  activities: () => [],
})

const emit = defineEmits<{
  (e: 'send-prompt', prompt: string): void
}>()

const container = ref<HTMLDivElement | null>(null)

/** True when no user messages yet */
const isEmptyState = computed(() =>
  !props.messages.some(m => m.role === 'user') && !props.streaming && props.activities.length === 0
)

/** Messages to render (skip welcome msg when empty state renders it) */
const displayMessages = computed(() => {
  if (isEmptyState.value && props.messages.length > 0 && props.messages[0]?.role === 'assistant') {
    return props.messages.slice(1)
  }
  return props.messages
})

/** Active (running) phase indicators */
const runningActivities = computed(() =>
  props.activities.filter(a => a.status === 'running')
)


/** Latest diagnostics event */
const latestDiagEvent = computed(() => {
  const withDiag = props.activities.filter(a => a.diagnostics && a.diagnostics.issues.length > 0)
  return withDiag.length > 0 ? withDiag[withDiag.length - 1] : null
})


async function syncScrollPosition() {
  await nextTick()
  if (container.value) {
    container.value.scrollTop = isEmptyState.value ? 0 : container.value.scrollHeight
  }
}

watch(() => props.messages.length, syncScrollPosition)
watch(() => props.streaming, syncScrollPosition)
watch(() => props.activities.length, syncScrollPosition)
watch(isEmptyState, syncScrollPosition)
onMounted(syncScrollPosition)

defineExpose({ container })
</script>

<template>
  <div ref="container" class="chat-panel">
    <!-- Empty state: welcome + quick prompts -->
    <QuickPrompts
      v-if="isEmptyState"
      :messages="messages"
      @send-prompt="emit('send-prompt', $event)"
    />

    <!-- Chat messages -->
    <MessageBubble
      v-for="(msg, i) in displayMessages"
      :key="'msg-' + i"
      :message="msg"
      :index="i"
      :messages="messages"
    />



    <!-- Diagnostics card -->
    <div v-if="latestDiagEvent" class="activity-block">
      <DiagnosticCard
        :diagnostics="latestDiagEvent.diagnostics!"
        :iteration="latestDiagEvent.iteration"
      />
    </div>

    <!-- Running phase indicators -->
    <div v-for="evt in runningActivities" :key="'phase-' + evt.id" class="activity-block">
      <WorkPhaseIndicator :event="evt" />
    </div>

    <!-- Streaming / status / loading / error -->
    <StreamStatus
      :streaming="streaming"
      :loading="loading && runningActivities.length === 0"
    />
  </div>
</template>

<style scoped>
.chat-panel {
  flex: 1;
  overflow-y: auto;
  padding: 28px 32px 20px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.activity-block {
  max-width: 95%;
  align-self: flex-start;
}

@media (max-width: 980px) {
  .chat-panel {
    padding: 28px 18px 18px;
  }
}
</style>
