<script setup>
import { Code, PanelLeft } from 'lucide-vue-next';
import { useShellStore } from '../stores/shell.js';
import { t } from '../i18n.js';

const shell = useShellStore();
const run = (cmd) => shell.runtime?.run(cmd);
</script>

<template>
  <footer id="statusbar">
    <!-- 左下角照 Typora 排两个：左边开合侧栏，右边切源代码模式 -->
    <button
      id="st-side"
      class="st-tool"
      :class="{ 'is-on': shell.sidebarOpen }"
      :title="t('status.toggleSidebar')"
      :aria-label="t('status.toggleSidebarAria')"
      @click="run('toggle-sidebar')"
    >
      <PanelLeft :size="14" :stroke-width="1.8" />
    </button>
    <button
      id="st-source"
      class="st-tool st-tool-code"
      :class="{ 'is-on': shell.sourceMode }"
      :title="t('status.sourceMode')"
      :aria-label="t('status.sourceModeAria')"
      @click="run('source-mode')"
    >
      <Code :size="14" :stroke-width="1.8" />
    </button>
    <span class="st-spacer"></span>
    <button
      v-if="shell.saveError"
      id="st-save-error"
      class="st-save-error"
      :title="shell.saveError + '\n' + t('status.retrySave')"
      @click="run('save')"
    >
      {{ t('status.saveError') }}
    </button>
    <span id="st-count" :title="t('status.countTitle')">{{ t('status.words', { n: shell.words.toLocaleString() }) }}</span>
    <span id="st-lines">{{ t('status.lines', { n: shell.lines.toLocaleString() }) }}</span>
    <span id="st-hint" :class="{ 'is-flash': !!shell.hint }">{{ shell.hint }}</span>
  </footer>
</template>
