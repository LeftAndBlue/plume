/**
 * 编辑器格式化、链接/图片粘贴与块级结构插入（从 runtime.js 抽离）。
 */
import { EditorSelection } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { sourceModeField } from './live-preview.js';
import { pasteAsCodeBlock } from './paste-code.js';
import { buildTableMarkdown } from './table-model.js';
import { openTablePicker } from './table-picker.js';

// 从序号或圆点开始拖选时，CM 的选区会包含 Markdown 列表前缀。
// 行内格式只能包正文：`**1. 文本**` 会把整项变成普通段落，列表也就消失了。
const LIST_PREFIX = /^\s*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/;
const ANY_LIST_PREFIX = /^(\s*)(?:[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/;

export const quotePrefix = {
  insert: '> ',
  match: (text) => /^\s{0,3}>\s?/.exec(text),
};

export const ulPrefix = {
  list: true,
  insert: '- ',
  match: (text) => /^\s*[-*+]\s+(?!\[[ xX]\]\s+)/.exec(text),
};

export const olPrefix = {
  list: true,
  insert: '1. ',
  match: (text) => /^\s*\d+[.)]\s+/.exec(text),
};

export const taskPrefix = {
  list: true,
  insert: '- [ ] ',
  match: (text) => /^\s*[-*+]\s+\[[ xX]\]\s+/.exec(text),
};

/** 光标是否落在围栏/缩进代码块里——代码块里的 `- ` `> ` 是内容，不是标记 */
export function inCodeBlock(state, pos) {
  for (let n = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (n.name === 'FencedCode' || n.name === 'CodeBlock') return true;
  }
  return false;
}

/**
 * 引用后面如果没有空行，下一行文字在语法上仍算这段引用，画面上却不带 `>`。
 * 这时回车若交给 markdown 自带的续行，会凭空补出一个 `>`。
 * 这里改成普通换行，引用到此为止。
 */
export function newlineAfterLazyQuote(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.from);
  if (inCodeBlock(state, sel.from)) return false;
  if (/^[ \t]*>/.test(line.text)) return false;
  let inQuote = false;
  for (let n = syntaxTree(state).resolveInner(sel.from, -1); n; n = n.parent) {
    if (n.name === 'Blockquote') {
      inQuote = true;
      break;
    }
  }
  if (!inQuote) return false;
  view.dispatch({
    changes: { from: sel.from, insert: '\n' },
    selection: { anchor: sel.from + 1 },
  });
  return true;
}

function inlineWrapSpans(state, range) {
  const first = state.doc.lineAt(range.from);
  const last = state.doc.lineAt(Math.max(range.from, range.to - 1));
  const spans = [];
  for (let n = first.number; n <= last.number; n++) {
    const line = state.doc.line(n);
    const prefix = LIST_PREFIX.exec(line.text);
    const contentFrom = line.from + (prefix ? prefix[0].length : 0);
    const from = Math.max(range.from, contentFrom);
    const to = Math.min(range.to, line.to);
    if (to > from) spans.push({ from, to });
  }
  return spans;
}

function changeInlineSpans(state, range, makeChange, spans = inlineWrapSpans(state, range)) {
  if (!spans.length) return { range };
  const changes = [];
  let delta = 0;
  let newFrom = null;
  let newTo = 0;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    const selected = state.sliceDoc(span.from, span.to);
    const change = makeChange(span, selected, i);
    const from = change.from + delta + change.contentFrom;
    const to = change.from + delta + change.contentTo;
    if (newFrom === null) newFrom = from;
    newTo = to;
    if (change.insert !== state.sliceDoc(change.from, change.to)) {
      changes.push({ from: change.from, to: change.to, insert: change.insert });
    }
    delta += change.insert.length - (change.to - change.from);
  }
  return { changes, range: EditorSelection.range(newFrom, newTo) };
}

function wrapRange(state, range, marker, markerEnd) {
  return changeInlineSpans(state, range, (span, selected) => ({
    from: span.from,
    to: span.to,
    insert: marker + selected + markerEnd,
    contentFrom: marker.length,
    contentTo: marker.length + selected.length,
  }));
}

