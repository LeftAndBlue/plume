import { RectangleMarker, layer } from '@codemirror/view';
import { markerSpace } from './editor-geometry.js';

/**
 * 多行选区的「整行」高亮左右边界取的是首行 padding。
 * 代码块为了行号把文字又往里推了一截，蓝底会盖住行号、铺满灰框的上下留白。
 * 和代码行重叠的那一段只留在文字盒子里：行号列、首尾内边距都不画。
 */

const CODE_LINE = '.cm-line.cm-code-line:not(.cm-fence-open):not(.cm-fence-close)';
// 坐标已经换算成文档空间，滚动不会改变结果。只有文档、视口或几何变化
// 才需要重新查询代码行；连续拖动选区可以复用同一批盒子。
const codeBandCache = new WeakMap();
const lineBoxCache = new WeakMap();

/**
 * CM 的 rectanglesForRange 用「内容区第一条 .cm-line」的 padding 当作所有行的
 * 左右边界。列表行的悬挂缩进也写在 padding-left 里，首行是列表时这个边界就
 * 比正文偏右一截：软换行续行的高亮（左边界开放到整行）会从缩进处才开始画，
 * 行首几个字看着像「选不中」。这里把开放到整行的边收回矩形所在行自己的文字边界。
 */
function lineBoxes(view) {
  const cached = lineBoxCache.get(view);
  if (cached) return cached;
  const base = markerSpace(view);
  const boxes = [];
  for (const line of view.contentDOM.querySelectorAll('.cm-line')) {
    const rect = line.getBoundingClientRect();
    if (rect.height < 1) continue;
    const style = getComputedStyle(line);
    const borderL = parseFloat(style.borderLeftWidth) || 0;
    const borderR = parseFloat(style.borderRightWidth) || 0;
    const padL = parseFloat(style.paddingLeft) || 0;
    const padR = parseFloat(style.paddingRight) || 0;
    boxes.push({
      top: (rect.top - base.top) / base.scaleY,
      bottom: (rect.bottom - base.top) / base.scaleY,
      left: (rect.left + borderL + padL - base.left) / base.scaleX,
      right: (rect.right - borderR - padR - base.left) / base.scaleX,
    });
  }
  boxes.sort((a, b) => a.top - b.top);
  lineBoxCache.set(view, boxes);
  return boxes;
}

function globalSides(view) {
  const base = markerSpace(view);
  const contentRect = view.contentDOM.getBoundingClientRect();
  const first = view.contentDOM.querySelector('.cm-line');
  const style = first && getComputedStyle(first);
  const padL = style ? parseInt(style.paddingLeft) || 0 : 0;
  const padR = style ? parseInt(style.paddingRight) || 0 : 0;
  const indent = style ? Math.min(0, parseInt(style.textIndent) || 0) : 0;
  return {
    left: (contentRect.left + padL + indent - base.left) / base.scaleX,
    right: (contentRect.right - padR - base.left) / base.scaleX,
  };
}

function snapSides(marker, view, sides) {
  if (marker.width == null) return marker;
  const openL = Math.abs(marker.left - sides.left) < 0.5;
  const openR = Math.abs(marker.left + marker.width - sides.right) < 0.5;
  if (!openL && !openR) return marker;
  const mid = marker.top + marker.height / 2;
  const box = lineBoxes(view).find((b) => b.top <= mid && b.bottom >= mid);
  if (!box) return marker;
  const left = openL ? box.left : marker.left;
  const right = openR ? box.right : marker.left + marker.width;
  if (right <= left) return marker;
  return new RectangleMarker(marker.className, left, marker.top, right - left, marker.height);
}

