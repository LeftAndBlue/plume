/** 打开文件时去掉 UTF-8 BOM；它不属于正文，会让首个标题或 YAML 文首信息失效。 */
export function normalizeMarkdownText(value) {
  return String(value ?? '').replace(/^\uFEFF/, '');
}

/** 文首 `---` … `---`。没有成对结尾时不当成文首信息。 */
export function scanFrontMatter(doc) {
  if (doc.lines < 2 || !/^---\s*$/.test(doc.line(1).text.replace(/^\uFEFF/, ''))) return null;
  for (let n = 2; n <= doc.lines; n++) {
    if (/^(?:---|\.\.\.)\s*$/.test(doc.line(n).text)) {
      const fields = [];
      for (let k = 2; k < n; k++) {
        const m = /^([^:#\s][^:]*):\s*(.*)$/.exec(doc.line(k).text);
        if (m) fields.push({ key: m[1].trim(), value: m[2].trim() });
      }
      return { from: doc.line(1).from, to: doc.line(n).to, startLine: 1, endLine: n, fields };
    }
  }
  return null;
}

/** 脚注定义：行首 `[^id]: 说明`。 */
export function footnoteDef(text) {
  const m = /^\[\^([^\]]+)\]:[ \t]*(.*)$/.exec(text || '');
  if (!m) return null;
  return { id: m[1], text: m[2] };
}

/** `{width=50% align=center}`，写在图片括号后面。 */
export function parseImageAttrs(body) {
  const raw = String(body || '');
  const width = /(?:^|\s)width\s*=\s*"?([^"\s}]+)"?/i.exec(raw);
  const align = /(?:^|\s)align\s*=\s*"?(left|center|right)"?/i.exec(raw);
  return {
    width: width ? width[1] : '',
    align: align ? align[1].toLowerCase() : '',
  };
}

/** 紧跟在图片语法后面的属性块。没有就返回 null。 */
export function imageBraceAfter(doc, to) {
  const rest = doc.sliceString(to, Math.min(doc.length, to + 120));
  const m = /^\{([^{}\n]*)\}/.exec(rest);
  if (!m) return null;
  return { raw: m[0], end: to + m[0].length, ...parseImageAttrs(m[1]) };
}

/* ---------------- GFM 表格与安全的行内 HTML 兼容 ---------------- */

/**
 * 切分一行表格，同时保留每个单元格在源文档里的区间。
 *
 * 与简单的 split('|') 不同，这里会跳过：
 * - `\|` 转义竖线（连续反斜杠按奇偶处理）；
 * - 反引号代码 span 内的竖线，支持 `` ``a|b`` `` 等多反引号写法；
 * - 可省略的行首、行尾管道符。
 */
export function splitTableRow(text, base = 0) {
  const source = String(text ?? '');
  const bounds = [];
  let start = 0;
  let codeTicks = 0;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\' && i + 1 < source.length) {
      i++;
      continue;
    }
    if (ch === '`') {
      let end = i + 1;
      while (end < source.length && source[end] === '`') end++;
      const size = end - i;
      if (!codeTicks) codeTicks = size;
      else if (codeTicks === size) codeTicks = 0;
      i = end - 1;
      continue;
    }
    if (ch === '|' && !codeTicks) {
      bounds.push([start, i]);
      start = i + 1;
    }
  }
  bounds.push([start, source.length]);

  // 第一个空片段来自可省略的行首管道，最后一个空片段来自行尾管道。
  if (bounds.length > 1 && /^\s*\|/.test(source)) bounds.shift();
  if (bounds.length > 1 && /\|\s*$/.test(source) && !source.slice(bounds[bounds.length - 1][0]).trim()) {
    bounds.pop();
  }

  return bounds.map(([a, b]) => {
    const rawWithSpace = source.slice(a, b);
    const raw = rawWithSpace.trim();
    const leading = rawWithSpace.length - rawWithSpace.trimStart().length;
    const from = base + a + leading;
    return {
      text: raw.replace(/\\\|/g, '|'),
      raw,
      from,
      to: from + raw.length,
    };
  });
}

/** 表格分隔行：每格都是 `---`、`:---`、`---:` 或 `:---:`。 */
export function isTableDelimiterRow(text, expectedCols = 0) {
  const cells = splitTableRow(text);
  if (!cells.length || (expectedCols && cells.length !== expectedCols)) return false;
  return cells.every((cell) => /^:?-+:?$/.test(cell.raw.replace(/\s/g, '')));
}

