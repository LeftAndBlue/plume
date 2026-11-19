<script setup>
import { onMounted, markRaw } from 'vue';
import { useShellStore } from './stores/shell.js';
import TitleBar from './components/TitleBar.vue';
import Sidebar from './components/Sidebar.vue';
import DocumentTabs from './components/DocumentTabs.vue';
import StatusBar from './components/StatusBar.vue';
import { initRuntime } from './editor/runtime.js';
import { t } from './i18n.js';

const shell = useShellStore();

onMounted(() => {
  // DOM 就绪后再启动运行时：编辑器核心与命令式弹层（菜单/设置/右键菜单）
  // 继续复用既有实现，Vue 组件负责外壳的响应式部分。
  const api = initRuntime();
  shell.runtime = markRaw(api);
});
</script>

<template>
  <!-- 侧栏占满窗口高度；顶栏、正文、底栏在右侧一列。id 与主题 CSS 的约定一致。 -->
  <div id="shell">
    <Sidebar />
    <div id="workspace">
      <TitleBar />
      <DocumentTabs />
      <div id="editor-area">
        <main id="main">
          <div id="editor-host"></div>
        </main>
      </div>
      <StatusBar />
    </div>
  </div>

  <!-- 选区浮动格式条（运行时定位与绑定） -->
  <div id="fmt-pop" class="fmt-pop" hidden>
    <button type="button" data-fmt="bold" :title="t('fmt.bold')"><b>B</b></button>
    <button type="button" data-fmt="italic" :title="t('fmt.italic')"><i>I</i></button>
    <button type="button" data-fmt="strike" :title="t('fmt.strike')"><s>S</s></button>
    <button type="button" data-fmt="code" :title="t('fmt.code')" :aria-label="t('fmt.code')">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
      </svg>
    </button>
    <button type="button" data-fmt="link" :title="t('fmt.link')">{{ t('fmt.link') }}</button>
    <button type="button" data-fmt="highlight" :title="t('fmt.highlight')">{{ t('fmt.highlight') }}</button>
  </div>
  <div id="stats-pop" class="stats-pop" hidden></div>

  <!-- 设置 / 主题商店 / 文本询问共用的面板（运行时填充内容） -->
  <div id="settings" class="settings" hidden>
    <div class="settings-card" role="dialog" aria-labelledby="settings-title">
      <header class="settings-head">
        <h2 id="settings-title">{{ t('settings.title') }}</h2>
        <button type="button" id="settings-close" :aria-label="t('settings.closeAria')">×</button>
      </header>
      <div id="settings-body" class="settings-body"></div>
    </div>
  </div>
</template>
