/**
 * 编辑器的「盲打直觉」键盘增强：
 * - Tab / Shift+Tab：统一软缩进（代码块 2/4 空格、列表含引用内列表调级与有序重排、跳出行内闭合符、正文不误插硬 \t）
 * - Enter / Shift+Enter：嵌套空列表/空引用逐级退层、选区删除后续标记、代码块括号展开缩进、正文/列表/引用软换行
 * - Backspace / Space：代码块软缩进整步回删、任务列表 `- [] ` 自动规范化为 `- [ ] `
 *
 * 本模块不依赖 @codemirror/*，只依赖零外部依赖的 code-fences.js，
 * 以便既直接接入 runtime.js / pairing.js，也能在 Node 单元测试中直接验证全部边界。
 */
import { getCodeFences } from './code-fences.js';

export const DEFAULT_INDENT_WIDTH = 2;

const LIST_LINE_RE = /^([ \t]{0,3}(?:>[ \t]?)+)?([ \t]*)([-*+]|\d+[.)])([ \t]+)(\[[ xX]\][ \t]+)?([\s\S]*)$/;
const QUOTE_LINE_RE = /^([ \t]*(?:>[ \t]?)+)([\s\S]*)$/;
const EMPTY_TASK_BEFORE_SPACE_RE = /^([ \t]{0,3}(?:>[ \t]?)+)?[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[\]$/;
const TASK_INNER_BEFORE_SPACE_RE = /^([ \t]{0,3}(?:>[ \t]?)+)?[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[([ xX])$/;

const BRACKET_PAIRS = {
  '{': '}',
  '(': ')',
  '[': ']',
};

const ASYM_CLOSERS = {
  ')': '(',
  ']': '[',
  '}': '{',
};

const MULTI_CLOSERS = ['***', '**', '__', '~~', '$$', '=='];
const SINGLE_SYM_CLOSERS = new Set(['*', '_', '~', '`', '"', '$']);

/** 计算前导空白的视觉列宽（\t 按 tabSize 计算）。 */
export function indentColumns(lead, tabSize = DEFAULT_INDENT_WIDTH) {
  let cols = 0;
  for (let i = 0; i < lead.length; i++) {
    cols += lead[i] === '\t' ? tabSize : 1;
  }
  return cols;
}

/**
 * 反缩进单步删除字符数：
 * 遇到 \t 只删 1 字符（不跨两级），空格最多删 width 个。
 */
export function outdentLength(lead, width = DEFAULT_INDENT_WIDTH) {
  if (!lead) return 0;
  if (lead[0] === '\t') return 1;
  let n = 0;
  while (n < lead.length && n < width && lead[n] === ' ') n++;
  return n;
}

/**
 * 解析列表行（兼容普通列表、任务列表与引用块内列表 `> - item`）。
 * 不是列表行返回 null。
 */
export function parseListLine(text) {
  const m = LIST_LINE_RE.exec(text);
  if (!m) return null;
  const quotePrefix = m[1] || '';
  const indent = m[2];
  const marker = m[3];
  const space = m[4];
  const task = m[5] || '';
  const content = m[6];
  const isOrdered = /^\d+[.)]$/.test(marker);
  return {
    quotePrefix,
    indent,
    marker,
    space,
    task,
    content,
    prefixLen: quotePrefix.length + indent.length + marker.length + space.length + task.length,
    isOrdered,
    number: isOrdered ? parseInt(marker, 10) : null,
    delim: isOrdered ? marker.slice(-1) : '',
  };
}

/** 根据已解析的列表项生成下一行的续行前缀（有序 +1、任务重置为 `[ ] `）。 */
export function buildNextListPrefix(parsed) {
  const mark = parsed.isOrdered ? `${parsed.number + 1}${parsed.delim}` : parsed.marker;
  return parsed.indent + mark + ' ' + (parsed.task ? '[ ] ' : '');
}

/** 规范化引用前缀用于比较同一引用层级（去掉每层 `>` 后多余空白差异）。 */
function normalizeQuoteKey(quotePrefix) {
  return (quotePrefix || '').replace(/[ \t]+/g, '');
}

/**
 * 判断光标是否位于代码块正文内（排除围栏开/闭行本身）。
 * 优先使用统一的围栏扫描器，必要时回退到外部传入的语法树判断（如缩进代码块）。
 */
export function isInsideCodeBlock(state, pos, extraCheck) {
  const blocks = getCodeFences(state);
  for (const block of blocks) {
    if (!(block.close || block.implicit)) continue;
    if (pos >= block.open.line.from && pos <= block.open.line.to) return false;
    if (block.close && pos >= block.close.line.from && pos <= block.close.line.to) return false;
    if (pos >= block.codeFrom && pos <= block.codeTo) return true;
  }
  return typeof extraCheck === 'function' ? !!extraCheck(state, pos) : false;
}

/**
 * 向上查找与当前行同属一个引用层、且位于指定缩进列数 `targetCols` 的有序列表前驱序号。
 * 若没有同级前驱（或先遇到父级列表/无序列表/列表中断），返回 1；否则返回前驱序号 + 1。
 */
function findOrderedStartForLevel(doc, lineNo, quoteKey, targetCols, tabSize = DEFAULT_INDENT_WIDTH) {
  for (let n = lineNo - 1; n >= 1; n--) {
    const text = doc.line(n).text;
    if (!text.trim()) break;
    const parsed = parseListLine(text);
    if (parsed) {
      if (normalizeQuoteKey(parsed.quotePrefix) !== quoteKey) break;
      const cols = indentColumns(parsed.indent, tabSize);
      if (cols > targetCols) continue;
      if (cols < targetCols) return 1;
      return parsed.isOrdered ? parsed.number + 1 : 1;
    }
    // 非列表行：只有属于同一引用层且缩进更深的续行才允许跳过
    if (quoteKey) {
      const qm = QUOTE_LINE_RE.exec(text);
      if (!qm || normalizeQuoteKey(qm[1]) !== quoteKey) break;
      const lead = /^[ \t]*/.exec(qm[2])[0];
      if (indentColumns(lead, tabSize) > targetCols && qm[2].trim()) continue;
      break;
    } else {
      const lead = /^[ \t]*/.exec(text)[0];
      if (indentColumns(lead, tabSize) > targetCols) continue;
      break;
    }
  }
  return 1;
}

/**
 * 判断某行是否属于指定引用层内的列表块（列表行或缩进续行）。
 */
function isLineInQuoteListBlock(text, quoteKey) {
  if (!text.trim()) return false;
  const parsed = parseListLine(text);
  if (parsed) return normalizeQuoteKey(parsed.quotePrefix) === quoteKey;
  if (quoteKey) {
    const qm = QUOTE_LINE_RE.exec(text);
    if (!qm || normalizeQuoteKey(qm[1]) !== quoteKey) return false;
    return /^[ \t]+\S/.test(qm[2]);
  }
  return /^[ \t]+\S/.test(text);
}

/**
 * Tab / Shift+Tab 调列表层级（兼容普通列表与引用块内列表）：
 * - 保留前置 `> `，只对 `>` 之后的列表缩进增减 2 空格
 * - 反缩进遇到 `\t` 只删 1 字符，空格最多删 2 个
 * - 有序列表降级时子列表自动从 1 重置，升级时顺延父级序号，并同步修正后续同级序号
 */
export function indentList(view, dir, options = {}) {
  const { tabSize = DEFAULT_INDENT_WIDTH, isCodeBlock } = options;
  const { state } = view;
  const doc = state.doc;
  const lineNos = [];
  for (const r of state.selection.ranges) {
    const a = doc.lineAt(r.from).number;
    const b = doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) {
      if (!lineNos.includes(n)) lineNos.push(n);
    }
  }

  /** @type {Map<number, { line: any, parsed: any, newIndent: string, oldCols: number, newCols: number, changedIndent: boolean }>} */
  const targets = new Map();
  for (const n of lineNos) {
    const line = doc.line(n);
    if (isInsideCodeBlock(state, line.from, isCodeBlock)) continue;
    const parsed = parseListLine(line.text);
    if (!parsed) continue;
    let newIndent = parsed.indent;
    if (dir > 0) {
      newIndent = ' '.repeat(tabSize) + parsed.indent;
    } else {
      const cut = outdentLength(parsed.indent, tabSize);
      newIndent = cut > 0 ? parsed.indent.slice(cut) : parsed.indent;
    }
    targets.set(n, {
      line,
      parsed,
      newIndent,
      oldCols: indentColumns(parsed.indent, tabSize),
      newCols: indentColumns(newIndent, tabSize),
      changedIndent: newIndent !== parsed.indent,
    });
  }

  if (targets.size === 0) return false;

  // 若选中的全是顶层列表且按 Shift+Tab（无缩进可退），消费按键避免焦点跳走。
  const anyIndentChanged = [...targets.values()].some((t) => t.changedIndent);
  if (!anyIndentChanged) return true;

  /** @type {Map<number, { from: number, to: number, insert: string }>} */
  const lineChanges = new Map();

  // 先为每个缩进变化的行准备缩进改动，稍后对有序列表统一重算编号。
  const quoteGroups = new Map();
  for (const [n, info] of targets.entries()) {
    const qKey = normalizeQuoteKey(info.parsed.quotePrefix);
    if (!quoteGroups.has(qKey)) quoteGroups.set(qKey, []);
    quoteGroups.get(qKey).push(n);
  }

  for (const [qKey, groupLineNos] of quoteGroups.entries()) {
    const hasOrdered = groupLineNos.some((n) => targets.get(n).parsed.isOrdered);
    if (!hasOrdered) {
      for (const n of groupLineNos) {
        const info = targets.get(n);
        if (!info.changedIndent) continue;
        const indentFrom = info.line.from + info.parsed.quotePrefix.length;
        lineChanges.set(n, {
          from: indentFrom,
          to: indentFrom + info.parsed.indent.length,
          insert: info.newIndent,
        });
      }
      continue;
    }

    // 找出涵盖当前组所有目标行的连续列表块范围
    const minLine = Math.min(...groupLineNos);
    const maxLine = Math.max(...groupLineNos);
    let blockStart = minLine;
    while (blockStart > 1 && isLineInQuoteListBlock(doc.line(blockStart - 1).text, qKey)) {
      blockStart--;
    }
    let blockEnd = maxLine;
    while (blockEnd < doc.lines && isLineInQuoteListBlock(doc.line(blockEnd + 1).text, qKey)) {
      blockEnd++;
    }

    const affectedLevels = new Set();
    for (const n of groupLineNos) {
      const info = targets.get(n);
      if (info.parsed.isOrdered && info.changedIndent) {
        affectedLevels.add(info.oldCols);
        affectedLevels.add(info.newCols);
      }
    }

    /** @type {Map<number, number>} */
    const counters = new Map();
    let seenModified = false;

    for (let n = blockStart; n <= blockEnd; n++) {
      const line = doc.line(n);
      const info = targets.get(n);
      const parsed = info ? info.parsed : parseListLine(line.text);
      if (!parsed || normalizeQuoteKey(parsed.quotePrefix) !== qKey) continue;

      const indent = info ? info.newIndent : parsed.indent;
      const cols = indentColumns(indent, tabSize);

      // 进入更浅层级时，清空所有更深层级的计数
      for (const level of [...counters.keys()]) {
        if (level > cols) counters.delete(level);
      }

      if (!parsed.isOrdered) {
        counters.delete(cols);
        if (info && info.changedIndent) {
          const indentFrom = line.from + parsed.quotePrefix.length;
          lineChanges.set(n, {
            from: indentFrom,
            to: indentFrom + parsed.indent.length,
            insert: indent,
          });
        }
        continue;
      }

      const isModified = !!(info && info.changedIndent);
      if (isModified) seenModified = true;

      let nextNum;
      if (counters.has(cols)) {
        nextNum = counters.get(cols) + 1;
      } else if (!seenModified && !isModified) {
        // 位于改动之前且未被改动的同级首项：保留用户原始起始编号（如 5.）
        nextNum = parsed.number;
      } else {
        nextNum = 1;
      }
      counters.set(cols, nextNum);

      const shouldRenumber = isModified || (seenModified && affectedLevels.has(cols));
      const newMarker = shouldRenumber ? `${nextNum}${parsed.delim}` : parsed.marker;
      if (isModified || newMarker !== parsed.marker) {
        const prefixStart = line.from + parsed.quotePrefix.length;
        const prefixEnd = prefixStart + parsed.indent.length + parsed.marker.length;
        lineChanges.set(n, {
          from: prefixStart,
          to: prefixEnd,
          insert: indent + newMarker,
        });
      }
    }
  }

  const changes = [...lineChanges.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, change]) => change);

  if (!changes.length) return true;
  view.dispatch({ changes, userEvent: 'input.indent' });
  return true;
}

