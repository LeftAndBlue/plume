<script setup>
import { ref, watch, nextTick } from 'vue';
import { ChevronRight } from 'lucide-vue-next';
import { useShellStore } from '../stores/shell.js';
import { t } from '../i18n.js';

const shell = useShellStore();
const panel = ref(null);

const jump = (item, index) => shell.runtime?.outlineJump(item.pos, index);
const toggle = (item) => {
  shell.toggleOutlineCollapsed(item.key);
  shell.runtime?.refreshOutline();
};

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
    <p v-if="!shell.outlineItems.length" class="outline-empty">{{ t('outline.empty') }}</p>
    <button
      v-for="(item, index) in shell.outlineItems"
      v-show="!item.hidden"
      :key="item.key"
      class="outline-item"
      :class="{ 'is-current': shell.outlineCurrent === index, 'is-open': item.hasChild && !shell.outlineCollapsed[item.key] }"
      :data-level="item.level"
      :title="item.text"
      @click="jump(item, index)"
    >
      <span
        v-if="item.hasChild"
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
