import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { initBilitoolkitUi, handleError } from 'bilitoolkit-ui'
import 'bilitoolkit-ui/style.css'
import 'element-plus/dist/index.css'
import App from './App.vue'

async function bootstrap() {
  const app = createApp(App)
  const pinia = createPinia()
  app.config.globalProperties.$toolkitApi = window.toolkitApi
  app.use(pinia)
  app.use(await initBilitoolkitUi(pinia))
  app.config.errorHandler = handleError
  app.mount('#app')
}
bootstrap().catch(handleError)
