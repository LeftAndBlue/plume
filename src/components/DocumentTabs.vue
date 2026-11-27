<script setup>
import { nextTick, ref, watch } from 'vue';
import { Columns2, Plus, X } from 'lucide-vue-next';
import { useShellStore } from '../stores/shell.js';
import { t } from '../i18n.js';

const shell = useShellStore();
const barRef = ref(null);
const base = (p) => p.split(/[\\/]/).pop();
const dirOf = (p) => String(p || '').replace(/[\\/][^\\/]*$/, '');

function onMiddleClick(tab) {
  shell.runtime?.closeTab(tab.path);
}

function onTabsWheel(event) {
  const el = barRef.value;
  if (!el || el.scrollWidth <= el.clientWidth) return;
  if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
    el.scrollLeft += event.deltaY;
  }
}

function onBarDblClick(event) {
  if (event.target === barRef.value) {
    onNewTab();
  }
}

function onNewTab() {
  const api = shell.runtime;
  if (!api) return;
  if (shell.dir && window.studio?.createFsEntry && api.fileOps?.create) {
    api.fileOps.create(shell.dir, false);
  } else {
    api.run('new');
  }
}

watch(
  () => [shell.path, shell.tabs.length, shell.tabsVisible],
  async () => {
    await nextTick();
    barRef.value?.querySelector('.document-tab.is-active')?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    });
  },
);

function showTabContext(event, tab, index) {
  const api = shell.runtime;
  if (!api?.contextMenu) return;
  const total = shell.tabs.length;
  const isSplit = !!tab.split;
  const items = [
    ...(isSplit
      ? [
          { label: t('tabs.closeSplit'), action: () => api.closeSplit?.() },
          { label: t('tabs.swapSplit'), action: () => api.swapSplit?.() },
        ]
      : [
          {
            label: t('tabs.split'),
            disabled: tab.active,
            action: () => api.openSplit?.(tab.path),
          },
          ...(shell.splitPath
            ? [{ label: t('tabs.closeSplit'), action: () => api.closeSplit?.() }]
            : []),
        ]),
    { separator: true },
    { label: t('tabs.closeItem'), action: () => api.closeTab(tab.path) },
    {
      label: t('tabs.closeOther'),
      disabled: total <= 1,
      action: () => api.closeOtherTabs?.(tab.path),
    },
    {
      label: t('tabs.closeRight'),
      disabled: index >= total - 1,
      action: () => api.closeTabsToRight?.(tab.path),
    },
    { separator: true },
    {
      label: t('tabs.copyPath'),
      action: () => api.fileOps?.copyText(tab.path, t('tabs.pathCopied')),
    },
    {
      label: t('tabs.revealInExplorer'),
      disabled: !window.studio?.showFsEntry,
      action: () => window.studio?.showFsEntry?.(shell.dir || dirOf(tab.path), tab.path),
    },
  ];
  api.contextMenu(event, items);
}
</script>

<template>
  <!-- 显隐只由状态栏的 st-tabs 与「视图」菜单控制，本栏不再放开关 -->
  <div
    v-if="shell.tabs.length && shell.tabsVisible"
    id="document-tabs"
    ref="barRef"
    role="tablist"
    :aria-label="t('tabs.aria')"
    @wheel.passive="onTabsWheel"
    @dblclick="onBarDblClick"
  >
    <div
      v-for="(tab, index) in shell.tabs"
      :key="tab.path"
      class="document-tab"
      :class="{ 'is-active': tab.active, 'is-split': tab.split }"
      @mousedown.middle.prevent
      @auxclick.middle.prevent="onMiddleClick(tab)"
      @contextmenu="showTabContext($event, tab, index)"
    >
      <button class="document-tab-open" :title="tab.path" @click="shell.runtime?.openTab(tab.path)">
        <Columns2 v-if="tab.split" :size="11" class="document-tab-split-icon" aria-hidden="true" />
        <span class="document-tab-name">{{ base(tab.path) }}</span>
        <span
          v-if="(tab.active && shell.dirty) || (tab.split && shell.splitDirty)"
          class="document-tab-dirty"
          :title="t('chrome.unsaved')"
        >●</span>
      </button>
      <button class="document-tab-close" :title="t('tabs.close')" :aria-label="t('tabs.close')" @click="shell.runtime?.closeTab(tab.path)">
        <X :size="12" />
      </button>
    </div>
    <button
      type="button"
      class="document-tab-add"
      :title="t('tabs.newFile')"
      :aria-label="t('tabs.newFile')"
      @click="onNewTab"
    >
      <Plus :size="14" :stroke-width="1.9" />
    </button>
  </div>
</template>
