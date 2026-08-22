<script setup lang="ts">
import { onMounted, ref } from 'vue'

const storedTheme = localStorage.getItem('awp.monitor.theme')
const theme = ref(storedTheme === 'light' ? 'light' : 'dark')

function applyTheme(): void {
  document.documentElement.dataset.theme = theme.value
}

function toggleTheme(): void {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  localStorage.setItem('awp.monitor.theme', theme.value)
  applyTheme()
}

onMounted(applyTheme)
</script>

<template>
  <div class="app-shell">
    <RouterView :theme="theme" :toggle-theme="toggleTheme" />
  </div>
</template>

<style>
@import '@/styles/base.css';
</style>

<style scoped>
.app-shell {
  min-height: 100%;
  background: var(--bg-primary);
  color: var(--text-primary);
}
</style>
