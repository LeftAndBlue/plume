import { EditorView, WidgetType } from '@codemirror/view';
import { StateEffect, StateField } from '@codemirror/state';
import { commitCellEditor, editTable, openCellEditor, tableCursorAt } from './table-edit.js';
import { renderInline, renderTex, isTexReady } from './inline-text.js';
import { openLangMenu } from './lang-menu.js';
import {
  deleteTableCol,
  deleteTableRow,
  insertTableCol,
  insertTableRow,
  setAlign,
  setTableColumnWidth,
  sortTableRows,
} from './table-model.js';

/* ---------------- 资源路径解析 ---------------- */

let docBase = null;

export function setDocBase(url) {
  docBase = url || null;
}

/** 跳转到某一行时闪一下黄底，方便眼睛跟上。 */
export function blinkLine(view, pos) {
  requestAnimationFrame(() => {
    const safe = Math.max(0, Math.min(pos, view.state.doc.length));
    const dom = view.domAtPos(safe);
    const node = dom.node.nodeType === 1 ? dom.node : dom.node.parentElement;
    const line = node && node.closest ? node.closest('.cm-line') : null;
    if (!line) return;
    line.classList.remove('blink-area');
    void line.offsetWidth;
    line.classList.add('blink-area');
    setTimeout(() => line.classList.remove('blink-area'), 8000);
  });
}

/** 当前文档基址。widget 要把它记进 eq()，换文档时才能拿到新基址重算。 */
export function currentDocBase() {
  return docBase;
}

const SCHEME = /^(https?:|data:|blob:|file:|mailto:)/i;

