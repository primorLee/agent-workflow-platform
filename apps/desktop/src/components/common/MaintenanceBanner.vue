<script setup lang="ts">
/**
 * Top-of-app maintenance banner.
 *
 * Renders a red full-width strip near the title bar whenever the cloud is in
 * maintenance mode. Non-dismissible by design — the user should see it
 * for as long as the cloud reports enabled=true. State comes from
 * useMaintenanceStatus (15s poll of /v1/maintenance).
 */
import { useMaintenanceStatus } from '@/composables/useMaintenanceStatus'

const { enabled, message } = useMaintenanceStatus()
</script>

<template>
  <Transition name="maintenance-banner">
    <div v-if="enabled" class="maintenance-banner" role="alert" aria-live="polite">
      <span class="dot">●</span>
      <span class="msg">{{ message }}</span>
    </div>
  </Transition>
</template>

<style scoped>
.maintenance-banner {
  position: fixed;
  /* Sit just below the titleBarOverlay (36px) like UpdateBanner does. */
  top: 36px;
  left: 0;
  right: 0;
  padding: 8px 16px;
  background: #b91c1c;
  color: #fff;
  border-bottom: 1px solid #7f1d1d;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.24);
  z-index: 9100; /* above UpdateBanner (9000) since maintenance trumps updates */
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  font-size: 13px;
  font-weight: 500;
}

.dot {
  font-size: 10px;
  animation: pulse 1.6s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.maintenance-banner-enter-active,
.maintenance-banner-leave-active {
  transition: transform 0.24s ease, opacity 0.24s ease;
}
.maintenance-banner-enter-from,
.maintenance-banner-leave-to {
  opacity: 0;
  transform: translateY(-100%);
}
</style>
