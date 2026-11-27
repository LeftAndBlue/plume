/**
 * 表格单元格就地编辑。
 *
 * 设计取舍：不去碰 CM 的 contentDOM。
 * 原子块 widget 里的 DOM 一旦被改，CM 的 DOM 校验会认为视图与 state 不一致，
 * 轻则重渲染丢掉正在输入的内容，重则把光标位置算错。所以这里用一层浮层：
 * 在单元格的位置上盖一个 <textarea>，视觉上就是「在格子里打字」，
 * 提交时换算成一次针对源码区间的 change —— 文档始终是唯一真相。
 *
 * 坐标：每个单元格在渲染时就拿到了它在源码里的 [from, to)，
 * 提交时直接 replace，不需要任何反解。
 */
import { EditorView } from '@codemirror/view';
import { scanTables, splitTableRow } from './rich-doc.js';
import { cloneTableRows } from './table-model.js';

/** @type {null | {el: HTMLTextAreaElement, view: EditorView, info: object}} */
let active = null;
let selfDispatch = false;
const ESC = (s) => s.replace(/\|/g, '\\|');
// 用定时器而不是 requestAnimationFrame：headless 里页面可能被判为不可见，
// rAF 会被节流甚至不触发，commit 就会卡在等待里。
const frame = () => new Promise((r) => setTimeout(r, 24));
/** 块级 widget 的 DOM 替换发生在 write 阶段，等两拍再查询更稳 */
const settle = async () => {
  await frame();
  await frame();
};

function findWrap(view, lineNo) {
  const wraps = view.dom.querySelectorAll('.cm-table-wrap');
  for (const w of wraps) if (w.dataset.line === String(lineNo)) return w;
  return null;
}

function cellAt(view, lineNo, row, col) {
  const wrap = findWrap(view, lineNo);
  if (!wrap) return null;
  const tr = wrap.querySelectorAll('tr')[row];
  return (tr && tr.children[col]) || null;
}

/**
 * 等单元格重新出现。
 * 块级 widget 要等 CM 把它重新写进 DOM，而这一拍是异步的（rAF 驱动），
 * 一次查不到就放弃会让「Tab 跳格」偶发失灵，所以这里退让几次再放弃。
 */
async function waitCell(view, lineNo, row, col, tries = 6, gap = 40) {
  for (let i = 0; i < tries; i++) {
    const td = cellAt(view, lineNo, row, col);
    if (td && td._cell) return td;
    await new Promise((r) => setTimeout(r, gap));
  }
  return null;
}