/**
 * 代码块内 Tab / Shift+Tab 走软空格缩进（默认 2 空格，可配 4 空格）。
 */
export function indentCodeBlock(view, dir, indentWidth = DEFAULT_INDENT_WIDTH, isCodeBlock) {
  const { state } = view;
  const ranges = state.selection.ranges;
  const allInCode = ranges.every(
    (r) => isInsideCodeBlock(state, r.from, isCodeBlock) && isInsideCodeBlock(state, r.to, isCodeBlock)
  );
  if (!allInCode) return false;

  const unit = ' '.repeat(indentWidth);

  if (dir > 0) {
    if (ranges.length === 1 && ranges[0].empty) {
      const pos = ranges[0].from;
      view.dispatch({
        changes: { from: pos, insert: unit },
        selection: { anchor: pos + unit.length },
        userEvent: 'input.indent',
      });
      return true;
    }

    const lineNos = [];
    for (const r of ranges) {
      const a = state.doc.lineAt(r.from).number;
      const b = state.doc.lineAt(r.to).number;
      for (let n = a; n <= b; n++) {
        if (!lineNos.includes(n)) lineNos.push(n);
      }
    }
    const changes = lineNos.map((n) => ({ from: state.doc.line(n).from, insert: unit }));
    view.dispatch({ changes, userEvent: 'input.indent' });
    return true;
  }

  // dir < 0: Shift+Tab 反缩进
  const lineNos = [];
  for (const r of ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) {
      if (!lineNos.includes(n)) lineNos.push(n);
    }
  }
  const changes = [];
  for (const n of lineNos) {
    const line = state.doc.line(n);
    const lead = /^[ \t]*/.exec(line.text)[0];
    const cut = outdentLength(lead, indentWidth);
    if (cut > 0) changes.push({ from: line.from, to: line.from + cut, insert: '' });
  }
  if (changes.length) {
    view.dispatch({ changes, userEvent: 'input.indent' });
  }
  return true;
}

