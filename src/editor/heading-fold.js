/**
 * Markdown 标题章节折叠（H1–H3）：
 * - 纯函数 `computeHeadingFoldLines` 计算任意标题行的折叠范围（跳过围栏代码块与尾随空行）
 * - 接入 CodeMirror 6 `foldService` + `codeFolding` + 仅显示在标题行的轻量折叠槽 `foldGutter`
 * - 提供快捷键 Ctrl+Alt+[（折叠当前章节）与 Ctrl+Alt+]（展开当前章节）
 */
import { codeFolding, foldEffect, foldGutter, foldService, unfoldEffect } from '@codemirror/language';
import { keymap } from '@codemirror/view';
import { computeHeadingFoldLines, headingLevelOfLine } from './extrasText.js';
import { t } from '../i18n.js';

export { computeHeadingFoldLines, headingLevelOfLine };

/** CodeMirror `doc` 版本：返回 `{ from, to }` 字符区间或 `null`。 */
export function computeHeadingFoldRange(doc, lineNo, maxLevel = 3) {
  if (!doc || lineNo < 1 || lineNo > doc.lines) return null;
  const lines = [];
  for (let i = 1; i <= doc.lines; i++) lines.push(doc.line(i).text);
  const res = computeHeadingFoldLines(lines, lineNo - 1, maxLevel);
  if (!res) return null;
  return {
    from: doc.line(res.startLine).to,
    to: doc.line(res.endLine).to,
  };
}

/** 查找光标所在或最近的上方 H1–H3 标题行号。 */
function findEnclosingHeadingLine(doc, pos, maxLevel = 3) {
  const cur = doc.lineAt(pos).number;
  for (let i = cur; i >= 1; i--) {
    const lv = headingLevelOfLine(doc.line(i).text);
    if (lv > 0 && lv <= maxLevel) return i;
  }
  return 0;
}

export function foldCurrentHeading(view) {
  const lineNo = findEnclosingHeadingLine(view.state.doc, view.state.selection.main.head);
  if (!lineNo) return false;
  const range = computeHeadingFoldRange(view.state.doc, lineNo);
  if (!range) return false;
  view.dispatch({ effects: foldEffect.of(range) });
  return true;
}

export function unfoldCurrentHeading(view) {
  const lineNo = findEnclosingHeadingLine(view.state.doc, view.state.selection.main.head);
  if (!lineNo) return false;
  const range = computeHeadingFoldRange(view.state.doc, lineNo);
  if (!range) return false;
  view.dispatch({ effects: unfoldEffect.of(range) });
  return true;
}

export function foldAllHeadings(view, maxLevel = 3) {
  const doc = view.state.doc;
  const effects = [];
  for (let i = 1; i <= doc.lines; i++) {
    const lv = headingLevelOfLine(doc.line(i).text);
    if (lv > 0 && lv <= maxLevel) {
      const range = computeHeadingFoldRange(doc, i, maxLevel);
      if (range) effects.push(foldEffect.of(range));
    }
  }
  if (!effects.length) return false;
  view.dispatch({ effects });
  return true;
}

export function unfoldAllHeadings(view) {
  const doc = view.state.doc;
  view.dispatch({ effects: unfoldEffect.of({ from: 0, to: doc.length }) });
  return true;
}

export function headingFoldExtension() {
  return [
    foldService.of((state, lineStart) => {
      const line = state.doc.lineAt(lineStart);
      return computeHeadingFoldRange(state.doc, line.number, 3);
    }),
    codeFolding({
      placeholderDOM(view, onclick) {
        const el = document.createElement('span');
        el.className = 'cm-heading-fold-pill';
        el.textContent = t('fold.pill');
        el.title = t('fold.pillTitle');
        el.addEventListener('click', onclick);
        return el;
      },
    }),
    foldGutter({
      markerDOM(open) {
        const el = document.createElement('span');
        el.className = 'cm-heading-fold-marker' + (open ? ' is-open' : ' is-closed');
        el.textContent = open ? '▾' : '▸';
        el.title = open ? t('fold.collapse') : t('fold.expand');
        return el;
      },
    }),
    keymap.of([
      { key: 'Mod-Alt-[', run: foldCurrentHeading },
      { key: 'Mod-Alt-]', run: unfoldCurrentHeading },
    ]),
  ];
}
