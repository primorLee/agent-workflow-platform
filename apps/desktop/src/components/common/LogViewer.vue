<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'

const props = defineProps<{
  content: string
  autoScroll?: boolean
}>()

const container = ref<HTMLPreElement | null>(null)

watch(() => props.content, async () => {
  if (props.autoScroll !== false) {
    await nextTick()
    if (container.value) {
      container.value.scrollTop = container.value.scrollHeight
    }
  }
})
</script>

<template>
  <pre ref="container" class="log-viewer">{{ content || ' ' }}</pre>
</template>

<style scoped>
.log-viewer {
  background: var(--bg-terminal);
  color: var(--text-on-surface);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  padding: 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  overflow: auto;
  max-height: 400px;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
