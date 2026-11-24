import { StateEffect, StateField } from '@codemirror/state';
import { ViewPlugin } from '@codemirror/view';
import { markerSpace } from './editor-geometry.js';

/**
 * 所有光标共用一套几何规则：正文跟当前行的正文字，代码跟代码行高。
 * 标题徽章、代码围栏的零高度盒子都不能参与光标高度计算。
 */

function lineElementAt(view, pos) {
  let node;
  try {
    node = view.domAtPos(pos).node;
  } catch {
    return null;
  }
  if (node.nodeType === 3) node = node.parentElement;
  if (!(node instanceof Element)) return null;
  return node.closest('.cm-line');
}

function caretKind(el) {
  if (!el) return 'body';
  if (el.classList.contains('cm-fence-open') || el.classList.contains('cm-fence-close')) return 'fence';
  if (el.classList.contains('cm-code-line')) return 'code';
  return 'body';
}

function glyphRect(view, line) {
  const limit = Math.min(line.to, line.from + 32);
  for (let pos = line.from; pos < limit; pos++) {
    const rect = view.coordsForChar(pos);
    if (rect && rect.bottom - rect.top > 1) return rect;
  }
  return null;
}

function metrics(el, fallbackSize) {
  const style = getComputedStyle(el);
  const fontSize = parseFloat(style.fontSize) || fallbackSize;
  const parsed = parseFloat(style.lineHeight);
  const lineHeight = parsed > 1 ? parsed : fontSize * 1.6;
  const padTop = parseFloat(style.paddingTop) || 0;
  const borderTop = parseFloat(style.borderTopWidth) || 0;
  return { fontSize, lineHeight, padTop, borderTop };
}

/** 代码光标使用所在代码行的坐标和行高，自动换行后仍落在当前视觉行。 */
function codeCaretBox(view, el, head, assoc = 1) {
  const { lineHeight } = metrics(el, 14);
  const here = view.coordsAtPos(head, assoc);
  if (!here) return null;
  const boxH = here.bottom - here.top;
  const height = boxH > 1 && boxH < lineHeight * 1.8 ? Math.min(boxH, lineHeight) : lineHeight;
  const top = here.top + Math.max(0, (Math.max(boxH, height) - height) / 2);
  return { top, bottom: top + height };
}

/** 正文优先使用当前 head 的坐标；异常小盒子回退到正文字形或行盒。 */
function bodyCaretBox(view, line, el, head, assoc = 1) {
  const host = el || view.contentDOM;
  const { fontSize, lineHeight, padTop, borderTop } = metrics(host, 16);
  // 空行（含空文档的 placeholder 行）：按正文字形高度居中，避免从有字行回车到空行时光标突然拉长。
  if (line.length === 0 && el) {
    const rect = el.getBoundingClientRect();
    const height = Math.min(lineHeight, fontSize * 1.25);
    const top = rect.top + borderTop + padTop + Math.max(0, (lineHeight - height) / 2);
    return { top, bottom: top + height };
  }
  const here = view.coordsAtPos(head, assoc);
  const boxH = here ? here.bottom - here.top : 0;
  // 空标题的坐标可能来自左侧 # 徽章（只有 11px），不能当成正文字形。
  if (here && boxH >= fontSize * 0.75) {
    const height = boxH < lineHeight * 1.8 ? Math.min(boxH, lineHeight) : lineHeight;
    const top = here.top + Math.max(0, (Math.max(boxH, height) - height) / 2);
    return { top, bottom: top + height };
  }
  const glyph = glyphRect(view, line);
  if (glyph) {
    const glyphHeight = glyph.bottom - glyph.top;
    if (glyphHeight >= fontSize * 0.75 && glyphHeight <= lineHeight * 1.15) return glyph;
  }
  if (el) {
    const rect = el.getBoundingClientRect();
    const top = rect.top + borderTop + padTop;
    return { top, bottom: top + lineHeight };
  }
  const lineStart = view.coordsAtPos(line.from);
  if (!lineStart) return null;
  const top = lineStart.top + Math.max(0, (lineStart.bottom - lineStart.top - fontSize) / 2);
  return { top, bottom: top + fontSize };
}

function caretBox(view, head, assoc = 1) {
  const line = view.state.doc.lineAt(head);
  const el = lineElementAt(view, line.from);
  const kind = caretKind(el);
  if (kind === 'fence') return null;
  const box = kind === 'code'
    ? codeCaretBox(view, el, head, assoc)
    : bodyCaretBox(view, line, el, head, assoc);
  return box ? { kind, top: box.top, bottom: box.bottom } : null;
}

class CaretFit {
  constructor(view) {
    this.view = view;
    this.req = {
      read: () => this.read(),
      write: (data) => this.write(data),
    };
    view.requestMeasure(this.req);
  }

