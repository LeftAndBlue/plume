<script setup>
import { reactive, ref, watch, provide } from 'vue';
import { FileText } from 'lucide-vue-next';
import { useShellStore } from '../stores/shell.js';
import FileTreeEntry from './FileTreeEntry.vue';
import { t } from '../i18n.js';
import { stripMdExt } from './file-tree-utils.js';

const props = defineProps({ query: String, hits: Array, truncated: Boolean, error: String });
const shell = useShellStore();

const rootEntries = ref(null);
const openDirs = reactive(new Set());
const children = reactive({});

const samePath = (a, b) =>
  !!a && !!b && a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();

let lastDir = null;
let loadSeq = 0;

// 刷新（fs-changed / 自动保存触发）不清空展开状态：根列表原地替换，
// 已展开的子目录逐个重拉，避免打字时子目录内容周期性消失。
async function loadRoot() {
  const seq = ++loadSeq;
  const dir = shell.dir;
  if (dir !== lastDir) {
    lastDir = dir;
    openDirs.clear();
    Object.keys(children).forEach((k) => delete children[k]);
    rootEntries.value = null;
  }
  if (!dir || !window.studio?.listDir) {
    rootEntries.value = [];
    return;
  }
  const entries = await window.studio.listDir(dir);
  if (seq !== loadSeq) return; // 更新的一轮刷新已在路上，丢弃本轮结果
  rootEntries.value = entries;
  const dirs = [...openDirs];
  if (!dirs.length) return;
  const lists = await Promise.all(dirs.map((p) => window.studio.listDir(p)));
  if (seq !== loadSeq) return;
  dirs.forEach((p, i) => {
    children[p] = lists[i];
  });
}

watch(
  () => [shell.dir, shell.fileTreeVersion],
  loadRoot,
  { immediate: true },
);

// Rust 目录监听到工作区文件变化时刷新（编辑器保存/外部改动都会触发）
window.studio?.onFsChanged?.(() => {
  if (shell.dir) loadRoot();
});

async function toggle(path) {
  if (openDirs.has(path)) openDirs.delete(path);
  else {
    openDirs.add(path);
    if (!children[path]) children[path] = await window.studio.listDir(path);
  }
}
const childrenOf = (path) => children[path];

function showContext(event, entry) {
  const api = shell.runtime;
  if (!api) return;
  const items = [];
  if (!entry.dir) items.push({ label: '打开', action: () => api.openPath(entry.path) });
  if (entry.dir) {
    items.push(
      { label: '新建文档', action: () => api.fileOps.create(entry.path, false) },
      { label: '新建文件夹', action: () => api.fileOps.create(entry.path, true) },
    );
  }
  items.push(
    { separator: true },
    { label: '复制路径', action: () => api.fileOps.copyText(entry.path, '路径已复制') },
    { label: '在文件管理器中显示', action: () => window.studio.showFsEntry(shell.dir, entry.path) },
    { separator: true },
    { label: '重命名…', action: () => api.fileOps.rename(entry) },
    { label: '移到回收站', danger: true, action: () => api.fileOps.trash(entry) },
  );
  api.contextMenu(event, items);
}

provide('fileTree', {
  openDirs,
  toggle,
  childrenOf,
  samePath,
  showContext,
  onDragStart(event, entry) {
    event.dataTransfer?.setData('application/x-plume-path', entry.path);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  },
  onDragOver(event) {
    if (event.dataTransfer?.types.includes('application/x-plume-path')) {
      event.preventDefault();
      event.currentTarget.classList.add('is-drop-target');
    }
  },
});
</script>

<template>
  <div id="file-tree" class="sb-panel" role="tabpanel">
    <!-- 跨文件搜索结果（含命中行上下文预览） -->
    <template v-if="query">
      <p v-if="error" class="ft-empty ft-search-error">{{ error }}</p>
      <p v-else-if="!hits.length" class="ft-empty">{{ t('tree.notFound', { q: query }) }}</p>
      <button
        v-for="hit in hits"
        :key="hit.path + ':' + hit.line + ':' + hit.col"
        class="ft-row ft-hit"
        data-dir="0"
        :title="hit.path + (hit.text ? '\n' + hit.text : '')"
        @click="shell.runtime?.openSearchHit(hit)"
      >
        <div class="ft-hit-head">
          <span class="ft-icon"><FileText :size="14" :stroke-width="1.8" /></span>
          <span class="ft-name">{{ stripMdExt(hit.name) }}</span>
          <span class="ft-time">{{ hit.line ? t('tree.lineNo', { n: hit.line }) : t('tree.fileName') }}</span>
        </div>
        <div v-if="hit.text" class="ft-hit-snippet">{{ hit.text }}</div>
      </button>
      <p v-if="truncated" class="ft-empty">{{ t('tree.truncated') }}</p>
    </template>

    <template v-else>
      <p v-if="!shell.dir" class="ft-empty">
        {{ t('tree.noDoc') }}
        <button type="button" @click="shell.runtime?.run('open')">{{ t('tree.openFile') }}</button>
      </p>
      <template v-else>
        <div class="ft-root" :title="shell.dir">{{ shell.dir.split(/[\\/]/).pop() || shell.dir }}</div>
        <p v-if="rootEntries === null" class="ft-empty">{{ t('tree.loading') }}</p>
        <template v-else>
          <FileTreeEntry v-for="entry in rootEntries" :key="entry.path" :entry="entry" :depth="0" />
          <p v-if="!rootEntries.length" class="ft-empty">{{ t('tree.empty') }}</p>
          <div v-if="rootEntries.length >= 300" class="ft-too-many">
            <div class="ft-too-many-mask"></div>
            <p class="ft-too-many-text">{{ t('tree.tooMany') }}</p>
          </div>
        </template>
      </template>
    </template>
  </div>
</template>
