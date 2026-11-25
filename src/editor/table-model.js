/**
 * 表格的纯数据操作。
 *
 * 行结构固定为：rows[0] 表头、rows[1] 分隔行、rows[2..] 数据行。
 * 这里不读取文档、不访问 DOM，也不派发编辑器事务；调用方负责持久化。
 */

export function buildTableMarkdown(cols, rows) {
  const clamp = (v, lo, hi) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
  };
  const c = clamp(cols, 2, 20);
  const r = clamp(rows, 2, 30);
  const line = (cell) => '| ' + Array.from({ length: c }, (_, i) => cell(i)).join(' | ') + ' |';
  const blank = () => '';
  const lines = [line(blank), line(() => '---')];
  for (let n = 1; n < r; n++) lines.push(line(blank));
  return lines.join('\n') + '\n';
}

export function cloneTableRows(rows) {
  return rows.map((row) => row.slice());
}

/** 视觉行号（0 = 表头，1.. = 数据行）转源码数组下标（0 = 表头，2.. = 数据行）。 */
export function visualToSourceRow(visualRow) {
  return visualRow <= 0 ? 0 : visualRow + 1;
}

export function setAlign(rows, col, mode) {
  if (!rows[1] || col < 0 || col >= rows[0].length) return false;
  const spec = mode === 'center' ? ':---:' : mode === 'right' ? '---:' : ':---';
  while (rows[1].length < rows[0].length) rows[1].push('---');
  rows[1][col] = spec;
  return true;
}

/** 批量为多列设置对齐方式。 */
export function setAlignCols(rows, cols, mode) {
  if (!Array.isArray(cols) || !cols.length) return false;
  let changed = false;
  for (const col of cols) {
    if (setAlign(rows, col, mode)) changed = true;
  }
  return changed;
}

export function insertTableRow(rows, visualRow) {
  const cols = Math.max(1, rows[0].length);
  const blank = Array.from({ length: cols }, () => '');
  const at = visualRow <= 0 ? 2 : Math.min(rows.length, visualRow + 2);
  rows.splice(at, 0, blank);
}

export function insertTableCol(rows, col) {
  const at = Math.min(Math.max(col, 0) + 1, rows[0].length);
  rows.forEach((row, index) => {
    const fill = index === 1 ? '---' : '';
    while (row.length < at) row.push(fill);
    row.splice(at, 0, fill);
  });
}

export function deleteTableRow(rows, visualRow) {
  if (rows.length <= 2) return false;
  if (visualRow <= 0) {
    rows[0] = rows[2];
    rows.splice(2, 1);
    return;
  }
  const index = visualRow + 1;
  if (index < 2 || index >= rows.length) return false;
  rows.splice(index, 1);
}

export function deleteTableCol(rows, col) {
  if (!rows[0] || rows[0].length <= 1) return false;
  const at = Math.min(Math.max(col, 0), rows[0].length - 1);
  rows.forEach((row) => {
    if (at < row.length) row.splice(at, 1);
  });
}

export function sortTableRows(rows, col, descending) {
  if (rows.length <= 3) return;
  const body = rows.slice(2);
  body.sort((a, b) => {
    const result = String(a[col] || '').localeCompare(String(b[col] || ''), 'zh-CN', {
      numeric: true,
      sensitivity: 'base',
    });
    return descending ? -result : result;
  });
  rows.splice(2, body.length, ...body);
}

export function setTableColumnWidth(rows, col, width, align) {
  const spec = '-'.repeat(Math.max(3, Math.round(width / 8)));
  rows[1][col] = align === 'center' ? `:${spec}:` : align === 'right' ? `${spec}:` : `:${spec}`;
}

export function moveTableRow(rows, visualRow, delta) {
  if (visualRow <= 0 || !delta) return false;
  const from = visualRow + 1;
  const to = from + delta;
  if (from < 2 || from >= rows.length || to < 2 || to >= rows.length) return false;
  const [row] = rows.splice(from, 1);
  rows.splice(to, 0, row);
  return true;
}

export function moveTableCol(rows, col, delta) {
  const to = col + delta;
  if (!delta || col < 0 || to < 0 || col >= rows[0].length || to >= rows[0].length) return false;
  rows.forEach((row) => {
    const [cell] = row.splice(col, 1);
    row.splice(to, 0, cell);
  });
  return true;
}