  update(update) {
    const dropChanged = update.startState.field(dropCursorPos, false) !== update.state.field(dropCursorPos, false);
    if (
      update.selectionSet ||
      update.docChanged ||
      update.geometryChanged ||
      update.viewportChanged ||
      update.focusChanged ||
      dropChanged
    ) {
      // update 时 DOM 已提交，下一轮 measure 会排在 CM 光标层之后，
      // 不需要再用额外 rAF 制造第二次布局读取。
      update.view.requestMeasure(this.req);
    }
  }

  read() {
    const base = markerSpace(this.view);
    const cursors = [];
    let secondaryIndex = 0;
    for (const range of this.view.state.selection.ranges) {
      if (!range.empty) continue;
      // coordsAtPos 为空时 CM 自己也不会画这个视口外光标。
      const assoc = range.assoc || 1;
      const here = this.view.coordsAtPos(range.head, assoc);
      if (!here) continue;
      const primary = range === this.view.state.selection.main;
      const box = caretBox(this.view, range.head, assoc);
      cursors.push({
        primary,
        secondaryIndex: primary ? -1 : secondaryIndex++,
        valid: !!box,
        kind: box?.kind,
        top: box ? (box.top - base.top) / base.scaleY : 0,
        height: box ? (box.bottom - box.top) / base.scaleY : 0,
      });
    }
    return cursors;
  }

  write(cursors) {
    const primary = this.view.scrollDOM.querySelector('.cm-cursor-primary');
    const secondary = this.view.scrollDOM.querySelectorAll('.cm-cursor-secondary');
    for (const data of cursors) {
      if (!data.valid) continue;
      const cursor = data.primary ? primary : secondary[data.secondaryIndex];
      if (!cursor) continue;
      cursor.style.top = data.top + 'px';
      cursor.style.height = data.height + 'px';
      cursor.classList.toggle('cm-cursor-code', data.kind === 'code');
      cursor.classList.toggle('cm-cursor-body', data.kind === 'body');
    }
  }
}

export const caretFit = ViewPlugin.fromClass(CaretFit);

/* 拖放位置与 drawSelection 一样放在 state field 中，但绘制时也走 caretBox。 */
const setDropCursorPos = StateEffect.define({
  map(pos, mapping) {
    return pos == null ? null : mapping.mapPos(pos);
  },
});

const dropCursorPos = StateField.define({
  create() {
    return null;
  },
  update(pos, tr) {
    if (pos != null) pos = tr.changes.mapPos(pos);
    return tr.effects.reduce((value, effect) => (effect.is(setDropCursorPos) ? effect.value : value), pos);
  },
});

const drawDropCursor = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.view = view;
      this.cursor = null;
      this.measureReq = { read: this.readPos.bind(this), write: this.drawCursor.bind(this) };
    }

    update(update) {
      const pos = update.state.field(dropCursorPos);
      if (pos == null) {
        if (this.cursor) this.cursor.remove();
        this.cursor = null;
      } else {
        if (!this.cursor) {
          this.cursor = this.view.scrollDOM.appendChild(document.createElement('div'));
          this.cursor.className = 'cm-dropCursor';
        }
        if (update.startState.field(dropCursorPos) !== pos || update.docChanged || update.geometryChanged) {
          this.view.requestMeasure(this.measureReq);
        }
      }
    }

    readPos() {
      const pos = this.view.state.field(dropCursorPos);
      const rect = pos != null && this.view.coordsAtPos(pos);
      const box = pos != null && caretBox(this.view, pos);
      if (!rect || !box) return null;
      const base = markerSpace(this.view);
      return {
        left: (rect.left - base.left) / base.scaleX,
        top: (box.top - base.top) / base.scaleY,
        height: (box.bottom - box.top) / base.scaleY,
        kind: box.kind,
      };
    }

    drawCursor(pos) {
      if (!this.cursor) return;
      if (pos) {
        this.cursor.style.left = pos.left + 'px';
        this.cursor.style.top = pos.top + 'px';
        this.cursor.style.height = pos.height + 'px';
        this.cursor.classList.toggle('cm-cursor-code', pos.kind === 'code');
        this.cursor.classList.toggle('cm-cursor-body', pos.kind === 'body');
      } else {
        this.cursor.style.left = '-100000px';
      }
    }

    destroy() {
      if (this.cursor) this.cursor.remove();
    }

    setDropPos(pos) {
      if (this.view.state.field(dropCursorPos) !== pos) {
        this.view.dispatch({ effects: setDropCursorPos.of(pos) });
      }
    }
  },
  {
    eventObservers: {
      dragover(event) {
        this.setDropPos(this.view.posAtCoords({ x: event.clientX, y: event.clientY }));
      },
      dragleave(event) {
        if (event.target === this.view.contentDOM || !this.view.contentDOM.contains(event.relatedTarget)) {
          this.setDropPos(null);
        }
      },
      dragend() {
        this.setDropPos(null);
      },
      drop() {
        this.setDropPos(null);
      },
    },
  }
);

export function dropCursor() {
  return [dropCursorPos, drawDropCursor];
}
