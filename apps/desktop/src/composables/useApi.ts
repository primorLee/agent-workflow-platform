import { ref } from 'vue'
import type { Ref } from 'vue'

export function useApi<T, A extends readonly unknown[] = readonly unknown[]>(
  apiFn: (...args: A) => Promise<T>,
) {
  const data: Ref<T | null> = ref(null)
  const loading = ref(false)
  const error: Ref<string | null> = ref(null)

  async function execute(...args: A) {
    loading.value = true
    error.value = null
    try {
      data.value = await apiFn(...args)
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
    return data.value
  }

  return { data, loading, error, execute }
}
