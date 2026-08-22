import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import i18n from './i18n'
import { useToastStore } from './stores/toast'

const app = createApp(App)

app.use(createPinia())
app.use(router)
app.use(i18n)

// 全局 Vue 错误捕获 — 防 UI 白屏静默失败
app.config.errorHandler = (err, _instance, info) => {
  console.error('[vue:errorHandler]', info, err)
  try {
    useToastStore().error(String((err as Error)?.message ?? err))
  } catch {
    // Pinia 尚未初始化或 toast store 异常时降级到 console
  }
}

// 未捕获 Promise rejection — 捕获 async/await 链断裂
window.addEventListener('unhandledrejection', (event) => {
  console.error('[window:unhandledrejection]', event.reason)
})

// 同步运行时错误 — 捕获非 Vue 组件内抛出的错误
window.addEventListener('error', (event) => {
  console.error('[window:error]', event.error || event.message)
})

app.mount('#app')
// force-rehash 1775469220
