/**
 * 表格的纯数据操作。
 *
 * 行结构固定为：rows[0] 表头、rows[1] 分隔行、rows[2..] 数据行。
 * 这里不读取文档、不访问 DOM，也不派发编辑器事务；调用方负责持久化。
 */

export function cloneTableRows(rows) {
  return rows.map((row) => row.slice());
}

export function setAlign(rows, col, mode) {
  if (!rows[1] || col < 0 || col >= rows[0].length) return false;
  const spec = mode === 'center' ? ':---:' : mode === 'right' ? '---:' : ':---';
  while (rows[1].length < rows[0].length) rows[1].push('---');
  rows[1][col] = spec;
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
    // 删除表头时让第一行数据上位，分隔行仍保持在 rows[1]。
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

/** 把拖动的像素列宽转换为分隔行中的 '-' 数量，并保留当前对齐方式。 */
export function setTableColumnWidth(rows, col, width, align) {
  const spec = '-'.repeat(Math.max(3, Math.round(width / 8)));
  rows[1][col] = align === 'center' ? `:${spec}:` : align === 'right' ? `${spec}:` : `:${spec}`;
}

/** 上移/下移一整行（visualRow 0 是表头，不可移动；数据行从视觉行 1 开始）。 */
export function moveTableRow(rows, visualRow, delta) {
  if (visualRow <= 0 || !delta) return false;
  const from = visualRow + 1; // rows[0]=表头、rows[1]=分隔行，数据行从 2 起
  const to = from + delta;
  if (from < 2 || from >= rows.length || to < 2 || to >= rows.length) return false;
  const [row] = rows.splice(from, 1);
  rows.splice(to, 0, row);
  return true;
}

/** 左移/右移一整列（表头、分隔行、数据行一起换位）。 */
export function moveTableCol(rows, col, delta) {
  const to = col + delta;
  if (!delta || col < 0 || to < 0 || col >= rows[0].length || to >= rows[0].length) return false;
  rows.forEach((row) => {
    const [cell] = row.splice(col, 1);
    row.splice(to, 0, cell);
  });
  return true;
}
