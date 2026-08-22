<script setup lang="ts">
/**
 * ChatPanel.vue — thin orchestration wrapper.
 *
 * All rendering is delegated to sub-components:
 *   MessageList  -> scroll container + message loop + activity cards
 *   MessageBubble -> single message (user/assistant) + toolbar
 *   QuickPrompts  -> empty-state welcome + quick-prompt grid
 *   StreamStatus  -> streaming bubble, processing bar, todo list, sim card, error
 */
import type { ChatMessage } from '@/api/types'
import type { ActivityEvent } from '@/types/activity'
import MessageList from './MessageList.vue'

withDefaults(defineProps<{
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
</script>

<template>
  <MessageList
    :messages="messages"
    :streaming="streaming"
    :loading="loading"
    :activities="activities"
    @send-prompt="emit('send-prompt', $event)"
  />
</template>