const defaultLocalUrl = (raw) => {
  const clean = String(raw).replace(/\\/g, '/').replace(/[?#]/g, encodeURIComponent);
  if (clean.startsWith('//')) return new URL('file:' + clean).href;
  return new URL('file:///' + clean).href;
};

let localUrlConverter = defaultLocalUrl;

/**
 * 本地绝对路径的 URL 由宿主决定：
 * 浏览器 dev / 导出自检里沿用 file://；Tauri 的 WebView2 不允许页面加载 file:// 子资源，
 * 必须换成 asset protocol（convertFileSrc），否则绝对路径图片一律显示「无法加载图片」。
 */
export function setLocalUrlConverter(fn) {
  localUrlConverter = typeof fn === 'function' ? fn : defaultLocalUrl;
}

/**
 * 解析图片 / 链接地址。顺序对齐 Typora：
 *   1. 带协议的照抄（外链、data URI）
 *   2. Windows 盘符、UNC、Unix 绝对路径 —— 与文档位置无关，直接转 file:// URL
 *   3. 其余按「相对本文档所在目录」解析
 *
 * 两个坑：`new URL('C:/a.png')` 会把 c: 当协议，所以盘符路径得自己补 file:///；
 * 而 `#` `?` 在文件名里是合法字符，先编码掉，免得被当成片段/查询截断。
 */
export function resolveSrc(src) {
  if (!src) return '';
  if (SCHEME.test(src)) return src;

  const clean = src.replace(/\\/g, '/').replace(/[?#]/g, encodeURIComponent);
  try {
    // UNC：\\server\share\x.png -> //server/share/x.png -> file://server/share/x.png
    // Tauri 下这两支走 asset protocol；原始路径（含反斜杠）交给宿主转换器处理。
    if (clean.startsWith('//')) return localUrlConverter(src);
    if (/^[a-zA-Z]:\//.test(clean)) return localUrlConverter(src);
    if (clean.startsWith('/')) return new URL('file://' + clean).href;
    if (!docBase) return clean;
    return new URL(clean, docBase).href;
  } catch {
    return clean;
  }
}

/* ---------------- 纯文本替换件（列表圆点等） ---------------- */

export class TextWidget extends WidgetType {
  constructor(text, cls) {
    super();
    this.text = text;
    this.cls = cls || '';
  }
  eq(other) {
    return other.text === this.text && other.cls === this.cls;
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = this.cls;
    el.textContent = this.text;
    el.style.userSelect = 'none';
    return el;
  }
  ignoreEvent() {
    // 列表序号是替换件。返回 false 时，点击会被吸回 ListMark 的起点，光标永远落在数字前面。
    return true;
  }
}

/* ---------------- 任务清单勾选框 ---------------- */

export class TaskWidget extends WidgetType {
  constructor(checked, pos) {
    super();
    this.checked = checked;
    this.pos = pos;
  }
  eq(other) {
    return other.checked === this.checked && other.pos === this.pos;
  }
  toDOM(view) {
    const el = document.createElement('span');
    el.className = 'cm-task' + (this.checked ? ' is-done' : '');
    el.setAttribute('role', 'checkbox');
    el.setAttribute('aria-checked', String(this.checked));
    el.setAttribute('title', this.checked ? '标记为未完成' : '标记为已完成');
    el.addEventListener('mousedown', (e) => e.preventDefault());
    el.addEventListener('click', (e) => {
      e.preventDefault();
      view.dispatch({
        changes: { from: this.pos, to: this.pos + 1, insert: this.checked ? ' ' : 'x' },
      });
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

/* ---------------- 分割线 ---------------- */

export class HrWidget extends WidgetType {
  constructor(pos) {
    super();
    this.pos = pos;
  }
  eq(other) {
    return other.pos === this.pos;
  }
  toDOM() {
    const d = document.createElement('div');
    d.className = 'cm-hr';
    d.appendChild(document.createElement('hr'));
    return d;
  }
  ignoreEvent() {
    return true;
  }
}

/* ---------------- 图片 ---------------- */

/** 点开后在图片上方编辑整段图片语法，例如 `![](assets/a.png)`。光标离开就收起。 */

export function formatImageMd(alt, src, title, attrs) {
  const quoted = title ? ` "${String(title).replace(/"/g, '\\"')}"` : '';
  const dest = /[\s()]/.test(src) ? `<${src}>` : src;
  return `![${alt || ''}](${dest}${quoted})${attrs || ''}`;
}

export function parseImageMd(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const m = /^!\[([^\]]*)\]\(([\s\S]*?)\)\s*(\{[^{}]*\})?\s*$/.exec(raw);
  if (!m) return null;
  let inner = m[2].trim();
  let title = '';
  const tm = /\s+"([^"]*)"\s*$/.exec(inner);
  if (tm) {
    title = tm[1];
    inner = inner.slice(0, tm.index).trim();
  }
  const src = inner.replace(/^</, '').replace(/>$/, '').trim();
  if (!src) return null;
  return { alt: m[1], src, title, attrs: m[3] || '' };
}
export const setEditingImage = StateEffect.define();

export const editingImageField = StateField.define({
  create: () => null,
  update(value, tr) {
    let next = value
      ? { from: tr.changes.mapPos(value.from), to: tr.changes.mapPos(value.to, 1) }
      : null;
    for (const e of tr.effects) if (e.is(setEditingImage)) next = e.value;
    if (!next || next.from >= next.to || next.from > tr.state.doc.length) return null;
    // 块级图片会把光标挤到这一行的行首或行尾，不能因此立刻退出编辑。
    const line = tr.state.doc.lineAt(Math.min(next.from, tr.state.doc.length));
    const head = tr.state.selection.main.head;
    if (head < line.from || head > line.to) return null;
    return next;
  },
});

export class ImageWidget extends WidgetType {
  constructor(src, alt, title, from, to, inline, base, editing = false, width = '', align = '', attrs = '') {
    super();
    this.src = src;
    this.alt = alt;
    this.title = title;
    this.from = from;
    this.to = to;
    this.inline = inline;
    // 基址进 eq()：换目录打开文档时 src 可能一字未变，但解析结果变了
    this.base = base;
    this.editing = !!editing;
    this.width = width || '';
    this.align = align || '';
    this.attrs = attrs || '';
  }
  eq(other) {
    return (
      other.src === this.src &&
      other.alt === this.alt &&
      other.title === this.title &&
      other.from === this.from &&
      other.to === this.to &&
      other.inline === this.inline &&
      other.base === this.base &&
      other.editing === this.editing &&
      other.width === this.width &&
      other.align === this.align &&
      other.attrs === this.attrs
    );
  }
  toDOM(view) {
    const showUrl = this.editing && !this.inline;
    const wrap = document.createElement(this.inline ? 'span' : 'div');
    wrap.className =
      'cm-image' + (this.inline ? ' is-inline' : ' is-block') + (showUrl ? ' is-editing' : '');
    wrap.title = showUrl ? '改成 Markdown 图片语法，清空则删除图片' : '点击后在图片上方编辑图片语法';
    const url = resolveSrc(this.src);
    wrap.dataset.src = url;
    wrap.dataset.markdownSrc = this.src;
    wrap.dataset.from = String(this.from);
    wrap.dataset.to = String(this.to);
    wrap.dataset.width = this.width;
    wrap.dataset.align = this.align;
    wrap.dataset.attrs = this.attrs;
    const img = document.createElement('img');
    img.src = url;
    img.alt = this.alt || '';
    img.loading = 'lazy';
    img.draggable = false;
    if (this.width) img.style.width = /^\d+(\.\d+)?$/.test(this.width) ? this.width + 'px' : this.width;
    if (this.align) wrap.classList.add('is-' + this.align);
    img.addEventListener('error', () => {
      wrap.classList.add('is-broken');
      img.remove();
      const ph = document.createElement('span');
      ph.className = 'cm-image-broken';
      ph.textContent = '无法加载图片：' + formatImageMd(this.alt, this.src, this.title, this.attrs);
      ph.title = url;
      wrap.appendChild(ph);
    });
    wrap.appendChild(img);

    if (showUrl) {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'cm-image-url';
      const attrParts = [];
      if (this.width) attrParts.push(`width=${this.width}`);
      if (this.align) attrParts.push(`align=${this.align}`);
      const fallbackAttrs = attrParts.length ? `{${attrParts.join(' ')}}` : '';
      const original = formatImageMd(this.alt, this.src, this.title, this.attrs || fallbackAttrs);
      input.value = original;
      input.spellcheck = false;
      input.setAttribute('aria-label', '图片语法');
      let busy = false;
      const apply = (spec) => {
        if (busy) return;
        busy = true;
        view.dispatch(spec);
      };
      const removeImage = () => {
        const doc = view.state.doc;
        if (this.from < 0 || this.from > doc.length) return;
        const slice = doc.sliceString(this.from, Math.min(this.to, doc.length));
        if (!slice.includes('![')) return;
        let from = this.from;
        let to = this.to;
        const line = doc.lineAt(from);
        if (line.text.trim() === slice.trim()) {
          if (line.number < doc.lines) {
            from = line.from;
            to = line.to + 1;
          } else if (line.number > 1) {
            from = doc.line(line.number - 1).to;
            to = line.to;
          } else {
            from = line.from;
            to = line.to;
          }
        }
        apply({
          changes: { from, to, insert: '' },
          selection: { anchor: from },
          effects: setEditingImage.of(null),
        });
      };
      const commit = (keepEditing) => {
        if (busy) return;
        const raw = input.value.trim();
        if (raw === original) return;
        const parsed = parseImageMd(raw);
        if (!parsed) {
          removeImage();
          return;
        }
        const insert = formatImageMd(parsed.alt, parsed.src, parsed.title, parsed.attrs);
        if (insert === original) return;
        const from = this.from;
        apply({
          changes: { from, to: this.to, insert },
          selection: { anchor: Math.min(from + 2, from + insert.length - 1) },
          effects: setEditingImage.of(
            keepEditing ? { from, to: from + insert.length } : null,
          ),
        });
      };
      input.addEventListener('mousedown', (e) => e.stopPropagation());
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          commit(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          apply({ selection: { anchor: this.to }, effects: setEditingImage.of(null) });
          view.focus();
        }
      });
      input.addEventListener('input', () => {
        const raw = input.value.trim();
        if (!raw || /^!\[[^\]]*\]\(\s*\)\s*$/.test(raw)) removeImage();
      });
      input.addEventListener('blur', () => commit(false));
      wrap.insertBefore(input, img);
      requestAnimationFrame(() => {
        if (wrap.isConnected && document.activeElement !== input) input.focus();
      });
    } else if (this.title) {
      const cap = document.createElement('span');
      cap.className = 'cm-image-title';
      cap.textContent = this.title;
      wrap.appendChild(cap);
    }

    wrap.addEventListener('mousedown', (e) => {
      if (e.target.closest && e.target.closest('.cm-image-url')) return;
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (this.editing) return;
      // 选区放进语法内部，编辑态才不会因为光标落在块外面被立刻清掉。
      const anchor = Math.min(this.from + 2, Math.max(this.from, this.to - 1));
      view.dispatch({
        selection: { anchor },
        effects: setEditingImage.of({ from: this.from, to: this.to }),
        scrollIntoView: false,
      });
      view.focus();
    });
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

const ICON_COPY =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_CHECK =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

/* ---------------- 表格 ---------------- */

export class TableWidget extends WidgetType {
  /**
   * @param {Array<{cells: Array<{text: string, raw: string, from: number, to: number}>}>} rows
   * @param {string[]} aligns
   * @param {number} from 表格首行起点
   * @param {number} to   表格末行终点
   * @param {number} lineNo 表格首行行号（用于提交后按行号重新定位）
   */
  constructor(rows, aligns, from, to, lineNo) {
    super();
    this.rows = rows;
    this.aligns = aligns;
    this.from = from;
    this.to = to;
    this.lineNo = lineNo;
    this.cols = rows.reduce((n, r) => Math.max(n, r.cells.length), 0);
    // 单元格里的公式依赖 katex；懒加载就绪前后渲染结果不同，eq 要能区分。
    this.texReady = isTexReady();
  }
  eq(other) {
    return (
      other.from === this.from &&
      other.to === this.to &&
      other.lineNo === this.lineNo &&
      other.texReady === this.texReady &&
      JSON.stringify(other.rows) === JSON.stringify(this.rows) &&
      JSON.stringify(other.aligns) === JSON.stringify(this.aligns)
    );
  }
  toDOM(view) {
    const wrap = document.createElement('div');
    wrap.className = 'cm-table-wrap';
    wrap.title = '点击单元格编辑，Tab 切换，Shift+Enter 格内换行，拖动表头边缘调列宽';
    wrap.dataset.line = String(this.lineNo);
    wrap.dataset.from = String(this.from);
    wrap.dataset.to = String(this.to);

    const cursor = tableCursorAt(this.lineNo);
    const bar = document.createElement('div');
    bar.className = 'cm-table-toolbar';
    bar.addEventListener('mousedown', (e) => e.stopPropagation());
    const act = (mutate) => {
      editTable(view, this.lineNo, mutate).catch(() => {});
    };
    const addBtn = (label, title, onClick, on) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cm-table-btn' + (on ? ' is-on' : '');
      b.title = title;
      if (label instanceof Node) b.appendChild(label);
      else b.textContent = label;
      b.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      });
      return b;
    };
    const sep = () => {
      const s = document.createElement('span');
      s.className = 'cm-table-sep';
      return s;
    };
    const alignNow = this.aligns[cursor.col] || '';
    const svg = (paths) => {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      el.setAttribute('width', '14');
      el.setAttribute('height', '14');
      el.setAttribute('viewBox', '0 0 24 24');
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke', 'currentColor');
      el.setAttribute('stroke-width', '1.8');
      el.setAttribute('stroke-linecap', 'round');
      el.setAttribute('stroke-linejoin', 'round');
      el.setAttribute('aria-hidden', 'true');
      el.innerHTML = paths;
      return el;
    };
    bar.append(
      addBtn('左', '当前列左对齐', () => act((rows) => setAlign(rows, cursor.col, 'left')), !alignNow),
      addBtn('中', '当前列居中', () => act((rows) => setAlign(rows, cursor.col, 'center')), alignNow === 'center'),
      addBtn('右', '当前列右对齐', () => act((rows) => setAlign(rows, cursor.col, 'right')), alignNow === 'right'),
      sep(),
      addBtn('+行', '在当前行下方插入一行', () => act((rows) => insertTableRow(rows, cursor.row))),
      addBtn('+列', '在当前列右侧插入一列', () => act((rows) => insertTableCol(rows, cursor.col))),
      addBtn('−行', '删除当前行', () => act((rows) => deleteTableRow(rows, cursor.row))),
      addBtn('−列', '删除当前列', () => act((rows) => deleteTableCol(rows, cursor.col))),
      addBtn('↑', '按当前列升序排列', () => act((rows) => sortTableRows(rows, cursor.col, false))),
      addBtn('↓', '按当前列降序排列', () => act((rows) => sortTableRows(rows, cursor.col, true))),
      sep(),
      addBtn(
        svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
        '显示表格源码',
        () => {
          commitCellEditor().then(() => {
            if (this.lineNo < 1 || this.lineNo > view.state.doc.lines) return;
            const line = view.state.doc.line(this.lineNo);
            view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
            view.focus();
          });
        }
      )
    );
    wrap.appendChild(bar);

    const scroll = document.createElement('div');
    scroll.className = 'cm-table-scroll';
    const table = document.createElement('table');
    const colgroup = document.createElement('colgroup');
    const colElements = [];
    for (let c = 0; c < this.cols; c++) {
      const col = document.createElement('col');
      const spec = this.rows[1]?.cells[c]?.raw || '---';
      const dashes = (spec.match(/-/g) || []).length;
      col.style.width = Math.max(48, Math.min(480, dashes * 8)) + 'px';
      colgroup.appendChild(col);
      colElements.push(col);
    }
    table.appendChild(colgroup);
    const thead = document.createElement('thead');
    const tbody = document.createElement('tbody');

    const buildRow = (r, cells, tag) => {
      const tr = document.createElement('tr');
      cells.forEach((c, i) => {
        const cell = document.createElement(tag);
        // 格子里的 `**粗**`、`` `code` ``、`$x^2$` 要渲染出来，不是把源码糊在脸上。
        // 点进格子时浮层编辑器仍然拿到原始 markdown（c.text），所见即所改。
        cell.appendChild(renderInline(c.text, { resolve: resolveSrc }));
        cell.dataset.col = String(i);
        // 交付给浮层编辑器：源码区间 + 表格上下文
        cell._cell = {
          row: r,
          col: i,
          from: c.from,
          to: c.to,
          text: c.text,
          raw: c.raw,
          tableLine: this.lineNo,
          tableTo: this.to,
          rows: this.rows.length,
          cols: this.cols,
        };
        if (this.aligns[i]) cell.style.textAlign = this.aligns[i];
        if (tag === 'th') {
          const handle = document.createElement('span');
          handle.className = 'cm-table-resize';
          handle.title = '拖动调整列宽';
          handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const startX = e.clientX;
            const startWidth = cell.getBoundingClientRect().width;
            let width = startWidth;
            const move = (ev) => {
              width = Math.max(48, Math.min(480, startWidth + ev.clientX - startX));
              colElements[i].style.width = width + 'px';
            };
            const up = () => {
              window.removeEventListener('mousemove', move);
              window.removeEventListener('mouseup', up);
              act((rows) => setTableColumnWidth(rows, i, width, this.aligns[i]));
            };
            window.addEventListener('mousemove', move);
            window.addEventListener('mouseup', up, { once: true });
          });
          cell.appendChild(handle);
        }
        tr.appendChild(cell);
      });
      return tr;
    };

    if (this.rows.length) {
      thead.appendChild(buildRow(0, this.rows[0].cells, 'th'));
      for (let i = 1; i < this.rows.length; i++) tbody.appendChild(buildRow(i, this.rows[i].cells, 'td'));
    }
    table.appendChild(thead);
    table.appendChild(tbody);
    scroll.appendChild(table);
    wrap.appendChild(scroll);

    wrap.addEventListener('mousedown', (e) => {
      if (e.target instanceof Element && e.target.closest('.cm-table-toolbar')) return;
      e.preventDefault();
      const hit = e.target instanceof Element ? e.target.closest('td, th') : null;
      if (hit && hit._cell) {
        Promise.resolve(openCellEditor(view, hit)).catch((err) => {
          window.__cellErr = String((err && err.stack) || err);
        });
      }
      // 点在边框或留白上不再退回源码。要看管道符，用工具条上的源码按钮，或从表格上下方用方向键穿入。
    });
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

/* ---------------- 目录 ---------------- */

/**
 * `[toc]` 渲染成的目录块（Typora 的行为）。
 * 条目点击只滚动、不动光标 —— 目录是用来跳着读的，跳一下就把光标搬走反而打断原来的输入位置。
 */
export class TocWidget extends WidgetType {
  constructor(headings, from) {
    super();
    this.headings = headings;
    this.from = from;
  }
  eq(other) {
    // 标题变了目录就得重画，但标题正文在 headings 里，比引用更省事
    return other.from === this.from && JSON.stringify(other.headings) === JSON.stringify(this.headings);
  }
  toDOM(view) {
    const box = document.createElement('nav');
    box.className = 'cm-toc';
    box.setAttribute('aria-label', '目录');
    const inner = document.createElement('div');
    inner.className = 'cm-toc-box';
    box.appendChild(inner);

    const head = document.createElement('div');
    head.className = 'cm-toc-head';
    const title = document.createElement('span');
    title.className = 'cm-toc-title';
    title.textContent = '目录';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'cm-toc-delete';
    del.title = '删除目录';
    del.setAttribute('aria-label', '删除目录');
    del.innerHTML =
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
    del.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const line = view.state.doc.lineAt(this.from);
      const to = line.number < view.state.doc.lines ? line.to + 1 : line.to;
      view.dispatch({ changes: { from: line.from, to }, selection: { anchor: line.from } });
      view.focus();
    });
    head.append(title, del);
    inner.appendChild(head);

    const list = document.createElement('div');
    list.className = 'cm-toc-list';
    inner.appendChild(list);

    if (!this.headings.length) {
      const empty = document.createElement('span');
      empty.className = 'cm-toc-empty';
      empty.textContent = '文档里还没有标题';
      list.appendChild(empty);
    } else {
      const min = this.headings.reduce((n, h) => Math.min(n, h.level), 6);
      for (const h of this.headings) {
        const a = document.createElement('a');
        a.className = 'cm-toc-item cm-toc-h' + h.level;
        a.textContent = h.text;
        a.title = h.text;
        a.style.paddingLeft = (h.level - min) * 14 + 'px';
        a.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          view.dispatch({ selection: { anchor: h.pos }, effects: EditorView.scrollIntoView(h.pos, { y: 'start' }) });
          view.contentDOM.focus({ preventScroll: true });
          blinkLine(view, h.pos);
        });
        list.appendChild(a);
      }
    }

    box.addEventListener('mousedown', (e) => {
      if (e.target instanceof Element && e.target.closest('.cm-toc-head, .cm-toc-item')) return;
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.from }, scrollIntoView: true });
      view.focus();
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

