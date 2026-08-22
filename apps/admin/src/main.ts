import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHashHistory } from 'vue-router'

import App from './App.vue'
import { hasConnection } from './api/controlPlane'
import ConnectionView from './views/ConnectionView.vue'
import DashboardView from './views/DashboardView.vue'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/connect', name: 'connect', component: ConnectionView },
    { path: '/', name: 'dashboard', component: DashboardView },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

router.beforeEach((to) => {
  const connected = hasConnection()
  if (to.name !== 'connect' && !connected) return { name: 'connect' }
  if (to.name === 'connect' && connected) return { name: 'dashboard' }
  return true
})

createApp(App).use(createPinia()).use(router).mount('#app')