function toggleWrapRange(state, range, marker) {
  const len = marker.length;
  const spans = inlineWrapSpans(state, range);
  if (!spans.length) return { range };
  const kinds = spans.map((span) => {
    const selected = state.sliceDoc(span.from, span.to);
    if (selected.length >= len * 2 && selected.startsWith(marker) && selected.endsWith(marker)) return 'outer';
    const before = span.from >= len && state.sliceDoc(span.from - len, span.from) === marker;
    const after = state.sliceDoc(span.to, span.to + len) === marker;
    if (before && selected.length > len && selected.endsWith(marker)) return 'trailing';
    if (after && selected.length > len && selected.startsWith(marker)) return 'leading';
    return before && after ? 'around' : null;
  });
  const unwrapAll = kinds.every(Boolean);
  return changeInlineSpans(
    state,
    range,
    (span, selected, i) => {
      const kind = kinds[i];
      if (kind && unwrapAll) {
        if (kind === 'outer') {
          const text = selected.slice(len, -len);
          return { from: span.from, to: span.to, insert: text, contentFrom: 0, contentTo: text.length };
        }
        if (kind === 'trailing') {
          const text = selected.slice(0, -len);
          return { from: span.from - len, to: span.to, insert: text, contentFrom: 0, contentTo: text.length };
        }
        if (kind === 'leading') {
          const text = selected.slice(len);
          return { from: span.from, to: span.to + len, insert: text, contentFrom: 0, contentTo: text.length };
        }
        return {
          from: span.from - len,
          to: span.to + len,
          insert: selected,
          contentFrom: 0,
          contentTo: selected.length,
        };
      }
      if (kind) {
        return { from: span.from, to: span.to, insert: selected, contentFrom: 0, contentTo: selected.length };
      }
      return {
        from: span.from,
        to: span.to,
        insert: marker + selected + marker,
        contentFrom: len,
        contentTo: len + selected.length,
      };
    },
    spans,
  );
}

