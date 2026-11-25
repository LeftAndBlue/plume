<script setup>
import { ref, watch } from 'vue';
import { FilePlus2, FolderPlus, ReplaceAll } from 'lucide-vue-next';
import { useShellStore } from '../stores/shell.js';
import { t } from '../i18n.js';
import FileTree from './FileTree.vue';
import OutlinePanel from './OutlinePanel.vue';

const shell = useShellStore();
const query = ref('');
const replaceText = ref('');
const showReplace = ref(false);
const replacing = ref(false);
const replaceMsg = ref('');
const hits = ref([]);
const searching = ref(false);
const matchCase = ref(false);
const wholeWord = ref(false);
const regexMode = ref(false);
const truncated = ref(false);
const searchError = ref('');
let timer = null;
let seq = 0;

async function runSearch() {
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
}

watch([query, matchCase, wholeWord, regexMode], () => {
  replaceMsg.value = '';
  clearTimeout(timer);
  timer = setTimeout(runSearch, 220);
});

async function runReplaceAll() {
  const q = query.value.trim();
  if (!q || !shell.dir || !window.studio?.replaceInFiles || replacing.value) return;
  const contentHits = hits.value.filter((h) => h.line > 0);
  const fileCount = new Set(contentHits.map((h) => h.path)).size;
  const prompt = t('side.replaceConfirm', {
    q,
    r: replaceText.value,
    files: fileCount || '多个',
  });
  const ok = window.studio?.confirm ? await window.studio.confirm(prompt) : window.confirm(prompt);
  if (!ok) return;

  replacing.value = true;
  replaceMsg.value = '';
  searchError.value = '';
  try {
    const res = await window.studio.replaceInFiles(shell.dir, q, replaceText.value, {
      matchCase: matchCase.value,
      wholeWord: wholeWord.value,
      regex: regexMode.value,
    });
    if (res?.changedPaths?.length) {
      await shell.runtime?.reloadModifiedFiles?.(res.changedPaths);
    }
    replaceMsg.value = res?.replacements
      ? t('side.replaceDone', { n: res.replacements, files: res.filesChanged })
      : t('side.replaceNone');
    await runSearch();
  } catch (err) {
    searchError.value = String(err?.message || err);
  } finally {
    replacing.value = false;
  }
}

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
      <button
        id="file-replace-toggle"
        type="button"
        :class="{ 'is-on': showReplace }"
        :title="t('side.toggleReplace')"
        :aria-label="t('side.toggleReplace')"
        @click="showReplace = !showReplace"
      >
        <ReplaceAll :size="14" :stroke-width="1.8" />
      </button>
      <button id="file-new-doc" type="button" :title="t('side.newDoc')" :aria-label="t('side.newDocAria')" @click="createEntry(false)">
        <FilePlus2 :size="14" :stroke-width="1.8" />
      </button>
      <button id="file-new-dir" type="button" :title="t('side.newDir')" :aria-label="t('side.newDirAria')" @click="createEntry(true)">
        <FolderPlus :size="14" :stroke-width="1.8" />
      </button>
    </div>
    <div v-show="shell.side === 'files' && showReplace" class="file-replace-row">
      <input
        id="file-replace-input"
        v-model="replaceText"
        type="text"
        :placeholder="t('side.replacePlaceholder')"
        :aria-label="t('side.replacePlaceholder')"
        @keydown.enter="runReplaceAll"
      />
      <button
        type="button"
        class="fs-replace-btn"
        :disabled="!query.trim() || replacing || !shell.dir"
        @click="runReplaceAll"
      >
        {{ replacing ? '…' : t('side.replaceAll') }}
      </button>
    </div>
    <p v-if="shell.side === 'files' && replaceMsg" class="file-replace-msg">{{ replaceMsg }}</p>
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