/** 整块上移/下移多选的数据行（不含表头 row 0）。 */
export function moveTableRowsBlock(rows, selRows, delta) {
  if (!delta || !Array.isArray(selRows) || !selRows.length) return false;
  const dataRows = selRows.filter((r) => r >= 1).sort((a, b) => a - b);
  if (!dataRows.length) return false;
  const firstSrc = visualToSourceRow(dataRows[0]);
  const lastSrc = visualToSourceRow(dataRows[dataRows.length - 1]);
  if (delta < 0) {
    if (firstSrc <= 2) return false;
    const [above] = rows.splice(firstSrc - 1, 1);
    rows.splice(lastSrc, 0, above);
    return true;
  }
  if (lastSrc >= rows.length - 1) return false;
  const [below] = rows.splice(lastSrc + 1, 1);
  rows.splice(firstSrc, 0, below);
  return true;
}

/** 整块左移/右移多选列（表头、分隔行、数据行同步换位）。 */
export function moveTableColsBlock(rows, selCols, delta) {
  if (!delta || !Array.isArray(selCols) || !selCols.length || !rows[0]) return false;
  const cols = [...selCols].sort((a, b) => a - b);
  const first = cols[0];
  const last = cols[cols.length - 1];
  const colCount = rows[0].length;
  if (delta < 0) {
    if (first <= 0) return false;
    rows.forEach((row) => {
      const [left] = row.splice(first - 1, 1);
      row.splice(last, 0, left);
    });
    return true;
  }
  if (last >= colCount - 1) return false;
  rows.forEach((row) => {
    const [right] = row.splice(last + 1, 1);
    row.splice(first, 0, right);
  });
  return true;
}

/** 清空选中矩形内的所有单元格内容（保留表格行列结构）。 */
export function clearTableCells(rows, bounds) {
  if (!bounds) return false;
  let changed = false;
  for (let r = bounds.r1; r <= bounds.r2; r++) {
    const srcIdx = visualToSourceRow(r);
    const row = rows[srcIdx];
    if (!row) continue;
    for (let c = bounds.c1; c <= bounds.c2; c++) {
      if (c >= 0 && c < row.length && row[c] !== '') {
        row[c] = '';
        changed = true;
      }
    }
  }
  return changed;
}

