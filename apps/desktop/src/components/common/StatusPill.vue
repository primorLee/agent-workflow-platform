<script setup lang="ts">
defineProps<{
  status: 'connected' | 'disconnected' | 'checking'
  label: string
}>()
</script>

<template>
  <span class="status-pill" :class="status">
    <span class="dot" />
    {{ label }}
  </span>
</template>

<style scoped>
.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 500;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.status-pill.connected {
  background: rgba(34, 197, 94, 0.1);
  color: var(--success);
}
.status-pill.connected .dot { background: var(--success); }
.status-pill.disconnected {
  background: rgba(239, 68, 68, 0.1);
  color: var(--danger);
}
.status-pill.disconnected .dot { background: var(--danger); }
.status-pill.checking {
  background: rgba(245, 158, 11, 0.1);
  color: var(--warning);
}
.status-pill.checking .dot {
  background: var(--warning);
  animation: pulse 1s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
</style>
