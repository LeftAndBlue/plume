/**
 * 大纲数据计算、当前章节追踪与跳转（从 runtime.js 抽离）。
 * 渲染由 Vue OutlinePanel 组件负责，这里负责数据同步与滚动跟随计算。
 */
import { EditorView } from '@codemirror/view';
import { buildOutline } from './outline.js';
import { unfoldCurrentHeading } from './heading-fold.js';
import { blinkLine } from './widgets.js';

export function createOutlineSync({
  shell,
  getActiveView,
  getPrimaryView,
  sidebarVisible,
  sideView,
  recordJumpOrigin,
}) {
  let outlineTimer = null;
  /* 大纲条目（pos/parent），当前章节计算用；展示数据在 Pinia 里 */
  let outlineItems = [];
  const outlineSpyBoundViews = new WeakSet();
  let outlineMeasurePending = false;
  /** 折叠状态以 Pinia 为准（组件切换后调 refreshOutline 重算）。 */
  let outlineCollapsed = new Set();

  function scheduleOutline() {
    clearTimeout(outlineTimer);
    outlineTimer = setTimeout(renderOutline, 200);
  }

  function outlineKeys(items) {
    const stack = [];
    const counts = new Map();
    return items.map((it) => {
      while (stack.length && stack[stack.length - 1].level >= it.level) stack.pop();
      const parent = stack.map((s) => s.level + ':' + s.text).join('/');
      const id = parent + '|' + it.level + ':' + it.text;
      const n = counts.get(id) || 0;
      counts.set(id, n + 1);
      stack.push({ level: it.level, text: it.text });
      return id + '#' + n;
    });
  }

  function outlineMeta(items, keys) {
    const stack = [];
    return items.map((it, i) => {
      while (stack.length && items[stack[stack.length - 1]].level >= it.level) stack.pop();
      const parent = stack.length ? stack[stack.length - 1] : -1;
      const hidden = stack.some((idx) => outlineCollapsed.has(keys[idx]));
      const hasChild = i + 1 < items.length && items[i + 1].level > it.level;
      stack.push(i);
      return { parent, hidden, hasChild, key: keys[i] };
    });
  }

  /**
   * 纯读：当前章节在 outlineItems 里的下标（-1 = 还在第一个标题之上）。
   */
  function currentHeadingIndex(targetView = getActiveView()) {
    const head = targetView.state.selection.main.head;
    const scroller = targetView.scrollDOM;
    const top = scroller.scrollTop;
    const bottom = top + scroller.clientHeight;
    const max = targetView.state.doc.length;
    const headBlock = targetView.lineBlockAt(Math.min(head, max));
    const caretVisible = headBlock.bottom > top + 2 && headBlock.top < bottom - 2;
    if (caretVisible) {
      let cur = -1;
      for (let i = 0; i < outlineItems.length; i++) {
        if (outlineItems[i].pos <= head) cur = i;
        else break;
      }
      return cur;
    }
    let cur = -1;
    const atEnd = top + scroller.clientHeight >= scroller.scrollHeight - 2;
    const probe = atEnd ? bottom - 8 : top + 8;
    for (let i = 0; i < outlineItems.length; i++) {
      const blk = targetView.lineBlockAt(Math.min(outlineItems[i].pos, max));
      if (blk.top <= probe) cur = i;
      else break;
    }
    return cur;
  }

  function paintOutlineCurrent(cur) {
    // 当前项被折叠时点亮最近的可见父级；可见性与滚动跟随由 OutlinePanel 负责。
    let shown = cur;
    const items = shell.outlineItems;
    while (shown >= 0 && items[shown]?.hidden) shown = outlineItems[shown].parent;
    shell.setOutlineCurrent(shown);
  }

  /**
   * 滚动/移光标后点亮当前章节。读 layout 必须走 requestMeasure。
   */
  function syncOutlineCurrent() {
    if (!outlineItems.length || outlineMeasurePending) return;
    if (!sidebarVisible() || sideView() !== 'outline') return;
    const av = getActiveView();
    outlineMeasurePending = true;
    av.requestMeasure({
      read: () => {
        outlineMeasurePending = false;
        return currentHeadingIndex(av);
      },
      write: (cur) => paintOutlineCurrent(cur),
    });
  }

  function bindOutlineSpy(targetView = getActiveView()) {
    if (!targetView || outlineSpyBoundViews.has(targetView)) return;
    outlineSpyBoundViews.add(targetView);
    targetView.scrollDOM.addEventListener('scroll', syncOutlineCurrent, {
      passive: true,
    });
  }

  function renderOutline() {
    const av = getActiveView();
    outlineCollapsed = new Set(
      Object.keys(shell.outlineCollapsed).filter((k) => shell.outlineCollapsed[k]),
    );
    const items = buildOutline(av.state);
    const meta = outlineMeta(items, outlineKeys(items));
    outlineItems = items.map((it, i) => ({ pos: it.pos, parent: meta[i].parent }));
    shell.setOutline(
      items.map((it, i) => ({
        level: it.level,
        text: it.text,
        pos: it.pos,
        key: meta[i].key,
        parent: meta[i].parent,
        hasChild: meta[i].hasChild,
        hidden: meta[i].hidden,
      })),
    );
    bindOutlineSpy(av);
    syncOutlineCurrent();
  }

  /** 大纲点击跳转（OutlinePanel 调用）：中间的标题放到正文区正中。 */
  function outlineJump(pos, index) {
    const av = getActiveView();
    if (av === getPrimaryView()) recordJumpOrigin();
    const isFirstLine = index === 0 && av.state.doc.lineAt(pos).number === 1;
    // 先聚焦再改选区，确保 CM 同步写入 DOM Selection
    av.contentDOM.focus({ preventScroll: true });
    av.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, {
        y: index === 0 ? 'start' : 'center',
        yMargin: isFirstLine ? 80 : 56,
      }),
    });
    unfoldCurrentHeading(av);
    if (isFirstLine) {
      av.scrollDOM.scrollTo({ top: 0 });
    }
    blinkLine(av, pos);
  }

  return {
    scheduleOutline,
    renderOutline,
    syncOutlineCurrent,
    outlineJump,
  };
}
