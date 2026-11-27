<script setup>
import { Columns2, X } from 'lucide-vue-next';
import { useShellStore } from '../stores/shell.js';
import { t } from '../i18n.js';

const shell = useShellStore();
const base = (p) => p.split(/[\\/]/).pop();
const dirOf = (p) => String(p || '').replace(/[\\/][^\\/]*$/, '');

function onMiddleClick(tab) {
  shell.runtime?.closeTab(tab.path);
}

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
  <div v-if="shell.tabs.length && shell.tabsVisible" id="document-tabs" role="tablist" :aria-label="t('tabs.aria')">
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
      </button>
      <button class="document-tab-close" :title="t('tabs.close')" :aria-label="t('tabs.close')" @click="shell.runtime?.closeTab(tab.path)">
        <X :size="12" />
      </button>
    </div>
  </div>
</template>
