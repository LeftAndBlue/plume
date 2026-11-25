/**
 * 表格单元格 / 整行选区状态。
 *
 * 按表格首行行号索引，widget 因源码变化重建后仍能读到。坐标是视觉行列：
 * row 0 = 表头，col 0 = 第一列。选区永远是矩形（anchor → head）。
 * 这里只存数据和刷 DOM 高亮，不派发编辑器事务。
 */
const selections = new Map();

const norm = (p) => ({ row: p.row, col: p.col });

export function getTableSelection(lineNo) {
  const s = selections.get(lineNo);
  return s ? { anchor: { ...s.anchor }, head: { ...s.head } } : null;
}

/** 归一化的矩形边界；没有选区返回 null */
export function tableSelectionBounds(lineNo) {
  const s = selections.get(lineNo);
  if (!s) return null;
  return {
    r1: Math.min(s.anchor.row, s.head.row),
    r2: Math.max(s.anchor.row, s.head.row),
    c1: Math.min(s.anchor.col, s.head.col),
    c2: Math.max(s.anchor.col, s.head.col),
  };
}

/** 返回当前任意存在多选区的表格 `{ lineNo, bounds }`（全局快捷键使用）。 */
export function getActiveTableSelection() {
  for (const [lineNo] of selections.entries()) {
    const bounds = tableSelectionBounds(lineNo);
    if (bounds) return { lineNo, bounds };
  }
  return null;
}

export function setTableSelection(lineNo, anchor, head = anchor) {
  selections.set(lineNo, { anchor: norm(anchor), head: norm(head) });
}

export function clearTableSelection(lineNo) {
  if (lineNo == null) selections.clear();
  else selections.delete(lineNo);
}

/** 选区覆盖的视觉行号（含表头 0），升序 */
export function selectedRows(lineNo) {
  const b = tableSelectionBounds(lineNo);
  if (!b) return [];
  return Array.from({ length: b.r2 - b.r1 + 1 }, (_, i) => b.r1 + i);
}

/** 选区覆盖的列号，升序 */
export function selectedCols(lineNo) {
  const b = tableSelectionBounds(lineNo);
  if (!b) return [];
  return Array.from({ length: b.c2 - b.c1 + 1 }, (_, i) => b.c1 + i);
}

/** 把当前选区刷到某个表格 widget 的 DOM 上（不触发重建） */
export function paintTableSelection(wrap, lineNo) {
  const b = tableSelectionBounds(lineNo);
  for (const cell of wrap.querySelectorAll('td, th')) {
    const c = cell._cell;
    if (!c) continue;
    cell.classList.toggle(
      'is-selected',
      !!b && c.row >= b.r1 && c.row <= b.r2 && c.col >= b.c1 && c.col <= b.c2,
    );
  }
}

/** 点表格外就取消选择：全局只挂一次；点击右键菜单或格式浮条时不提前清空选区。 */
let dismissBound = false;
export function bindTableSelectionDismiss() {
  if (dismissBound || typeof document === 'undefined') return;
  dismissBound = true;
  document.addEventListener(
    'mousedown',
    (e) => {
      if (
        e.target instanceof Element &&
        e.target.closest('.cm-table-wrap, .ft-context, .app-context, .fmt-pop')
      ) {
        return;
      }
      if (!selections.size) return;
      selections.clear();
      for (const el of document.querySelectorAll('.cm-table-wrap .is-selected')) {
        el.classList.remove('is-selected');
      }
    },
    true,
  );
}
