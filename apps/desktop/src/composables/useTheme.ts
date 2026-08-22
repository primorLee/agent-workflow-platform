import { computed } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import type { Theme } from '@/stores/settings'

export function useTheme() {
  const settings = useSettingsStore()

  const theme = computed(() => settings.theme)

  function setTheme(newTheme: Theme) {
    settings.theme = newTheme
    document.documentElement.setAttribute('data-theme', newTheme)
    settings.saveSettings()
  }

  function toggleTheme() {
    setTheme(settings.theme === 'dark' ? 'light' : 'dark')
  }

  // Apply on init
  document.documentElement.setAttribute('data-theme', settings.theme)

  return { theme, setTheme, toggleTheme }
}