/** 在单元格原位盖一层 textarea */
export async function openCellEditor(view, td) {
  let info = td && td._cell;
  if (!info) return;
  rememberTableCell(info.tableLine, info.row, info.col);

  // 已经开着就先把上一格提交掉（点另一格 = 确认并跳转）；
  // 提交会改变源码长度，旧 DOM 上的偏移随之失效，所以提交后按行列重新取一次。
  if (active) {
    const want = { line: info.tableLine, row: info.row, col: info.col };
    await commit(null, { refocus: false });
    const fresh = await waitCell(view, want.line, want.row, want.col);
    if (!fresh) return;
    td = fresh;
    info = fresh._cell;
  }

  const rect = td.getBoundingClientRect();
  const cs = getComputedStyle(td);

  const ta = document.createElement('textarea');
  ta.className = 'cm-cell-editor';
  ta.value = info.text;
  ta.spellcheck = false;
  ta.setAttribute('aria-label', '编辑表格单元格');
  ta.dataset.row = String(info.row);
  ta.dataset.col = String(info.col);

  Object.assign(ta.style, {
    left: Math.round(rect.left) + 'px',
    top: Math.round(rect.top) + 'px',
    width: Math.round(rect.width) + 'px',
    minHeight: Math.round(rect.height) + 'px',
    height: Math.round(rect.height) + 'px',
    fontFamily: cs.fontFamily,
    fontSize: cs.fontSize,
    fontWeight: cs.fontWeight,
    lineHeight: cs.lineHeight,
    textAlign: cs.textAlign,
    padding: cs.padding,
    color: cs.color,
  });

  const syncHeight = () => {
    ta.style.height = 'auto';
    const nextH = Math.max(Math.round(rect.height), ta.scrollHeight);
    const capped = Math.min(320, nextH);
    ta.style.height = capped + 'px';
    ta.style.overflowY = nextH > 320 ? 'auto' : 'hidden';
  };
  ta.addEventListener('input', syncHeight);

  ta.addEventListener('mousedown', (e) => e.stopPropagation());
  ta.addEventListener('keydown', (e) => {
    // 中文输入法组字过程中的 Enter/Tab 属于 IME，不能当导航
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeCellEditor();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      commit(e.shiftKey ? 'prev' : 'next');
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        const from = ta.selectionStart;
        const to = ta.selectionEnd;
        ta.value = ta.value.slice(0, from) + '\n' + ta.value.slice(to);
        ta.selectionStart = ta.selectionEnd = from + 1;
        return;
      }
      commit(e.altKey ? 'up' : 'down');
    }
  });
  ta.addEventListener('blur', () => {
    if (!active || active.el !== ta) return;
    // 整个窗口失焦（切到别的应用）不要当成「编辑结束」，否则正在改的内容会被直接写回/关掉
    if (!document.hasFocus()) return;
    commit(null, { refocus: false });
  });

  document.body.appendChild(ta);
  active = { el: ta, view, info, td, rect };

  ta.focus();
  ta.select();
  syncHeight();

  // 滚动/改窗口时让浮层跟着单元格走（比「一滚就关」更接近直觉），
  // 单元格整体离开视口才收掉。
  const onScroll = () => {
    if (!active || active.el !== ta) return;
    const r = td.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) {
      closeCellEditor({ refocus: false });
      return;
    }
    ta.style.left = Math.round(r.left) + 'px';
    ta.style.top = Math.round(r.top) + 'px';
  };
  view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  active.cleanup = () => {
    view.scrollDOM.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onScroll);
  };
}

function closeCellEditor({ refocus = true } = {}) {
  if (!active) return;
  const { el, cleanup, view } = active;
  active = null;
  if (cleanup) cleanup();
  el.remove();
  if (refocus) view.focus();
}

/**
 * 提交当前单元格。
 * @param {null|'next'|'prev'|'down'|'up'} dir 提交后跳到哪一格
 */
async function commit(dir, { refocus = true } = {}) {
  const a = active;
  if (!a) return;
  active = null;
  if (a.cleanup) a.cleanup();

  const value = a.el.value;
  a.el.remove();

  const { view, info } = a;
  const doc = view.state.doc;
  // 文档在编辑期间被别处改过 → 区间已不可信，放弃写回
  const intact = info.to <= doc.length && doc.sliceString(info.from, info.to) === info.raw;

  if (intact) {
    const raw = ESC(value.replace(/\r\n?/g, '\n').replace(/\n/g, '<br>'));
    if (raw !== info.raw) {
      selfDispatch = true;
      try {
        view.dispatch({ changes: { from: info.from, to: info.to, insert: raw } });
      } finally {
        selfDispatch = false;
      }
    }
  }

  await settle();

  if (!dir) {
    if (refocus) view.focus();
    return;
  }

  let { row, col } = info;
  const maxRow = info.rows - 1;
  const maxCol = info.cols - 1;

  if (dir === 'next') {
    if (col < maxCol) col++;
    else {
      col = 0;
      row++;
    }
  } else if (dir === 'prev') {
    if (col > 0) col--;
    else if (row > 0) {
      row--;
      col = maxCol;
    }
  } else if (dir === 'down') {
    row++;
  } else if (dir === 'up') {
    row--;
  }

  if (row < 0) {
    view.focus();
    return;
  }

  if (row > maxRow) {
    // 越出末行 → 补一行（列数与表头一致）
    const wrap = findWrap(view, info.tableLine);
    const at = wrap ? Number(wrap.dataset.to) : info.tableTo;
    const blank = '|' + new Array(info.cols).fill('  ').join('|') + '|';
    view.dispatch({ changes: { from: at, insert: '\n' + blank } });
    await settle();
    row = maxRow + 1;
    col = Math.min(col, maxCol);
  }

  const td = await waitCell(view, info.tableLine, row, col);
  if (td) openCellEditor(view, td);
  else if (refocus) view.focus();
}

const tableCursor = new Map();

