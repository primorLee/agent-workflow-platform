<script setup lang="ts">
defineProps<{
  size?: 'sm' | 'md' | 'lg'
}>()
</script>

<template>
  <span class="spinner" :class="size ?? 'md'" />
</template>

<style scoped>
.spinner {
  display: inline-block;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
.sm { width: 16px; height: 16px; }
.md { width: 24px; height: 24px; }
.lg { width: 40px; height: 40px; border-width: 3px; }
@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
