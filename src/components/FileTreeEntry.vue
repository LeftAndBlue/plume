<script setup>
import { computed, inject } from 'vue';
import { ChevronRight, Folder, FileText } from 'lucide-vue-next';
import { useShellStore } from '../stores/shell.js';
import { relTime, fileSnippet, stripMdExt } from './file-tree-utils.js';
import { plainInline } from '../editor/inline-text.js';
import { t } from '../i18n.js';

const props = defineProps({ entry: Object, depth: Number });
const shell = useShellStore();
const tree = inject('fileTree');

const snippet = computed(() => (props.entry.dir ? '' : fileSnippet(props.entry.snippet, plainInline)));
const title = computed(() => props.entry.path + (snippet.value ? '\n' + snippet.value : ''));
const isActive = computed(() => !props.entry.dir && tree.samePath(props.entry.path, shell.path));

const onClick = () => {
  if (props.entry.dir) tree.toggle(props.entry.path);
  else shell.runtime?.openPath(props.entry.path);
};
const onContext = (event) => tree.showContext(event, props.entry);
const onDrop = (event) => {
  event.preventDefault();
  event.currentTarget.classList.remove('is-drop-target');
  const source = event.dataTransfer?.getData('application/x-plume-path');
  if (source) shell.runtime?.fileOps.move(source, props.entry.path);
};
</script>

<template>
  <button
    class="ft-row"
    :class="{ 'is-open': entry.dir && tree.openDirs.has(entry.path), 'is-active': isActive }"
    :data-dir="entry.dir ? '1' : '0'"
    :style="{ paddingLeft: 6 + depth * 12 + 'px' }"
    :title="title"
    draggable="true"
    @click="onClick"
    @contextmenu="onContext"
    @dragstart="tree.onDragStart($event, entry)"
    @dragover="entry.dir && tree.onDragOver($event)"
    @dragleave="$event.currentTarget.classList.remove('is-drop-target')"
    @drop="entry.dir && onDrop($event)"
  >
    <span v-if="entry.dir" class="ft-caret"><ChevronRight :size="12" /></span>
    <span v-else class="ft-caret"></span>
    <span class="ft-icon">
      <Folder v-if="entry.dir" :size="14" :stroke-width="1.8" />
      <FileText v-else :size="14" :stroke-width="1.8" />
    </span>
    <span class="ft-name">{{ stripMdExt(entry.name) }}</span>
    <span v-if="!entry.dir" class="ft-time">{{ relTime(entry.mtime) }}</span>
  </button>
  <div v-if="entry.dir" class="ft-children">
    <template v-if="tree.openDirs.has(entry.path)">
      <FileTreeEntry
        v-for="child in tree.childrenOf(entry.path)"
        :key="child.path"
        :entry="child"
        :depth="depth + 1"
      />
      <p v-if="tree.childrenOf(entry.path) && !tree.childrenOf(entry.path).length" class="ft-empty">{{ t('tree.emptyDir') }}</p>
    </template>
  </div>
</template>

<script>
export default { name: 'FileTreeEntry' };
</script>