export function tableCursorAt(lineNo) {
  return tableCursor.get(lineNo) || { row: 0, col: 0 };
}

function rememberTableCell(lineNo, row, col) {
  tableCursor.set(lineNo, { row, col });
}

/** 把还开着的格子写回源码。工具条改表格结构之前先调用，避免浮层指向过期区间。 */
export function commitCellEditor() {
  if (!active) return Promise.resolve();
  return commit(null, { refocus: false });
}

function splitCells(text) {
  return splitTableRow(text).map((cell) => cell.raw);
}

function joinRow(cells) {
  return '| ' + cells.join(' | ') + ' |';
}

function locateTable(doc, lineNo) {
  const table = scanTables(doc).find((item) => item.startLine === lineNo);
  return table ? { from: table.from, to: table.to } : null;
}

/**
 * 按当前表头行号重读整张表，再整段写回。
 * 不沿用 widget 上的 from/to：格子刚提交过的话，末尾偏移已经变了。
 */
export async function editTable(view, lineNo, mutate) {
  if (active) await commit(null, { refocus: false });
  const found = locateTable(view.state.doc, lineNo);
  if (!found) return false;
  const raw = view.state.doc.sliceString(found.from, found.to);
  const rows = raw.split('\n').filter((line) => line.trim()).map(splitCells);
  if (rows.length < 2) return false;
  const copy = cloneTableRows(rows);
  if (mutate(copy) === false) return false;
  const text = copy.map(joinRow).join('\n');
  if (text === raw) return false;
  view.dispatch({ changes: { from: found.from, to: found.to, insert: text } });
  view.focus();
  return true;
}

/* ---------------- 格式化表格源码（Typora 的「格式化表格源码」） ---------------- */

/** 显示宽度：CJK / 全角字符按 2 列算，其余按 1 列，用于把源码表格对齐。 */
function displayWidth(text) {
  let n = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0) || 0;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd);
    n += wide ? 2 : 1;
  }
  return n;
}

const padTo = (text, width) => text + ' '.repeat(Math.max(0, width - displayWidth(text)));

function alignOfSpec(spec) {
  const s = String(spec || '').trim();
  if (s.startsWith(':') && s.endsWith(':')) return 'center';
  if (s.endsWith(':')) return 'right';
  return 'left';
}

/** 与 setAlign 的写法保持一致：左对齐也带前冒号（`:---`）。 */
function specFor(align, width) {
  const w = Math.max(3, width);
  if (align === 'center') return `:${'-'.repeat(Math.max(1, w - 2))}:`;
  if (align === 'right') return `${'-'.repeat(Math.max(2, w - 1))}:`;
  return `:${'-'.repeat(Math.max(2, w - 1))}`;
}

/**
 * 把整张表的源码按列宽重新对齐（中文按 2 宽），分隔行按原对齐方式重写。
 * 只改源码排版，不改变单元格内容。
 */
export async function formatTable(view, lineNo) {
  if (active) await commit(null, { refocus: false });
  const found = locateTable(view.state.doc, lineNo);
  if (!found) return false;
  const raw = view.state.doc.sliceString(found.from, found.to);
  const rows = raw
    .split('\n')
    .filter((line) => line.trim())
    .map(splitCells);
  if (rows.length < 2) return false;

  const cols = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: cols }, () => 3);
  rows.forEach((row, index) => {
    if (index === 1) return; // 分隔行由对齐方式重新生成
    for (let c = 0; c < cols; c++) {
      widths[c] = Math.max(widths[c], displayWidth(String(row[c] ?? '').trim()));
    }
  });

  const out = rows
    .map((row, index) => {
      const cells = [];
      for (let c = 0; c < cols; c++) {
        const text = String(row[c] ?? '').trim();
        cells.push(index === 1 ? specFor(alignOfSpec(text), widths[c]) : padTo(text, widths[c]));
      }
      return joinRow(cells);
    })
    .join('\n');

  if (out === raw) return false;
  view.dispatch({ changes: { from: found.from, to: found.to, insert: out } });
  view.focus();
  return true;
}

/** 供外部（例如打开新文件）强制作废当前编辑 */
export function cancelCellEditor() {
  if (!active) return;
  const { el, cleanup } = active;
  active = null;
  if (cleanup) cleanup();
  el.remove();
}
