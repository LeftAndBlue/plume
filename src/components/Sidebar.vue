<script setup>
import { ref, watch } from 'vue';
import { FilePlus2, FolderPlus } from 'lucide-vue-next';
import { useShellStore } from '../stores/shell.js';
import { t } from '../i18n.js';
import FileTree from './FileTree.vue';
import OutlinePanel from './OutlinePanel.vue';

const shell = useShellStore();
const query = ref('');
const hits = ref([]);
const searching = ref(false);
const matchCase = ref(false);
const wholeWord = ref(false);
const regexMode = ref(false);
const truncated = ref(false);
const searchError = ref('');
let timer = null;
let seq = 0;

watch([query, matchCase, wholeWord, regexMode], () => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const q = query.value.trim();
    const my = ++seq;
    searchError.value = '';
    if (!q || !shell.dir || !window.studio?.searchFiles) {
      hits.value = [];
      truncated.value = false;
      return;
    }
    searching.value = true;
    try {
      const result = await window.studio.searchFiles(shell.dir, q, {
        matchCase: matchCase.value,
        wholeWord: wholeWord.value,
        regex: regexMode.value,
      });
      // 输入或选项已变化时丢弃过期结果
      if (my !== seq) return;
      hits.value = result.hits || [];
      truncated.value = !!result.truncated;
    } catch (err) {
      if (my !== seq) return;
      hits.value = [];
      truncated.value = false;
      searchError.value = String(err?.message || err);
    } finally {
      if (my === seq) searching.value = false;
    }
  }, 220);
});

const createEntry = (directory) => {
  if (shell.dir) shell.runtime?.fileOps.create(shell.dir, directory);
};
</script>

<template>
  <aside id="sidebar">
    <div class="sidebar-head">
      <div class="sidebar-tabs" role="tablist">
        <button
          class="sb-tab"
          data-view="files"
          role="tab"
          :class="{ 'is-active': shell.side === 'files' }"
          @click="shell.runtime?.selectSide('files')"
        >{{ t('side.files') }}</button>
        <button
          class="sb-tab"
          data-view="outline"
          role="tab"
          :class="{ 'is-active': shell.side === 'outline' }"
          @click="shell.runtime?.selectSide('outline')"
        >{{ t('side.outline') }}</button>
      </div>
    </div>
    <div v-show="shell.side === 'files'" id="file-search" class="file-search" :class="{ 'is-loading': searching }">
      <input
        id="file-search-input"
        v-model="query"
        type="search"
        :placeholder="t('side.searchPlaceholder')"
        :aria-label="t('side.searchAria')"
      />
      <button id="file-new-doc" type="button" :title="t('side.newDoc')" :aria-label="t('side.newDocAria')" @click="createEntry(false)">
        <FilePlus2 :size="14" :stroke-width="1.8" />
      </button>
      <button id="file-new-dir" type="button" :title="t('side.newDir')" :aria-label="t('side.newDirAria')" @click="createEntry(true)">
        <FolderPlus :size="14" :stroke-width="1.8" />
      </button>
    </div>
    <div v-show="shell.side === 'files'" class="file-search-opts" role="group" :aria-label="t('side.optsAria')">
      <button
        type="button"
        class="fs-opt"
        :class="{ 'is-on': matchCase }"
        :aria-pressed="matchCase"
        :title="t('side.matchCase')"
        @click="matchCase = !matchCase"
      >Aa</button>
      <button
        type="button"
        class="fs-opt"
        :class="{ 'is-on': wholeWord }"
        :aria-pressed="wholeWord"
        :title="t('side.wholeWord')"
        @click="wholeWord = !wholeWord"
      >{{ t('side.wholeWordBadge') }}</button>
      <button
        type="button"
        class="fs-opt"
        :class="{ 'is-on': regexMode }"
        :aria-pressed="regexMode"
        :title="t('side.regex')"
        @click="regexMode = !regexMode"
      >.*</button>
    </div>
    <FileTree
      v-show="shell.side === 'files'"
      :query="query.trim()"
      :hits="hits"
      :truncated="truncated"
      :error="searchError"
    />
    <OutlinePanel v-show="shell.side === 'outline'" />
  </aside>
  <div id="sidebar-split" :title="t('side.resize')"></div>
</template>