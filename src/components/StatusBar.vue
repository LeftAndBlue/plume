<script setup>
import { computed } from 'vue';
import { Code, PanelLeft, PanelTop } from 'lucide-vue-next';
import { useShellStore } from '../stores/shell.js';
import { computeWordGoalProgress } from '../editor/extrasText.js';
import { t } from '../i18n.js';

const shell = useShellStore();
const run = (cmd) => shell.runtime?.run(cmd);

const goalInfo = computed(() => computeWordGoalProgress(shell.words, shell.wordGoal));
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
    <!-- 标签栏收起后的恢复入口，和标签栏左端的隐藏按钮共用同一个命令 -->
    <button
      id="st-tabs"
      class="st-tool"
      :class="{ 'is-on': shell.tabsVisible }"
      :title="t('status.toggleTabs')"
      :aria-label="t('status.toggleTabsAria')"
      :aria-pressed="shell.tabsVisible"
      @click="run('toggle-tabs')"
    >
      <PanelTop :size="14" :stroke-width="1.8" />
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
    <span id="st-count" :class="{ 'has-goal': goalInfo.goal > 0, 'is-reached': goalInfo.reached }" :title="t('status.countTitle')">
      <template v-if="goalInfo.goal > 0">
        {{ t('status.wordsGoal', { n: shell.words.toLocaleString(), g: goalInfo.goal.toLocaleString(), p: goalInfo.percent }) }}
        <span class="st-goal-bar" aria-hidden="true"><span class="st-goal-fill" :style="{ width: goalInfo.percent + '%' }"></span></span>
      </template>
      <template v-else>{{ t('status.words', { n: shell.words.toLocaleString() }) }}</template>
    </span>
    <span id="st-lines">{{ t('status.lines', { n: shell.lines.toLocaleString() }) }}</span>
    <span id="st-hint" :class="{ 'is-flash': !!shell.hint }">{{ shell.hint }}</span>
  </footer>
</template>
