<script setup>
import { X } from 'lucide-vue-next';
import { useShellStore } from '../stores/shell.js';
import { t } from '../i18n.js';

const shell = useShellStore();
const base = (p) => p.split(/[\\/]/).pop();
</script>

<template>
  <div v-if="shell.tabs.length" id="document-tabs" role="tablist" :aria-label="t('tabs.aria')">
    <div
      v-for="tab in shell.tabs"
      :key="tab.path"
      class="document-tab"
      :class="{ 'is-active': tab.active }"
    >
      <button class="document-tab-open" :title="tab.path" @click="shell.runtime?.openTab(tab.path)">
        {{ base(tab.path) }}
      </button>
      <button class="document-tab-close" :title="t('tabs.close')" :aria-label="t('tabs.close')" @click="shell.runtime?.closeTab(tab.path)">
        <X :size="12" />
      </button>
    </div>
  </div>
</template>