function codeBands(view) {
  const cached = codeBandCache.get(view);
  if (cached) return cached;
  const base = markerSpace(view);
  const bands = [];
  for (const line of view.contentDOM.querySelectorAll(CODE_LINE)) {
    const rect = line.getBoundingClientRect();
    if (rect.height < 1) continue;
    const style = getComputedStyle(line);
    const borderL = parseFloat(style.borderLeftWidth) || 0;
    const borderR = parseFloat(style.borderRightWidth) || 0;
    const borderT = parseFloat(style.borderTopWidth) || 0;
    const borderB = parseFloat(style.borderBottomWidth) || 0;
    const padL = parseFloat(style.paddingLeft) || 0;
    const padR = parseFloat(style.paddingRight) || 0;
    const padT = parseFloat(style.paddingTop) || 0;
    const padB = parseFloat(style.paddingBottom) || 0;
    const textLeft = (rect.left + borderL + padL - base.left) / base.scaleX;
    const textRight = (rect.right - borderR - padR - base.left) / base.scaleX;
    const textTop = (rect.top + borderT + padT - base.top) / base.scaleY;
    const textBottom = (rect.bottom - borderB - padB - base.top) / base.scaleY;
    if (textRight <= textLeft + 1 || textBottom <= textTop + 1) continue;
    bands.push({
      boxTop: (rect.top - base.top) / base.scaleY,
      boxBottom: (rect.bottom - base.top) / base.scaleY,
      textTop,
      textBottom,
      textLeft,
      textRight,
    });
  }
  bands.sort((a, b) => a.boxTop - b.boxTop);
  codeBandCache.set(view, bands);
  return bands;
}

function clipMarker(marker, bands) {
  if (!bands.length || marker.width == null) return [marker];
  const top = marker.top;
  const bottom = marker.top + marker.height;
  const left = marker.left;
  const right = marker.left + marker.width;
  const hits = bands.filter((band) => band.boxBottom > top + 0.5 && band.boxTop < bottom - 0.5);
  if (!hits.length) return [marker];

  const pieces = [];
  let cursor = top;
  for (const band of hits) {
    if (band.boxTop > cursor + 0.5) {
      pieces.push(new RectangleMarker('cm-selectionBackground', left, cursor, marker.width, band.boxTop - cursor));
    }
    // 行号列和首尾内边距直接丢掉，不沿用整行那么宽的色块。
    const sliceTop = Math.max(cursor, band.textTop);
    const sliceBottom = Math.min(bottom, band.textBottom);
    const sliceLeft = Math.max(left, band.textLeft);
    const sliceRight = Math.min(right, band.textRight);
    // 整行色块偶尔只探进文字盒子两三像素，会在代码顶上留下一条横线。
    if (sliceBottom > sliceTop + 6 && sliceRight > sliceLeft + 0.5) {
      pieces.push(
        new RectangleMarker('cm-selectionBackground', sliceLeft, sliceTop, sliceRight - sliceLeft, sliceBottom - sliceTop)
      );
    }
    cursor = Math.max(cursor, band.boxBottom);
  }
  if (bottom > cursor + 0.5) {
    pieces.push(new RectangleMarker('cm-selectionBackground', left, cursor, marker.width, bottom - cursor));
  }
  return pieces;
}

function fitSelectionMarkers(view) {
  const bands = codeBands(view);
  const sides = globalSides(view);
  const pieces = [];
  for (const range of view.state.selection.ranges) {
    if (range.empty) continue;
    for (const marker of RectangleMarker.forRange(view, 'cm-selectionBackground', range)) {
      pieces.push(...clipMarker(snapSides(marker, view, sides), bands));
    }
  }
  return pieces;
}

export const codeSelectionFit = layer({
  above: false,
  class: 'cm-selection-fit',
  markers(view) {
    try {
      return fitSelectionMarkers(view);
    } catch (error) {
      console.warn('[selection-fit]', error);
      const pieces = [];
      for (const range of view.state.selection.ranges) {
        if (range.empty) continue;
        pieces.push(...RectangleMarker.forRange(view, 'cm-selectionBackground', range));
      }
      return pieces;
    }
  },
  update(update) {
    if (update.docChanged || update.viewportChanged || update.geometryChanged) {
      codeBandCache.delete(update.view);
      lineBoxCache.delete(update.view);
      return true;
    }
    return update.selectionSet;
  },
});