export function createEditorFormatting({ getActiveView }) {
  let lastTableSize = { cols: 3, rows: 2 };

  function wrap(marker, markerEnd = marker, targetView = getActiveView()) {
    const { state: s } = targetView;
    const toggleable = marker === markerEnd && marker.length === 2;
    targetView.dispatch(
      s.changeByRange((range) => {
        const text = s.sliceDoc(range.from, range.to);
        if (!text && range.empty) {
          if (
            toggleable &&
            range.from >= marker.length &&
            s.sliceDoc(range.from - marker.length, range.from) === marker &&
            s.sliceDoc(range.from, range.from + marker.length) === marker
          ) {
            return {
              changes: { from: range.from - marker.length, to: range.from + marker.length, insert: '' },
              range: EditorSelection.cursor(range.from - marker.length),
            };
          }
          const insert = marker + markerEnd;
          return {
            changes: { from: range.from, insert },
            range: EditorSelection.cursor(range.from + marker.length),
          };
        }
        return toggleable ? toggleWrapRange(s, range, marker) : wrapRange(s, range, marker, markerEnd);
      }),
    );
    targetView.focus();
  }

  function applyLinePrefix(prefixFn, targetView = getActiveView()) {
    const { state: s } = targetView;
    const lines = new Set();
    for (const r of s.selection.ranges) {
      const a = s.doc.lineAt(r.from).number;
      const b = s.doc.lineAt(r.to).number;
      for (let n = a; n <= b; n++) lines.add(n);
    }
    const nos = [...lines].sort((x, y) => x - y);
    const changes = [];
    for (const n of nos) {
      const line = s.doc.line(n);
      const matched = /^\s{0,3}#{1,6}\s+/.exec(line.text);
      const oldLen = matched ? matched[0].length : 0;
      const stripped = line.text.slice(oldLen);
      const next = prefixFn(stripped);
      const newPrefix = next.slice(0, next.length - stripped.length);
      if (next !== line.text) {
        changes.push({ from: line.from, to: line.from + oldLen, insert: newPrefix });
      }
    }
    if (!changes.length) return;
    const changeSet = s.changes(changes);
    const selection = EditorSelection.create(
      s.selection.ranges.map((r) =>
        EditorSelection.range(changeSet.mapPos(r.anchor, 1), changeSet.mapPos(r.head, 1)),
      ),
      s.selection.mainIndex,
    );
    targetView.dispatch({ changes: changeSet, selection, scrollIntoView: true });
    targetView.focus();
  }

  function setHeading(level, targetView = getActiveView()) {
    applyLinePrefix((text) => (level === 0 ? text : '#'.repeat(level) + ' ' + text), targetView);
  }

  function insertLink(targetView = getActiveView()) {
    const { state: s } = targetView;
    const suffix = '](https://)';
    targetView.dispatch(
      s.changeByRange((range) => {
        if (range.empty) {
          const text = '链接文字';
          const insert = `[${text}${suffix}`;
          return {
            changes: { from: range.from, insert },
            range: EditorSelection.range(range.from + 1, range.from + 1 + text.length),
          };
        }
        return wrapRange(s, range, '[', suffix);
      }),
    );
    const labelEnd = targetView.state.selection.main.to;
    if (targetView.state.sliceDoc(labelEnd, labelEnd + suffix.length) === suffix) {
      targetView.dispatch({ selection: { anchor: labelEnd + 2, head: labelEnd + suffix.length - 1 } });
    }
    targetView.focus();
  }

  function linkifySelection(raw, targetView = getActiveView()) {
    const url = String(raw || '').trim();
    if (!/^(https?:\/\/|mailto:)\S+$/i.test(url)) return false;
    const { state: s } = targetView;
    const sel = s.selection.main;
    if (sel.empty) return false;
    const label = s.sliceDoc(sel.from, sel.to);
    if (!label.trim() || /\n/.test(label)) return false;
    if (/^(https?:\/\/|mailto:)\S*$/i.test(label.trim()) || /^www\.\S*$/i.test(label.trim())) {
      targetView.dispatch({
        changes: { from: sel.from, to: sel.to, insert: url },
        selection: { anchor: sel.from + url.length },
      });
      targetView.focus();
      return true;
    }
    targetView.dispatch(s.changeByRange((range) => wrapRange(s, range, '[', `](${url})`)));
    targetView.focus();
    return true;
  }

  function remoteImageUrl(raw) {
    const url = String(raw || '').trim();
    if (!/^https?:\/\/\S+$/i.test(url)) return '';
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      if (!/\.(?:avif|bmp|gif|ico|jpe?g|jfif|png|svg|webp)$/i.test(parsed.pathname)) return '';
      return url;
    } catch {
      return '';
    }
  }

  function insertAtCursor(text, selectOffset, targetView = getActiveView()) {
    const range = targetView.state.selection.main;
    targetView.dispatch({
      changes: { from: range.from, to: range.to, insert: text },
      selection: { anchor: range.from + (selectOffset ?? text.length) },
      scrollIntoView: true,
    });
    targetView.focus();
  }

  function pasteRemoteImage(raw, { sourceMode = false } = {}, targetView = getActiveView()) {
    const url = remoteImageUrl(raw);
    const sel = targetView.state.selection.main;
    if (!url || sourceMode || targetView.state.readOnly || !sel.empty) return false;
    for (let n = syntaxTree(targetView.state).resolveInner(sel.head, -1); n; n = n.parent) {
      if (['FencedCode', 'CodeBlock', 'CodeText', 'InlineCode', 'Link', 'Image', 'Autolink', 'HTMLTag'].includes(n.name)) {
        return false;
      }
    }
    const dest = url.replace(/</g, '%3C').replace(/>/g, '%3E');
    insertAtCursor(`![](<${dest}>)`, undefined, targetView);
    return true;
  }

  function handlePastedText(text, targetView = getActiveView()) {
    if (!text) return false;
    if (targetView.hasFocus && linkifySelection(text, targetView)) return true;
    const sourceMode = !!targetView.state.field(sourceModeField, false);
    if (pasteRemoteImage(text, { sourceMode }, targetView)) return true;
    return pasteAsCodeBlock(targetView, text, { sourceMode });
  }

  function insertFence(targetView = getActiveView()) {
    const sel = targetView.state.sliceDoc(
      targetView.state.selection.main.from,
      targetView.state.selection.main.to,
    );
    const body = sel || '// 代码';
    insertAtCursor('```js\n' + body + '\n```\n', body.length + 6, targetView);
  }

  function insertMathBlock(targetView = getActiveView()) {
    insertAtCursor('$$\n\\int_{0}^{1} x^2\\,dx = \\frac{1}{3}\n$$\n', 3, targetView);
  }

  function insertAnchorAtCaret(targetView = getActiveView()) {
    try {
      const c = targetView.coordsAtPos(targetView.state.selection.main.from);
      if (c && Number.isFinite(c.left) && Number.isFinite(c.bottom)) {
        return { x: c.left, y: c.bottom };
      }
    } catch {
      /* 文档还没布局好时 coordsAtPos 会拿不到坐标 */
    }
    return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  }

  function insertTable(cols = 3, rows = 2, targetView = getActiveView()) {
    const md = buildTableMarkdown(cols, rows);
    const { state: s } = targetView;
    const range = s.selection.main;
    const startLine = s.doc.lineAt(range.from);
    const endLine = s.doc.lineAt(range.to);
    const prefix = startLine.text.slice(0, range.from - startLine.from).trim() ? '\n\n' : '';
    const suffix = endLine.text.slice(range.to - endLine.from).trim() ? '\n' : '';
    const from = range.from;
    targetView.dispatch({
      changes: { from, to: range.to, insert: prefix + md + suffix },
      selection: { anchor: from + prefix.length + 2 },
      scrollIntoView: true,
    });
    targetView.focus();
  }

  function pickTableSize() {
    const av = getActiveView();
    openTablePicker({
      anchor: insertAnchorAtCaret(av),
      initial: lastTableSize,
      onPick: ({ cols, rows }) => {
        lastTableSize = { cols, rows };
        insertTable(cols, rows, av);
      },
      onClose: () => av.focus(),
    });
  }

  function insertHr(targetView = getActiveView()) {
    insertAtCursor('\n\n---\n\n', undefined, targetView);
  }

  function insertToc(targetView = getActiveView()) {
    insertAtCursor('\n\n[toc]\n\n', undefined, targetView);
  }

  function toggleLinePrefix(prefixFn, targetView = getActiveView()) {
    const { state: s } = targetView;
    const lines = new Set();
    for (const r of s.selection.ranges) {
      const a = s.doc.lineAt(r.from).number;
      const b = s.doc.lineAt(r.to).number;
      for (let n = a; n <= b; n++) lines.add(n);
    }
    const nos = [...lines].sort((x, y) => x - y);
    const infos = nos.map((n) => {
      const line = s.doc.line(n);
      const m = prefixFn.match(line.text);
      return { line, m };
    });
    const allHave = infos.every((i) => i.m);
    const changes = [];
    for (const { line, m } of infos) {
      if (allHave) {
        changes.push({
          from: line.from,
          to: line.from + m[0].length,
          insert: '',
        });
      } else if (!m) {
        const other = prefixFn.list ? ANY_LIST_PREFIX.exec(line.text) : null;
        if (other) {
          changes.push({
            from: line.from,
            to: line.from + other[0].length,
            insert: other[1] + prefixFn.insert,
          });
        } else {
          changes.push({ from: line.from, insert: prefixFn.insert });
        }
      }
    }
    if (!changes.length) return;
    const changeSet = s.changes(changes);
    const selection = EditorSelection.create(
      s.selection.ranges.map((r) =>
        EditorSelection.range(changeSet.mapPos(r.anchor, 1), changeSet.mapPos(r.head, 1)),
      ),
      s.selection.mainIndex,
    );
    targetView.dispatch({ changes: changeSet, selection, scrollIntoView: true });
    targetView.focus();
  }

  function clearFormat(targetView = getActiveView()) {
    const { state: s } = targetView;
    targetView.dispatch(
      s.changeByRange((range) => {
        const raw = s.sliceDoc(range.from, range.to);
        const plain = raw
          .replace(/==(.+?)==/g, '$1')
          .replace(/\*\*(.+?)\*\*/g, '$1')
          .replace(/~~(.+?)~~/g, '$1')
          .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
          .replace(/`([^`]+)`/g, '$1')
          .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
        return {
          changes: { from: range.from, to: range.to, insert: plain },
          range: EditorSelection.range(range.from, range.from + plain.length),
        };
      }),
    );
    targetView.focus();
  }

  return {
    wrap,
    setHeading,
    insertLink,
    linkifySelection,
    handlePastedText,
    insertAtCursor,
    insertFence,
    insertMathBlock,
    pickTableSize,
    insertTable,
    insertHr,
    insertToc,
    toggleLinePrefix,
    clearFormat,
  };
}
