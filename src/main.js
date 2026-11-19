import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { installPlatform } from './platform/studio.js';
import './style.css';
import 'katex/dist/katex.min.css';
import './editor/styles/index.css';

installPlatform();

const pinia = createPinia();
createApp(App).use(pinia).mount('#app');
