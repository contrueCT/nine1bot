import { createApp } from 'vue'
// 字体随包自托管：内网、离线和隧道访问都不依赖外部字体服务。
// 各字重按 unicode-range 分片，浏览器只下载页面实际用到的分片。
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/400-italic.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import './style.css'
import App from './App.vue'
import { installAccessFetchInterceptor } from './api/access-auth'

installAccessFetchInterceptor()
createApp(App).mount('#app')