/**
 * Tab 跳出行内配对闭合符号（`**`、`*`、`` ` ``、`)`、`]`、`}`、`$`、`$$`、`__`、`~~`、`"` 等）。
 * 仅在非代码块、无选区，且同行光标前存在对应开符号时触发。
 */
export function tabOutOfPair(view, isCodeBlock) {
  const { state } = view;
  if (state.selection.ranges.length !== 1) return false;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  if (isInsideCodeBlock(state, sel.head, isCodeBlock)) return false;

  const line = state.doc.lineAt(sel.head);
  const offset = sel.head - line.from;
  const before = line.text.slice(0, offset);
  const after = line.text.slice(offset);
  if (!after || !before) return false;

  let jump = 0;

  // 1. 反引号：支持多反引号行内代码（``code``）与单反引号（`code`）
  if (after[0] === '`') {
    const tickRun = /^`+/.exec(after)[0];
    if (before.includes(tickRun) && !/\s$/.test(before)) {
      jump = tickRun.length;
    }
  }

  // 2. 多字符对称闭合符（***、**、__、~~、$$、==）
  if (!jump) {
    for (const token of MULTI_CLOSERS) {
      if (after.startsWith(token)) {
        if (before.includes(token) && !/\s$/.test(before)) {
          jump = token.length;
        }
        break;
      }
    }
  }

  // 3. 非对称右括号（)、]、}）
  if (!jump && ASYM_CLOSERS[after[0]]) {
    const opener = ASYM_CLOSERS[after[0]];
    if (before.includes(opener)) {
      jump = 1;
    }
  }

  // 4. 单字符对称闭合符（*、_、~、"、$）
  if (!jump && SINGLE_SYM_CLOSERS.has(after[0])) {
    const ch = after[0];
    if (before.includes(ch) && !/\s$/.test(before)) {
      jump = 1;
    }
  }

  if (!jump) return false;
  view.dispatch({
    selection: { anchor: sel.head + jump },
    userEvent: 'select',
  });
  return true;
}

/**
 * 统一 Tab 调度：
 * 1. 代码块内 → 插入软空格 / 多行缩进
 * 2. 光标紧贴行内闭合符前 → 跳出闭合符
 * 3. 列表行（含引用内列表） → 降级缩进并重排有序编号
 * 4. 普通正文段落 → 消费 Tab，不插入硬 \t（避免触发 CommonMark 缩进代码块）
 */
export function handleTab(view, options = {}) {
  const { indentWidth = DEFAULT_INDENT_WIDTH, tabSize = DEFAULT_INDENT_WIDTH, isCodeBlock } = options;
  if (indentCodeBlock(view, 1, indentWidth, isCodeBlock)) return true;
  if (tabOutOfPair(view, isCodeBlock)) return true;
  if (indentList(view, 1, { tabSize, isCodeBlock })) return true;
  return true;
}

/**
 * 统一 Shift+Tab 调度：
 * 1. 代码块内 → 反缩进软空格
 * 2. 列表行（含引用内列表） → 升级反缩进并顺延有序编号
 * 3. 其他位置 → 消费按键，不让焦点跳出编辑器
 */
export function handleShiftTab(view, options = {}) {
  const { indentWidth = DEFAULT_INDENT_WIDTH, tabSize = DEFAULT_INDENT_WIDTH, isCodeBlock } = options;
  if (indentCodeBlock(view, -1, indentWidth, isCodeBlock)) return true;
  if (indentList(view, -1, { tabSize, isCodeBlock })) return true;
  return true;
}

/**
 * 代码块内括号中间按 Enter 自动展开缩进：
 * `{|}` / `(|)` / `[|]` → 换行并多缩进一级，右括号落到下一行并与当前行缩进对齐。
 */
export function codeBlockEnter(view, indentWidth = DEFAULT_INDENT_WIDTH, isCodeBlock) {
  const { state } = view;
  const sel = state.selection.main;
  if (state.selection.ranges.length !== 1) return false;
  if (!isInsideCodeBlock(state, sel.from, isCodeBlock)) return false;
  if (!sel.empty && !isInsideCodeBlock(state, sel.to, isCodeBlock)) return false;

  const startLine = state.doc.lineAt(sel.from);
  const endLine = sel.empty ? startLine : state.doc.lineAt(sel.to);
  if (startLine.number !== endLine.number) return false;
  if (sel.from <= startLine.from || sel.to >= startLine.to) return false;

  const left = state.doc.sliceString(sel.from - 1, sel.from);
  const right = state.doc.sliceString(sel.to, sel.to + 1);
  if (BRACKET_PAIRS[left] !== right) return false;

  const baseIndent = /^[ \t]*/.exec(startLine.text)[0];
  const unit = ' '.repeat(indentWidth);
  const insert = '\n' + baseIndent + unit + '\n' + baseIndent;
  const anchor = sel.from + 1 + baseIndent.length + unit.length;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor },
    userEvent: 'input',
  });
  return true;
}

/**
 * 回车延续列表：
 * - 有选区时先删除选区再续下一项标记
 * - 嵌套空列表按 Enter 逐级退缩进（`    - ` → `  - ` → `- ` → 退出列表）
 * - 退缩进时有序列表自动顺延父级序号
 */
export function continueList(view, options = {}) {
  const { tabSize = DEFAULT_INDENT_WIDTH, isCodeBlock } = options;
  const { state } = view;
  const sel = state.selection.main;
  if (state.selection.ranges.length !== 1) return false;
  if (isInsideCodeBlock(state, sel.from, isCodeBlock)) return false;

  const line = state.doc.lineAt(sel.from);
  const parsed = parseListLine(line.text);
  if (!parsed || parsed.quotePrefix) return false;
  if (sel.from < line.from + parsed.prefixLen) return false;

  // 有选区：删掉选区并续下一项
  if (!sel.empty) {
    const insert = '\n' + buildNextListPrefix(parsed);
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert },
      selection: { anchor: sel.from + insert.length },
      userEvent: 'input',
    });
    return true;
  }

  // 空列表项：有缩进先退一级，顶层才退出列表
  if (!parsed.content.trim()) {
    if (parsed.indent.length > 0) {
      const cut = outdentLength(parsed.indent, tabSize);
      const newIndent = parsed.indent.slice(cut);
      let newMarker = parsed.marker;
      if (parsed.isOrdered) {
        const nextNum = findOrderedStartForLevel(
          state.doc,
          line.number,
          '',
          indentColumns(newIndent, tabSize),
          tabSize
        );
        newMarker = `${nextNum}${parsed.delim}`;
      }
      const nextPrefix = newIndent + newMarker + ' ' + parsed.task;
      view.dispatch({
        changes: { from: line.from, to: line.from + parsed.prefixLen, insert: nextPrefix },
        selection: { anchor: line.from + nextPrefix.length },
        userEvent: 'input',
      });
      return true;
    }

    view.dispatch({
      changes: { from: line.from, to: line.from + parsed.prefixLen, insert: '' },
      selection: { anchor: line.from },
      userEvent: 'input',
    });
    return true;
  }

  const insert = '\n' + buildNextListPrefix(parsed);
  view.dispatch({
    changes: { from: sel.from, insert },
    selection: { anchor: sel.from + insert.length },
    userEvent: 'input',
  });
  return true;
}

/**
 * 引用块里回车续 `>`（含引用内列表）：
 * - 有选区时先删除选区再续标记
 * - 嵌套空引用（`> > `）按 Enter 逐级退一层（`> > ` → `> ` → 退出引用）
 * - 引用内空列表（`>   - ` → `> - ` → `> `）同样逐级退出
 */
export function continueQuote(view, options = {}) {
  const { tabSize = DEFAULT_INDENT_WIDTH, isCodeBlock } = options;
  const { state } = view;
  const sel = state.selection.main;
  if (state.selection.ranges.length !== 1) return false;
  if (isInsideCodeBlock(state, sel.from, isCodeBlock)) return false;

  const line = state.doc.lineAt(sel.from);
  const m = QUOTE_LINE_RE.exec(line.text);
  if (!m) return false;
  const quotePrefix = m[1];
  const rest = m[2];
  if (sel.from < line.from + quotePrefix.length) return false;

  const innerList = parseListLine(rest);
  const inInnerListContent =
    !!innerList && sel.from >= line.from + quotePrefix.length + innerList.prefixLen;

  // 有选区：删掉选区再续标记
  if (!sel.empty) {
    const insert = '\n' + quotePrefix + (inInnerListContent ? buildNextListPrefix(innerList) : '');
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert },
      selection: { anchor: sel.from + insert.length },
      userEvent: 'input',
    });
    return true;
  }

  // 纯空引用行（如 `> > ` 或 `> `）：逐级退一层
  if (!rest.trim()) {
    const stripped = quotePrefix.replace(/>[ \t]?(?!.*>)/, '');
    if (stripped.includes('>')) {
      const nextQuote = /[ \t]$/.test(stripped) ? stripped : stripped + ' ';
      view.dispatch({
        changes: { from: line.from, to: line.from + quotePrefix.length, insert: nextQuote },
        selection: { anchor: line.from + nextQuote.length },
        userEvent: 'input',
      });
      return true;
    }
    view.dispatch({
      changes: { from: line.from, to: line.from + quotePrefix.length, insert: '' },
      selection: { anchor: line.from },
      userEvent: 'input',
    });
    return true;
  }

  // 引用内空列表项（如 `>   - ` 或 `> - `）：先退列表缩进，再退列表保留引用
  if (inInnerListContent && !innerList.content.trim()) {
    const listStart = line.from + quotePrefix.length;
    if (innerList.indent.length > 0) {
      const cut = outdentLength(innerList.indent, tabSize);
      const newIndent = innerList.indent.slice(cut);
      let newMarker = innerList.marker;
      if (innerList.isOrdered) {
        const nextNum = findOrderedStartForLevel(
          state.doc,
          line.number,
          normalizeQuoteKey(quotePrefix),
          indentColumns(newIndent, tabSize),
          tabSize
        );
        newMarker = `${nextNum}${innerList.delim}`;
      }
      const nextListPrefix = newIndent + newMarker + ' ' + innerList.task;
      view.dispatch({
        changes: { from: listStart, to: listStart + innerList.prefixLen, insert: nextListPrefix },
        selection: { anchor: listStart + nextListPrefix.length },
        userEvent: 'input',
      });
      return true;
    }

    view.dispatch({
      changes: { from: listStart, to: listStart + innerList.prefixLen, insert: '' },
      selection: { anchor: listStart },
      userEvent: 'input',
    });
    return true;
  }

  const insert = '\n' + quotePrefix + (inInnerListContent ? buildNextListPrefix(innerList) : '');
  view.dispatch({
    changes: { from: sel.from, insert },
    selection: { anchor: sel.from + insert.length },
    userEvent: 'input',
  });
  return true;
}

/**
 * Shift+Enter 软换行：
 * - 列表项内：换行并自动对齐列表缩进（如 `- 第一行\n  第二行`、`1. 第一行\n   第二行`、`> - 第一行\n>   第二行`）
 * - 引用块内：保留引用前缀（含续行缩进）
 * - 普通正文/代码块：保持当前行前导缩进换行
 */
export function softNewline(view, options = {}) {
  const { isCodeBlock } = options;
  const { state } = view;
  const sel = state.selection.main;
  if (state.selection.ranges.length !== 1) return false;

  const line = state.doc.lineAt(sel.from);
  let contPrefix = '';

  if (isInsideCodeBlock(state, sel.from, isCodeBlock)) {
    contPrefix = /^[ \t]*/.exec(line.text)[0];
  } else {
    const parsed = parseListLine(line.text);
    if (parsed && sel.from >= line.from + parsed.prefixLen) {
      const markerWidth = parsed.marker.length + parsed.space.length;
      contPrefix = parsed.quotePrefix + parsed.indent + ' '.repeat(markerWidth);
    } else {
      const qm = QUOTE_LINE_RE.exec(line.text);
      if (qm && sel.from >= line.from + qm[1].length) {
        const innerLead = /^[ \t]*/.exec(qm[2])[0];
        contPrefix = qm[1] + innerLead;
      } else {
        contPrefix = /^[ \t]*/.exec(line.text)[0];
      }
    }
  }

  const insert = '\n' + contPrefix;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor: sel.from + insert.length },
    userEvent: 'input',
  });
  return true;
}

/**
 * 代码块内纯空白行首 Backspace 整步回删（按缩进宽度对齐到上一个 tab stop）。
 */
export function outdentSoftTabOnBackspace(view, indentWidth = DEFAULT_INDENT_WIDTH, isCodeBlock) {
  const { state } = view;
  if (state.selection.ranges.length !== 1) return false;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  if (!isInsideCodeBlock(state, sel.head, isCodeBlock)) return false;

  const line = state.doc.lineAt(sel.head);
  const before = line.text.slice(0, sel.head - line.from);
  if (!before.length || !/^[ ]+$/.test(before)) return false;

  const rem = before.length % indentWidth;
  const del = rem === 0 ? indentWidth : rem;
  view.dispatch({
    changes: { from: sel.head - del, to: sel.head, insert: '' },
    selection: { anchor: sel.head - del },
    userEvent: 'delete.backward',
  });
  return true;
}

/**
 * 判断选区是否有任意光标严格落在 `[open, close)` 内部（不含两端边界）。
 * 用于防止实时预览在用户正在编辑 `[ |]` 内部时过早替换为 TaskWidget 而困住光标。
 */
export function isCursorStrictlyInside(ranges, open, close) {
  if (!Array.isArray(ranges)) return false;
  return ranges.some((r) => r.from > open && r.to < close);
}

/**
 * 任务列表快捷输入容错：
 * 1. 在列表项（含引用内列表）后敲 `[] `（漏敲中间空格）时，自动规范化为 `[ ] `；
 * 2. 在 `- [ |]` / `- [x|]` / `- [X|]`（光标紧贴自动补全的 `]` 前）再敲空格时，
 *    直接跳出 `]` 并在外侧补空格（`- [ ] |` / `- [x] |`），避免连续空格写进括号内破坏格式。
 */
export function normalizeEmptyTaskListInput(view, from, to, text, isCodeBlock) {
  if (text !== ' ' || from !== to) return false;
  const { state } = view;
  if (isInsideCodeBlock(state, from, isCodeBlock)) return false;
  const line = state.doc.lineAt(from);
  const lineHead = state.doc.sliceString(line.from, from);
  const nextChar = from < line.to ? state.doc.sliceString(from, from + 1) : '';

  if (nextChar === ']' && TASK_INNER_BEFORE_SPACE_RE.test(lineHead)) {
    const afterClose = from + 1 < line.to ? state.doc.sliceString(from + 1, from + 2) : '';
    if (afterClose === ' ') {
      view.dispatch({
        selection: { anchor: from + 2 },
        userEvent: 'input.type',
      });
    } else {
      view.dispatch({
        changes: { from: from + 1, to: from + 1, insert: ' ' },
        selection: { anchor: from + 2 },
        userEvent: 'input.type',
      });
    }
    return true;
  }

  if (!EMPTY_TASK_BEFORE_SPACE_RE.test(lineHead)) return false;

  view.dispatch({
    changes: { from: from - 2, to: from, insert: '[ ] ' },
    selection: { anchor: from + 2 },
    userEvent: 'input.type',
  });
  return true;
}
