<script setup>
import { ref, computed, watch, nextTick } from 'vue';
import { ChevronRight, Search, X } from 'lucide-vue-next';
import { useShellStore } from '../stores/shell.js';
import { t } from '../i18n.js';

const shell = useShellStore();
const panel = ref(null);
const filterQuery = ref('');

const jump = (item, index) => shell.runtime?.outlineJump(item.pos, index);
const toggle = (item) => {
  shell.toggleOutlineCollapsed(item.key);
  shell.runtime?.refreshOutline();
};

const normalizedFilter = computed(() => filterQuery.value.trim().toLowerCase());
const visibleEntries = computed(() => {
  const q = normalizedFilter.value;
  return shell.outlineItems
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => {
      if (q) return String(item.text || '').toLowerCase().includes(q);
      return !item.hidden;
    });
});

// 高亮项滚出侧栏可视区时带回来；只动自己那一栏的 scrollTop（不 scrollIntoView 整个窗口）。
watch(
  () => shell.outlineCurrent,
  async () => {
    await nextTick();
    const box = panel.value;
    const lit = box?.querySelector('.outline-item.is-current');
    if (!box || !lit) return;
    const r = lit.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    if (r.height === 0 || b.height === 0) return;
    if (r.top < b.top + 4) box.scrollTop -= b.top - r.top + 8;
    else if (r.bottom > b.bottom - 4) box.scrollTop += r.bottom - b.bottom + 8;
  },
);
</script>

<template>
  <nav id="outline" ref="panel" class="sb-panel" role="tabpanel">
    <div v-if="shell.outlineItems.length" class="outline-filter">
      <Search :size="12" :stroke-width="1.8" class="outline-filter-icon" />
      <input
        v-model="filterQuery"
        type="search"
        class="outline-filter-input"
        :placeholder="t('outline.filterPlaceholder')"
        :aria-label="t('outline.filterAria')"
        @keydown.esc="filterQuery = ''"
      />
      <button
        v-if="filterQuery"
        type="button"
        class="outline-filter-clear"
        :title="t('outline.clearFilter')"
        @click="filterQuery = ''"
      >
        <X :size="12" :stroke-width="1.8" />
      </button>
    </div>
    <p v-if="!shell.outlineItems.length" class="outline-empty">{{ t('outline.empty') }}</p>
    <p v-else-if="!visibleEntries.length" class="outline-empty">{{ t('outline.noMatch') }}</p>
    <button
      v-for="{ item, index } in visibleEntries"
      :key="item.key"
      class="outline-item"
      :class="{ 'is-current': shell.outlineCurrent === index, 'is-open': item.hasChild && !shell.outlineCollapsed[item.key] }"
      :data-level="item.level"
      :title="item.text"
      @mousedown.prevent
      @click="jump(item, index)"
    >
      <span
        v-if="item.hasChild && !normalizedFilter"
        class="outline-caret"
        :title="shell.outlineCollapsed[item.key] ? t('outline.expand') : t('outline.collapse')"
        @click.prevent.stop="toggle(item)"
      >
        <ChevronRight :size="12" />
      </span>
      <span v-else class="outline-caret-slot"></span>
      <span class="outline-label">{{ item.text }}</span>
    </button>
  </nav>
</template>