/* ---------------- 数学 ---------------- */

export class MathWidget extends WidgetType {
  constructor(tex, display, from, companion = false) {
    super();
    this.tex = tex;
    this.display = display;
    this.from = from;
    this.companion = !!companion;
    // katex 懒加载就绪前后渲染结果不同，eq 要能区分，就绪后才会重建 DOM。
    this.texReady = isTexReady();
  }
  eq(other) {
    return other.tex === this.tex && other.display === this.display && other.companion === this.companion && other.texReady === this.texReady;
  }
  toDOM(view) {
    const el = document.createElement(this.display ? 'div' : 'span');
    el.className =
      'cm-math' + (this.display ? ' is-display' : ' is-inline') + (this.companion ? ' is-companion' : '');
    el.innerHTML = renderTex(this.tex, this.display);
    el.title = this.companion ? '编辑上方源码，这里是实时预览' : '点击编辑公式';
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (this.companion) return;
      view.dispatch({ selection: { anchor: this.from }, scrollIntoView: true });
      view.focus();
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

/* ---------------- 代码块语言标识 + 复制 ---------------- */

export class FenceChipWidget extends WidgetType {
  /**
   * @param {string} lang 语言名
   * @param {number} from 围栏行起点
   * @param {number} codeFrom 代码正文起点
   * @param {number} codeTo   代码正文终点（不含围栏）
   * @param {number} infoFrom 语言名在文档里的起点（``` 之后）
   * @param {number} infoTo   语言名终点（没有语言时与起点重合）
   */
  constructor(lang, from, codeFrom, codeTo, infoFrom, infoTo) {
    super();
    this.lang = lang;
    this.from = from;
    this.codeFrom = codeFrom;
    this.codeTo = codeTo;
    this.infoFrom = infoFrom;
    this.infoTo = infoTo;
  }
  eq(other) {
    return (
      other.lang === this.lang &&
      other.codeFrom === this.codeFrom &&
      other.codeTo === this.codeTo &&
      other.infoFrom === this.infoFrom &&
      other.infoTo === this.infoTo
    );
  }
  /** 改语言 = 只改围栏行里 ``` 后面那一段，代码正文一个字不动 */
  setLang(view, lang) {
    const to = Math.max(this.infoFrom, this.infoTo);
    view.dispatch({
      changes: { from: this.infoFrom, to, insert: lang },
      selection: { anchor: this.infoFrom + lang.length },
      scrollIntoView: true,
    });
    view.focus();
  }
  toDOM(view) {
    // 必须是 inline 级的元素：这行是被 replace 掉的整行，塞块级 div 进去
    // CM 会把这一行当成无法测量的块，连带后面的代码行都不再渲染（实测整块只剩两行）
    const bar = document.createElement('span');
    bar.className = 'cm-fence-bar';

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'cm-fence-copy';
    copy.innerHTML = ICON_COPY;
    copy.title = '复制整段代码';
    copy.setAttribute('aria-label', '复制整段代码');
    copy.addEventListener('mousedown', (e) => e.preventDefault());
    copy.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const text = view.state.doc.sliceString(this.codeFrom, this.codeTo);
      try {
        await navigator.clipboard.writeText(text);
        copy.innerHTML = ICON_CHECK;
        copy.classList.add('is-done');
        copy.title = '已复制';
      } catch {
        copy.title = '复制失败';
      }
      setTimeout(() => {
        copy.innerHTML = ICON_COPY;
        copy.classList.remove('is-done');
        copy.title = '复制整段代码';
      }, 1200);
    });

    bar.append(copy);
    return bar;
  }
  ignoreEvent(e) {
    return !!(e.target && e.target.closest && e.target.closest('.cm-fence-copy'));
  }
}

/** 代码块右下角的语言小框。点一下换成别的语法，围栏行本身不显形。 */
export class FenceLangWidget extends WidgetType {
  constructor(lang, infoFrom, infoTo, active = false) {
    super();
    this.lang = lang;
    this.infoFrom = infoFrom;
    this.infoTo = infoTo;
    this.active = !!active;
  }
  eq(other) {
    return (
      other.lang === this.lang &&
      other.infoFrom === this.infoFrom &&
      other.infoTo === this.infoTo &&
      other.active === this.active
    );
  }
  setLang(view, lang) {
    const to = Math.max(this.infoFrom, this.infoTo);
    view.dispatch({
      changes: { from: this.infoFrom, to, insert: lang },
      selection: { anchor: this.infoFrom + lang.length },
      scrollIntoView: true,
    });
    view.focus();
  }
  toDOM(view) {
    const el = document.createElement('span');
    el.className = 'cm-fence-chip cm-lang-badge' + (this.active ? ' is-on' : '');
    el.textContent = this.lang || 'text';
    el.title = this.lang ? `语法高亮：${this.lang} · 点击更换` : '没有语言标记，按纯文本显示 · 点击选择';
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openLangMenu(el, this.lang, (lang) => this.setLang(view, lang));
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}