/** 判断正文行是否能属于当前表格；没有外侧管道时必须与表头列数一致。 */
export function isTableRow(text, cols = 0) {
  const source = String(text ?? '');
  if (!source.trim()) return false;
  if (/^\s*>/.test(source) || /^\s{0,3}#{1,6}(?:\s|$)/.test(source)) return false;
  if (/^\s*(?:`{3,}|~{3,})/.test(source)) return false;
  if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(source)) return false;
  if (/^\s*\|/.test(source) || /\|\s*$/.test(source)) return splitTableRow(source).length >= 2;
  return cols >= 2 && splitTableRow(source).length === cols;
}

const tableCache = new WeakMap();

/**
 * 扫描文档里的完整表格。结果按不可变 CodeMirror Text 缓存，编辑器块级与
 * 行内装饰共用同一批区间，避免宽松表格（无行首 |）被行内规则二次渲染。
 */
export function scanTables(doc) {
  const cached = tableCache.get(doc);
  if (cached) return cached;
  const tables = [];
  const frontMatter = scanFrontMatter(doc);
  let fence = null;
  let i = frontMatter ? frontMatter.endLine + 1 : 1;

  while (i <= doc.lines) {
    const line = doc.line(i);
    const text = line.text;
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(text);
    if (marker) {
      const char = marker[1][0];
      const size = marker[1].length;
      if (!fence) fence = { char, size };
      else if (char === fence.char && size >= fence.size && /^\s{0,3}`*\s*$|^\s{0,3}~*\s*$/.test(text)) fence = null;
      i++;
      continue;
    }
    if (fence || i >= doc.lines) {
      i++;
      continue;
    }

    const delimiter = doc.line(i + 1).text;
    const delimiterCols = splitTableRow(delimiter).length;
    if (!isTableDelimiterRow(delimiter) || !isTableRow(text, delimiterCols)) {
      i++;
      continue;
    }
    const cols = splitTableRow(text).length;
    if (cols < 2 || delimiterCols !== cols) {
      i++;
      continue;
    }

    let endLine = i + 1;
    while (endLine + 1 <= doc.lines) {
      const next = doc.line(endLine + 1).text;
      if (isTableRow(next, cols)) {
        endLine++;
        continue;
      }
      // 保留既有的宽松行为：表格中间单个空行不会把后半截打回裸源码。
      if (!next.trim() && endLine + 2 <= doc.lines && isTableRow(doc.line(endLine + 2).text, cols)) {
        endLine += 2;
        continue;
      }
      break;
    }

    const rows = [];
    for (let n = i; n <= endLine; n++) {
      if (n === i + 1 || !doc.line(n).text.trim()) continue;
      const rowLine = doc.line(n);
      const cells = splitTableRow(rowLine.text, rowLine.from).slice(0, cols);
      while (cells.length < cols) cells.push({ text: '', raw: '', from: rowLine.to, to: rowLine.to });
      rows.push({ cells });
    }
    const aligns = splitTableRow(delimiter).map((cell) => {
      const spec = cell.raw.trim();
      if (spec.startsWith(':') && spec.endsWith(':')) return 'center';
      if (spec.endsWith(':')) return 'right';
      return '';
    });
    tables.push({
      startLine: i,
      endLine,
      from: line.from,
      to: doc.line(endLine).to,
      cols,
      rows,
      aligns,
    });
    i = endLine + 1;
  }

  tableCache.set(doc, tables);
  return tables;
}

/** 只允许无属性的表现层标签；其它 HTML 始终按纯文本显示，不注入 DOM。 */
export const INLINE_HTML_CLASSES = Object.freeze({
  kbd: 'cm-kbd',
  u: 'cm-underline',
  mark: 'cm-mark',
  sup: 'cm-sup',
  sub: 'cm-sub',
});

export function scanInlineHtml(text) {
  const found = [];
  const re = /<(kbd|u|mark|sup|sub)>([^<>\n]*?)<\/\1>/gi;
  let match;
  while ((match = re.exec(String(text ?? '')))) {
    const tag = match[1].toLowerCase();
    const openEnd = match.index + match[1].length + 2;
    const closeFrom = openEnd + match[2].length;
    found.push({
      tag,
      className: INLINE_HTML_CLASSES[tag],
      from: match.index,
      to: re.lastIndex,
      contentFrom: openEnd,
      contentTo: closeFrom,
      openFrom: match.index,
      openTo: openEnd,
      closeFrom,
      closeTo: re.lastIndex,
    });
  }
  return found;
}
