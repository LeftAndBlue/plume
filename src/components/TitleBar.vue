<script setup>
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Minus, Square, X } from 'lucide-vue-next';
import { useShellStore } from '../stores/shell.js';
import { isTauri } from '../platform/studio.js';
import { t } from '../i18n.js';

const shell = useShellStore();
const win = isTauri ? getCurrentWindow() : null;

const minimize = () => win?.minimize();
const toggleMaximize = () => win?.toggleMaximize();
// close 会触发 Rust/平台层的 close-requested 流程，由运行时先处理未保存文档。
const close = () => win?.close();

// WebView2 不认 -webkit-app-region，拖动改由 JS 调 startDragging 完成。
// 用 composedPath 判断是否点在三键/菜单上：命中就放行（让按钮自己的 click 生效），
// 其余区域一律交给系统拖动循环，因此「按住三键拖窗口」不会再发生。
const NO_DRAG = new Set(['window-controls', 'win-btn', 'menu-toggle', 'menubar', 'menu-panel', 'menu-pop']);

function onTitleDblClick() {
  if (win) toggleMaximize();
}

function onChromeMouseDown(event) {
  if (!win || event.button !== 0) return;
  const path = event.composedPath ? event.composedPath() : [];
  for (const node of path) {
    if (node?.classList && [...node.classList].some((c) => NO_DRAG.has(c))) return;
    if (node?.id && NO_DRAG.has(node.id)) return;
  }
  if (event.detail >= 2) {
    toggleMaximize();
    return;
  }
  win.startDragging();
}
</script>

<template>
  <header id="chrome" @mousedown="onChromeMouseDown">
    <!-- 汉堡按钮由 menubar.js 填充并接管（Typora 式菜单页） -->
    <button id="menu-toggle" class="menu-toggle" type="button" :title="t('chrome.menu')" :aria-label="t('chrome.menu')" @mousedown.stop></button>
    <div class="chrome-title" :title="t('chrome.dragHint')" @dblclick="onTitleDblClick">
      <span id="st-file">{{ shell.fileName }}</span>
      <span id="st-dirty" class="st-dirty">{{ shell.dirty ? t('chrome.unsaved') : '' }}</span>
    </div>
    <!-- 菜单栏由 editor/menubar.js 按声明式菜单表渲染（Alt 助记键 / 方向键行为不变） -->
    <nav id="menubar" role="menubar" :aria-label="t('chrome.mainMenu')"></nav>
    <div v-if="isTauri" class="window-controls" @mousedown.stop>
      <button class="win-btn" type="button" :title="t('chrome.minimize')" :aria-label="t('chrome.minimize')" @click="minimize">
        <Minus :size="15" />
      </button>
      <button class="win-btn" type="button" :title="t('chrome.maximize')" :aria-label="t('chrome.maximize')" @click="toggleMaximize">
        <Square :size="12" />
      </button>
      <button class="win-btn win-btn-close" type="button" :title="t('chrome.close')" :aria-label="t('chrome.close')" @click="close">
        <X :size="15" />
      </button>
    </div>
  </header>
  <div id="menu-pop" class="menu-pop" role="menu" hidden></div>
</template>

<style scoped>
.window-controls {
  margin-left: auto;
  display: flex;
  align-items: stretch;
  height: 100%;
  flex: 0 0 auto;
}
.win-btn {
  width: 46px;
  border: 0;
  background: transparent;
  color: var(--text);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: default;
}
.win-btn:hover {
  background: var(--chrome-hover);
}
.win-btn-close:hover {
  background: #e81123;
  color: #fff;
}
</style>