function stripInlineMarks(text) {
  return String(text || '')
    .replace(/==(.+?)==/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1');
}

function isWrappedWith(text, marker) {
  const s = String(text || '').trim();
  if (!s || s.length <= marker.length * 2) return false;
  if (!s.startsWith(marker) || !s.endsWith(marker)) return false;
  if (marker === '*' && s.startsWith('**') && s.endsWith('**')) return false;
  return true;
}

/**
 * 批量切换选中单元格的行内格式（`**` / `*` / `` ` `` / `~~` / `==`，传 `null` 清除行内格式）。
 * 若所有非空选中单元格均已包裹该标记则统一取消，否则统一加上。
 */
export function formatTableCells(rows, bounds, marker) {
  if (!bounds) return false;
  const cells = [];
  for (let r = bounds.r1; r <= bounds.r2; r++) {
    const row = rows[visualToSourceRow(r)];
    if (!row) continue;
    for (let c = bounds.c1; c <= bounds.c2; c++) {
      if (c >= 0 && c < row.length && String(row[c] || '').trim()) {
        cells.push([row, c]);
      }
    }
  }
  if (!cells.length) return false;

  if (!marker) {
    let changed = false;
    for (const [row, c] of cells) {
      const next = stripInlineMarks(row[c]);
      if (next !== row[c]) {
        row[c] = next;
        changed = true;
      }
    }
    return changed;
  }

  const allWrapped = cells.every(([row, c]) => isWrappedWith(row[c], marker));
  for (const [row, c] of cells) {
    const trimmed = String(row[c]).trim();
    if (allWrapped) {
      row[c] = trimmed.slice(marker.length, trimmed.length - marker.length);
    } else if (!isWrappedWith(trimmed, marker)) {
      row[c] = `${marker}${trimmed}${marker}`;
    }
  }
  return true;
}

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 序列化表格选中矩形，同时产出：
 * - `tsv`：制表符分隔文本（可直接粘贴进 Excel / 飞书 / 另一个表格）
 * - `markdown`：选中区域的 Markdown 表格
 * - `html`：标准 `<table>` HTML
 */
export function serializeTableSelection(rows, bounds) {
  if (!bounds || !rows?.length) return { tsv: '', markdown: '', html: '' };
  const grid = [];
  for (let r = bounds.r1; r <= bounds.r2; r++) {
    const row = rows[visualToSourceRow(r)];
    if (!row) continue;
    const slice = [];
    for (let c = bounds.c1; c <= bounds.c2; c++) {
      slice.push(String(row[c] ?? ''));
    }
    grid.push(slice);
  }
  if (!grid.length) return { tsv: '', markdown: '', html: '' };

  const tsv = grid
    .map((line) => line.map((cell) => cell.replace(/<br\s*\/?>/gi, ' ').replace(/\t/g, ' ')).join('\t'))
    .join('\n');

  const mdLine = (cells) => '| ' + cells.join(' | ') + ' |';
  const colCount = grid[0].length;
  const delim = Array.from({ length: colCount }, (_, i) => rows[1]?.[bounds.c1 + i] || '---');
  const markdown = [mdLine(grid[0]), mdLine(delim), ...grid.slice(1).map(mdLine)].join('\n') + '\n';

  const htmlRows = grid
    .map((line, idx) => {
      const tag = bounds.r1 === 0 && idx === 0 ? 'th' : 'td';
      return '<tr>' + line.map((cell) => `<${tag}>${escHtml(cell)}</${tag}>`).join('') + '</tr>';
    })
    .join('');
  const html = `<table><tbody>${htmlRows}</tbody></table>`;

  return { tsv, markdown, html };
}

/**
 * 将剪贴板文本（TSV / 多行文本 / 单值）粘贴到表格选中区域：
 * - 单值（1×1）粘贴到多选区域时，批量填充选中的每一个单元格
 * - 多行多列（M×N）从选区左上角 `(r1, c1)` 起按行列铺开，超出现有行列时自动扩展（上限 30 行 × 20 列）
 */
export function pasteTableCells(rows, bounds, clipboardText) {
  if (!bounds || clipboardText == null || !rows?.length) return false;
  const clean = String(clipboardText).replace(/\r\n?/g, '\n').replace(/\n$/, '');
  if (!clean && clipboardText === '') return false;

  const escPipe = (s) => String(s).replace(/\|/g, '\\|');
  const parsed = clean.split('\n').map((line) => line.split('\t').map((cell) => escPipe(cell.trim())));

  // 单值粘贴到多选区：整块填充
  if (parsed.length === 1 && parsed[0].length === 1) {
    const val = parsed[0][0];
    for (let r = bounds.r1; r <= bounds.r2; r++) {
      const row = rows[visualToSourceRow(r)];
      if (!row) continue;
      for (let c = bounds.c1; c <= bounds.c2; c++) {
        if (c >= 0 && c < row.length) row[c] = val;
      }
    }
    return true;
  }

  const maxRows = 30;
  const maxCols = 20;
  const neededCols = Math.min(maxCols, Math.max(rows[0].length, bounds.c1 + Math.max(...parsed.map((r) => r.length))));
  while (rows[0].length < neededCols) {
    rows.forEach((row, idx) => row.push(idx === 1 ? '---' : ''));
  }

  for (let dr = 0; dr < parsed.length; dr++) {
    const visualR = bounds.r1 + dr;
    if (visualR >= maxRows) break;
    const srcIdx = visualToSourceRow(visualR);
    while (rows.length <= srcIdx) {
      rows.push(Array.from({ length: rows[0].length }, () => ''));
    }
    const targetRow = rows[srcIdx];
    for (let dc = 0; dc < parsed[dr].length; dc++) {
      const targetCol = bounds.c1 + dc;
      if (targetCol >= maxCols || targetCol >= targetRow.length) break;
      targetRow[targetCol] = parsed[dr][dc];
    }
  }
  return true;
}
