/**
 * 自动配对（对齐 Typora 的 auto pair）。
 *
 * 四条规则，都只在「真的在打 markdown 正文」时才生效：
 *   1. 有选区 + 输入左符 → 把选区包起来（`abc` 选中后敲 `(` 得 `(abc)`）
 *   2. 单字符配对：`(` `[` `{` `"` 补右符，光标落在中间
 *   3. 强调符连按两下才配对：`*` → `**|**`、`_` → `__|__`、`~` → `~~|~~`
 *   4. 收尾符「跳过」：光标后面正好是同一个字符时不重复插入，只把光标移过去
 *   5. 反引号例外：行首（前面全是空白）不配对，让位给「``` + 回车生成代码块」
 *
 * 代码块里一律不配对 —— `if (a` 补成 `if (a)` 是编辑器在改代码，不是帮人。
 *
 * 为什么不直接用 @codemirror/autocomplete 的 closeBrackets()：
 * 它的配对表是 `()[]{}''""`，既没有 markdown 的强调符，也不会在 `` ` `` 和
 * 「行首围栏」之间做取舍；而这对一个 markdown 编辑器恰恰是最要紧的两件事。
 */
import { EditorView } from '@codemirror/view';
import { EditorSelection, EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { getCodeFences } from './code-fences.js';
import { sourceModeField } from './live-preview.js';

/** 单字符配对：输入左边自动补右边 */
const SINGLE = { '(': ')', '[': ']', '{': '}', '`': '`', '"': '"' };
/** 强调符：连按两下才成对 */
const EMPH = new Set(['*', '_', '~']);
/** 可以「跳过」的收尾字符 */
const CLOSERS = new Set([')', ']', '}', '`', '"', '*', '_', '~']);
/** 左引号允许出现的位置：行首、空白之后、或紧跟一个开括号 */
const QUOTE_OK = /(^|[\s([{，。：；！？、])$/;

/** 光标前一个字符（没有就返回空串） */
const before = (state, pos) => (pos <= 0 ? '' : state.doc.sliceString(pos - 1, pos));
/** 光标后一个字符 */
const after = (state, pos) => (pos >= state.doc.length ? '' : state.doc.sliceString(pos, pos + 1));

/** 光标是否落在围栏 / 缩进代码块里 */
function inBlockCode(state, pos) {
  for (let n = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (n.name === 'FencedCode' || n.name === 'CodeBlock') return true;
  }
  return false;
}

/**
 * 输入处理。返回 true 表示这次输入被接管了。
 * 签名与 EditorView.inputHandler 一致，单独导出是为了自检能直接调（不必伪造按键事件）。
 */
export function handleInput(view, from, to, text) {
  const state = view.state;
  // 只处理单字符；粘贴多字符、IME 上屏都不归这里管
  if (text.length !== 1) return false;
  const ch = text;
  const hasSel = from !== to;

  /* 1. 选区 + 左符 → 包裹 */
  if (hasSel) {
    const right = SINGLE[ch] || (EMPH.has(ch) ? ch : null);
    if (!right) return false;
    if (inBlockCode(state, from)) return false;
    const inner = state.doc.sliceString(from, to);
    const insert = ch + inner + right;
    view.dispatch({
      changes: { from, to, insert },
      // 包完之后仍然选中原来那段文字，接着敲就能继续替换
      selection: { anchor: from + 1, head: from + 1 + inner.length },
      userEvent: 'input.type',
    });
    return true;
  }

  const prev = before(state, from);
  const next = after(state, from);
  const line = state.doc.lineAt(from);
  const lineStart = line.from;
  const lineHead = state.doc.sliceString(lineStart, from);
  const code = inBlockCode(state, from);

  /* 2. 收尾符跳过：后面已经是它了，光标移过去就行。
     代码块里不做 —— 那里 `a))` 中间的 `)` 是内容，不是自动补出来的那一半。 */
  if (!code && CLOSERS.has(ch) && next === ch) {
    view.dispatch({ selection: { anchor: from + 1 }, userEvent: 'input.type' });
    return true;
  }

  if (code) return false;

  /* 3. 单字符配对 */
  if (SINGLE[ch]) {
    if (prev === '\\') return false; // 转义字符，别管
    if (ch === '`') {
      // 行首的 ``` 是围栏，不是行内代码；配对了反而打不出代码块
      if (!lineHead.trim()) return false;
      if (prev === '`') return false;
    }
    if (ch === '"' && !QUOTE_OK.test(prev)) return false;
    view.dispatch({
      changes: { from, insert: ch + SINGLE[ch] },
      selection: { anchor: from + 1 },
      userEvent: 'input.type',
    });
    return true;
  }

  /* 4. 强调符：连按两下成对 */
  if (EMPH.has(ch) && prev === ch) {
    const prev2 = before(state, from - 1);
    if (prev2 === ch) return false; // `***` 这种已经在第三下了，别再补
    // 下划线夹在单词里是标识符（snake_case），不是强调
    if (ch === '_' && /[\w\u4e00-\u9fff]/.test(prev2)) return false;
    view.dispatch({
      changes: { from, insert: ch + ch + ch },
      selection: { anchor: from + 1 },
      userEvent: 'input.type',
    });
    return true;
  }

  return false;
}

export const autoPair = EditorView.inputHandler.of(handleInput);

/**
 * 空代码块里再按一次 Backspace / Delete：连同首尾围栏一起删除。
 * 正文一个字都没有时只删内容会留下两条看不见的围栏，后续 Markdown 很容易被它们吞进去。
 */
export function deleteEmptyFence(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;

  const block = getCodeFences(state).find((b) => {
    if (sel.from < b.codeFrom || sel.from > b.codeTo) return false;
    return !state.doc.sliceString(b.codeFrom, b.codeTo).trim();
  });
  if (!block) return false;

  let from = block.from;
  let to = block.to;
  if (block.close && to < state.doc.length) {
    // 连同尾围栏后的换行一起删，后面的代码块/正文自然顶上来。
    to++;
  } else if (from > 0 && state.doc.sliceString(from - 1, from) === '\n') {
    // 文档末尾没有下一行可借时，去掉首围栏前的那一个换行，避免留下多余空行。
    from--;
  }

  view.dispatch({
    changes: { from, to },
    selection: { anchor: from },
    userEvent: 'delete.fence',
  });
  return true;
}

/**
 * 实时预览里，已生成代码块的围栏不是普通文本，不能被退格一格一格啃掉。
 * 返回 true 表示这次删除已被拦截；正在输入、尚未闭合的首围栏仍可正常修改。
 */
function protectFenceDeletion(view, forward, startState) {
  const { state } = view;
  const blocks = getCodeFences(startState || state);
  // 事务保护把 startState 传进来时，选区要读它，不要读可能已经滚走的当前 state。
  const selection = startState ? startState.selection : state.selection;

  const protectedLine = (lineNo) => blocks.some((b) => {
    const openProtected = (b.close || b.implicit) && b.open.line.number === lineNo;
    const closeProtected = b.close && b.close.line.number === lineNo;
    return openProtected || closeProtected;
  });
  // 位置而不是行号：合并掉一个换行后，同一行号会落到另一行上。
  const atFence = (pos) => blocks.some((b) => {
    if (!(b.close || b.implicit)) return false;
    if (pos >= b.open.line.from && pos <= b.open.line.to) return true;
    return !!(b.close && pos >= b.close.line.from && pos <= b.close.line.to);
  });

  for (const range of selection.ranges) {
    if (range.empty) {
      const head = range.head;
      const fenceAt = (pos) => blocks.some((b) => {
        if (!(b.close || b.implicit)) return false;
        if (pos >= b.open.line.from && pos <= b.open.line.to) return true;
        return !!(b.close && pos >= b.close.line.from && pos <= b.close.line.to);
      });
      // 退格先看目标字符：
      //   - 目标是换行，放行（刚把围栏后的空行并掉）；
      //   - 目标/光标在围栏行里，都拦下，不能啃围栏字符；
      //   - 光标在代码首行行首退格会并入语言标识，末行行尾 Delete 会并入尾围栏。
      if (!forward && head > 0) {
        const target = head - 1;
        if (target >= 0 && target <= state.doc.length) {
          const char = state.doc.sliceString(target, target + 1);
          if (char !== '\n' && char !== '\r' && atFence(target)) return true;
        }
      }
      if (!forward && atFence(head)) return true;
      if (forward && atFence(head)) return true;
      if (!forward && blocks.some((b) => (b.close || b.implicit) && head === b.codeFrom)) return true;
      if (forward && blocks.some((b) => b.close && head === b.codeTo)) return true;
      continue;
    }

    // 选区可以整块删除，但不允许只删掉某一条围栏、把后面的代码块串联起来。
    for (const block of blocks) {
      if (!(block.close || block.implicit)) continue;
      const coversWholeBlock = range.from <= block.from && range.to >= block.to;
      if (coversWholeBlock) continue;
      const touchesOpen = range.from <= block.open.line.to && range.to >= block.open.line.from;
      const touchesClose = block.close && range.from <= block.close.line.to && range.to >= block.close.line.from;
      if (touchesOpen || touchesClose) return true;
    }
  }
  return false;
}

export function protectFenceBackspace(view) {
  return protectFenceDeletion(view, false);
}

export function protectFenceDelete(view) {
  return protectFenceDeletion(view, true);
}

/**
 * 光标紧贴在列表标记后面时，Backspace 直接拆掉这一级列表。
 * 有缩进先退一级；顶层则把「2. 」「- 」「- [ ] 」整段删掉。
 * 正文还在标记前面时不拦截，交给普通删除。
 */
const HEADING_MARK = /^(#{1,6})([ \t]+)/;

function dropEmptyHeading(state, line) {
  const from = line.number > 1 ? line.from - 1 : line.from;
  const to = line.number < state.doc.lines ? line.to + 1 : line.to;
  return { from, to, anchor: from };
}

/**
 * 空标题整行只有 #。光标停在标记上时，普通退格删的是上一行的换行，标题还在。
 * 这里一次把空标题整行去掉。光标在标题文字开头时，退格降一级。
 */
export function exitHeadingOnBackspace(view) {
  const { state } = view;
  if (state.field(sourceModeField, false)) return false;
  if (state.selection.ranges.some((r) => !r.empty)) return false;
  const changes = [];
  let anchor = null;
  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.head);
    const matched = HEADING_MARK.exec(line.text);
    if (!matched) return false;
    const markEnd = line.from + matched[0].length;
    if (range.head > markEnd) return false;
    const rest = line.text.slice(matched[0].length);
    if (!rest.trim()) {
      const drop = dropEmptyHeading(state, line);
      changes.push({ from: drop.from, to: drop.to, insert: '' });
      anchor = drop.anchor;
    } else {
      const next = matched[1].length <= 1 ? '' : '#'.repeat(matched[1].length - 1) + ' ';
      changes.push({ from: line.from, to: markEnd, insert: next });
      anchor = line.from + next.length;
    }
  }
  if (!changes.length) return false;
  view.dispatch({
    changes,
    selection: { anchor: anchor ?? changes[0].from },
    userEvent: 'delete',
  });
  return true;
}

/** 光标在空标题上，或紧贴在下一行空标题前面时，Delete 同样删掉这一级标题。 */
export function exitHeadingOnDelete(view) {
  const { state } = view;
  if (state.field(sourceModeField, false)) return false;
  if (state.selection.ranges.some((r) => !r.empty)) return false;
  const changes = [];
  let anchor = null;
  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.head);
    const matched = HEADING_MARK.exec(line.text);
    if (matched && !line.text.slice(matched[0].length).trim()) {
      const drop = dropEmptyHeading(state, line);
      changes.push({ from: drop.from, to: drop.to, insert: '' });
      anchor = drop.anchor;
      continue;
    }
    if (range.head !== line.to || line.number >= state.doc.lines) return false;
    const next = state.doc.line(line.number + 1);
    const nextMark = HEADING_MARK.exec(next.text);
    if (!nextMark || next.text.slice(nextMark[0].length).trim()) return false;
    const drop = dropEmptyHeading(state, next);
    changes.push({ from: drop.from, to: drop.to, insert: '' });
    anchor = line.to;
  }
  if (!changes.length) return false;
  view.dispatch({
    changes,
    selection: { anchor: anchor ?? changes[0].from },
    userEvent: 'delete',
  });
  return true;
}

const QUOTE_PREFIX = /^([ \t]{0,3}(?:>[ \t]?)+)/;

/**
 * 引用行里的 Backspace：
 * 1. 这一行只剩 `> ` 没有正文时，一次把整行删掉，而不是一路退格留一个光秃秃的 `>`；
 * 2. 光标贴在正文开头时，退掉一级引用（嵌套引用只退最内一层），正文本身不动。
 * 其它位置交给普通删除。
 */
export function exitQuoteOnBackspace(view) {
  const { state } = view;
  if (state.field(sourceModeField, false)) return false;
  if (state.selection.ranges.some((r) => !r.empty)) return false;
  const changes = [];
  let anchor = null;
  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.head);
    const matched = QUOTE_PREFIX.exec(line.text);
    if (!matched) return false;
    const contentFrom = line.from + matched[1].length;
    const rest = line.text.slice(matched[1].length);

    if (!rest.trim()) {
      // 空引用行：直接删掉 `> ` 与上一行末尾的换行，上下文仍各自独立，光标稳稳回到上一行末尾；
      // 仅当在第一行时才清掉本行 `> ` 留在行首。
      let from;
      let to;
      if (line.number > 1) {
        from = line.from - 1;
        to = line.to;
      } else {
        from = line.from;
        to = line.to;
      }
      changes.push({ from, to, insert: '' });
      anchor = from;
      continue;
    }

    if (range.head !== contentFrom) return false;
    // 只去掉最内一层 >；已经是顶层时整段前缀消失，这一行退回普通段落
    const stripped = matched[1].replace(/>[ \t]?(?!.*>)/, '');
    const insert = stripped.includes('>') ? stripped : '';
    changes.push({ from: line.from, to: contentFrom, insert });
    anchor = line.from + insert.length;
  }
  if (!changes.length) return false;
  view.dispatch({ changes, selection: { anchor: anchor ?? 0 }, userEvent: 'delete' });
  return true;
}

export function exitListOnBackspace(view) {
  const { state } = view;
  if (state.selection.ranges.some((r) => !r.empty)) return false;
  const changes = [];
  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.head);
    const before = line.text.slice(0, range.head - line.from);
    // 引用里的列表先保留 > 前缀，再按普通列表处理缩进和标记。
    // 例如 `> 1. |` 退格后应是 `> |`，而不是无法退出列表或连引用一起删掉。
    const matched = /^([ \t]{0,3}(?:>[ \t]?)+)?([ \t]*)((?:[-*+]|\d+[.)])(?:\s+\[[ xX]\])?[ \t]*)$/.exec(before);
    if (!matched) return false;
    const prefix = matched[1] || '';
    const indent = matched[2];
    if (indent.length > 0) {
      const removeLen = indent.endsWith('\t') ? 1 : Math.min(indent.length, 2);
      const indentFrom = line.from + prefix.length;
      changes.push({ from: indentFrom, to: indentFrom + removeLen, insert: '' });
    } else {
      changes.push({ from: line.from + prefix.length, to: range.head, insert: '' });
    }
  }
  if (!changes.length) return false;
  view.dispatch({ changes });
  return true;
}

/**
 * 光标在代码块里时，Ctrl+A 先选中这块代码，不把整篇文档一起选上。
 * 代码已经全选时返回 false，下一次 Ctrl+A 才交给编辑器去选全文。
 */
export function selectCodeBlock(view) {
  const blocks = getCodeFences(view.state);
  let block = null;
  for (const range of view.state.selection.ranges) {
    const found = blocks.find((item) => item.close && range.head >= item.from && range.head <= item.to);
    if (!found) return false;
    if (block && (block.from !== found.from || block.to !== found.to)) return false;
    block = found;
  }
  if (!block) return false;
  const from = block.codeFrom;
  const to = Math.max(block.codeFrom, block.codeTo);
  if (to <= from) return false;
  const only = view.state.selection.ranges.length === 1 ? view.state.selection.main : null;
  if (only && only.from === from && only.to === to) return false;
  view.dispatch({
    selection: EditorSelection.single(from, to),
    userEvent: 'select',
  });
  return true;
}

/**
 * 实时预览的围栏行高度为 0。方向键如果仍按源码逐行移动，会落进不可见围栏，
 * 看起来就像光标被代码块困住。这里在正文边界直接跳到前/后一个可见文本行。
 */
export function navigateFence(view, direction) {
  const { state } = view;
  if (state.field(sourceModeField, false)) return false;
  const sel = state.selection.main;
  if (!sel.empty) return false;

  const doc = state.doc;
  const line = doc.lineAt(sel.head);
  for (const block of getCodeFences(state)) {
    if (!block.close) continue;
    const firstBodyLine = block.open.line.number + 1;
    const lastBodyLine = block.close.line.number - 1;
    const beforeBlock = () => (block.open.line.number > 1 ? doc.line(block.open.line.number - 1).to : null);
    const afterBlock = () => (block.close.line.to < doc.length ? block.close.line.to + 1 : null);

    let target = null;
    if (direction === 'left' && sel.head === block.codeFrom) target = beforeBlock();
    else if (direction === 'right' && sel.head === block.codeTo) target = afterBlock();
    else if (direction === 'up' && line.number === firstBodyLine) target = beforeBlock();
    else if (direction === 'down' && line.number === lastBodyLine) target = afterBlock();

    if (target != null) {
      view.dispatch({ selection: { anchor: target }, userEvent: 'select' });
      return true;
    }
  }
  return false;
}

/**
 * 最后一道保护：键盘、右键删除、cut、beforeinput、execCommand 最终都要经过事务。
 * 只拦截删除事件，语言菜单对 info 的替换和正常代码输入不受影响。
 */
/** 改动落在围栏行的字符上。行尾的换行不算，那是下一段的开头。 */
function hitsFenceLine(fromA, toA, lineFrom, lineTo) {
  if (fromA === toA) return fromA >= lineFrom && fromA <= lineTo;
  return fromA < lineTo && toA > lineFrom;
}

/** 光标不该停在已闭合围栏上：那一行删不掉，打字会把围栏拆开。 */
function snapOffFence(doc, blocks, pos) {
  for (const block of blocks) {
    if (!(block.close || block.implicit)) continue;
    const open = block.open.line;
    if (pos >= open.from && pos <= open.to) return block.codeFrom;
    if (!block.close) continue;
    const close = block.close.line;
    if (pos < close.from || pos > close.to) continue;
    if (block.codeTo < close.from) return block.codeTo;
    const after = close.to + 1;
    return after <= doc.length ? after : Math.max(0, close.from - 1);
  }
  return pos;
}

/**
 * 多选从哪边开始，就留在哪边。锚点是按下鼠标 / 开始 Shift 选的那一头。
 *
 * 从代码正文里开始：头不能拖出这块，行号和围栏也不算进选区。
 * 从外面的正文开始：选区可以穿过代码块，复制才能带上里面的代码。
 * 整块都在选区里面时不动，那样才能一次删掉代码块。
 */
function snapRange(doc, blocks, range) {
  let anchor = snapOffFence(doc, blocks, range.anchor);
  let head = snapOffFence(doc, blocks, range.head);
  for (const block of blocks) {
    if (!(block.close || block.implicit)) continue;
    const lo = block.codeFrom;
    const hi = Math.max(block.codeFrom, block.codeTo);
    const inCode = (pos) => pos >= lo && pos <= hi;
    if (!inCode(anchor) || inCode(head)) continue;
    head = head < lo ? lo : hi;
  }
  return EditorSelection.range(anchor, head);
}

function snapSelection(doc, blocks, selection) {
  let changed = false;
  const ranges = selection.ranges.map((range) => {
    const next = snapRange(doc, blocks, range);
    if (next.anchor !== range.anchor || next.head !== range.head) changed = true;
    return next;
  });
  if (!changed) return null;
  return EditorSelection.create(ranges, selection.mainIndex);
}

export const fenceDeletionGuard = EditorState.transactionFilter.of((tr) => {
  if (tr.isUserEvent('delete.fence')) return tr;
  if (tr.isUserEvent('undo') || tr.isUserEvent('redo')) return tr;
  if (tr.startState.field(sourceModeField, false)) return tr;

  const blocks = getCodeFences(tr.startState);

  // 删除先看光标：站在尾围栏行首时，只有「前面是换行」那一下能通过，
  // 键盘、右键删除、cut、beforeinput、execCommand 走的都是这里，行为才能一致。
  const deleted = tr.isUserEvent('delete') || tr.isUserEvent('delete.backward') || tr.isUserEvent('delete.forward');
  if (deleted) {
    const forward = tr.isUserEvent('delete.forward');
    const sel = tr.startState.selection.main;
    if (sel.empty) {
      const head = sel.head;
      const inFence = (pos) => blocks.some((b) => {
        if (!(b.close || b.implicit)) return false;
        if (pos >= b.open.line.from && pos <= b.open.line.to) return true;
        return !!(b.close && pos >= b.close.line.from && pos <= b.close.line.to);
      });
      if (inFence(head)) {
        const before = head - 1;
        if (!forward) {
          if (before >= 0 && tr.startState.doc.sliceString(before, head) === '\n') {
            // 尾围栏行首 + 前面是换行：放行（刚把围栏后的空行并掉）。
            // 首围栏行首同理——退格删的是那个换行，不是围栏字符。
            const onClose = blocks.some((b) => b.close && head >= b.close.line.from && head <= b.close.line.to);
            const onOpen = blocks.some((b) => (b.close || b.implicit) && head >= b.open.line.from && head <= b.open.line.to);
            if (!onClose && !onOpen) return [];
          } else {
            return [];
          }
        } else {
          return [];
        }
      }
    }
  }

  if (tr.docChanged) {
    let blocked = false;
    tr.changes.iterChanges((fromA, toA) => {
      if (blocked) return;
      // 打开文件、恢复欢迎页等整文档替换不是局部破坏围栏。
      if (fromA === 0 && toA === tr.startState.doc.length) return;
      for (const block of blocks) {
        if (!(block.close || block.implicit)) continue; // 正在输入的首围栏仍可编辑
        const markerRanges = [];
        for (const fence of [block.open, block.close]) {
          if (!fence || !fence.mark) continue;
          const offset = fence.line.text.indexOf(fence.mark);
          if (offset >= 0) {
            const from = fence.line.from + offset;
            markerRanges.push([from, from + fence.mark.length]);
          }
        }
        // 首围栏后的换行、尾围栏前的换行同样是结构边界，不能让正文与标识合并。
        if (block.open.line.to < tr.startState.doc.length) {
          markerRanges.push([block.open.line.to, block.open.line.to + 1]);
        }
        if (block.close && block.close.line.from > 0) {
          markerRanges.push([block.close.line.from - 1, block.close.line.from]);
        }
        // 语言菜单仍可改写 ``` 后面的 info。比较用半开区间，行尾正常打字不会误伤。
        if (markerRanges.some(([from, to]) => Math.max(fromA, from) < Math.min(toA, to))) {
          blocked = true;
          break;
        }
        // 尾围栏这一行不能改。围栏后面的换行属于下一段，退格要能删掉，否则贴在代码块下的文字删不掉。
        if (block.close && hitsFenceLine(fromA, toA, block.close.line.from, block.close.line.to)) {
          blocked = true;
          break;
        }
      }
    });
    if (blocked) {
      const snapped = snapSelection(tr.startState.doc, blocks, tr.startState.selection);
      return snapped ? { selection: snapped, userEvent: 'select' } : [];
    }
  }

  const doc = tr.newDoc;
  const mapped = blocks.map((block) => ({
    ...block,
    open: { ...block.open, line: { from: tr.changes.mapPos(block.open.line.from, 1), to: tr.changes.mapPos(block.open.line.to, -1) } },
    close: block.close
      ? { ...block.close, line: { from: tr.changes.mapPos(block.close.line.from, 1), to: tr.changes.mapPos(block.close.line.to, -1) } }
      : null,
    from: tr.changes.mapPos(block.from, 1),
    to: tr.changes.mapPos(block.to, -1),
    codeFrom: tr.changes.mapPos(block.codeFrom, 1),
    codeTo: tr.changes.mapPos(block.codeTo, -1),
  }));
  const snapped = snapSelection(doc, mapped, tr.newSelection);
  if (!snapped) return tr;
  return {
    changes: tr.changes,
    selection: snapped,
    effects: tr.effects,
    annotations: tr.annotations,
    scrollIntoView: tr.scrollIntoView,
    filter: false,
  };
});

/**
 * 删除配对标记后的落点：只有当删除后当前行完全为空时才回落到上一行末尾；
 * 行内还有其他正文时留在 fallback（当前位置），避免打断句中编辑。
 */
function pairDeleteAnchor(state, changes, pos, fallback) {
  const line = state.doc.lineAt(pos);
  if (line.number <= 1) return fallback;
  const tr = state.update({ changes });
  const mappedLine = tr.newDoc.lineAt(tr.changes.mapPos(pos, -1));
  if (mappedLine.text.trim().length > 0) return fallback;
  const prevEnd = state.doc.line(line.number - 1).to;
  return tr.changes.mapPos(prevEnd);
}

/**
 * Backspace 删除空配对：`(|)` 一下退掉两个括号。
 * 只认 SINGLE 里的单字符对，不做 `**` 这种多字符的（容易误伤整段）。
 */
export function deletePair(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty || sel.from === 0) return false;
  const left = state.doc.sliceString(sel.from - 1, sel.from);
  const right = state.doc.sliceString(sel.from, sel.from + 1);
  if (!SINGLE[left] || SINGLE[left] !== right) return false;
  const changes = { from: sel.from - 1, to: sel.from + 1 };
  view.dispatch({
    changes,
    selection: { anchor: pairDeleteAnchor(state, changes, sel.from, sel.from - 1) },
    userEvent: 'delete',
  });
  return true;
}

/**
 * Delete 与 Backspace 对称：光标在空配对 `(|)` 中间时，向前删除也整对删掉。
 * 否则只删右符会留下半个自动配对，剩下的左符又和后文重新配对，越删越乱。
 */
export function deletePairForward(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const left = state.doc.sliceString(sel.from - 1, sel.from);
  const right = state.doc.sliceString(sel.from, sel.from + 1);
  if (!SINGLE[left] || SINGLE[left] !== right) return false;
  const changes = { from: sel.from - 1, to: sel.from + 1 };
  view.dispatch({
    changes,
    selection: { anchor: pairDeleteAnchor(state, changes, sel.from, sel.from - 1) },
    userEvent: 'delete',
  });
  return true;
}

/* ---------------- 行内配对的成对删除（`code`、*em*、**strong**、~~del~~） ---------------- */

const INLINE_PAIR_NODES = new Set(['InlineCode', 'Emphasis', 'StrongEmphasis', 'Strikethrough']);

/** 节点边界标记的长度：反引号可能有多个（`` ``a`b`` ``），强调/删除线是固定符号数。 */
function inlineMarkLength(state, node) {
  if (node.name === 'InlineCode') {
    const m = /^`+/.exec(state.doc.sliceString(node.from, Math.min(node.from + 16, node.to)));
    return m ? m[0].length : 1;
  }
  return node.name === 'Emphasis' ? 1 : 2;
}

/**
 * 光标贴在一对行内标记的边界上时，删除把两侧标记一起去掉，正文保留。
 * 只删一侧的话，剩下的标记会和后文的同类符号重新配对（CommonMark 的正常解析），
 * 大段正文被吞成行内代码/强调，看起来就像「样式全乱了」。
 * forward=true 对应 Delete，否则是 Backspace；起始/结束标记的两侧都认。
 */
export function deleteInlinePair(view, forward) {
  const { state } = view;
  if (state.field(sourceModeField, false)) return false;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const pos = sel.head;
  let node = syntaxTree(state).resolveInner(pos, forward ? 1 : -1);
  while (node && !INLINE_PAIR_NODES.has(node.name)) node = node.parent;
  if (!node) return false;
  const mark = inlineMarkLength(state, node);
  if (node.to - node.from <= mark * 2) return false; // 空配对交给 deletePair / deletePairForward

  let anchor;
  if (forward) {
    if (pos === node.from) anchor = node.from; // 起始标记前
    else if (pos === node.to - mark) anchor = node.to - mark * 2; // 结束标记前
    else return false;
  } else {
    if (pos === node.to) anchor = node.to - mark * 2; // 结束标记后
    else if (pos === node.from + mark) anchor = node.from; // 起始标记后
    else return false;
  }

  const changes = [
    { from: node.from, to: node.from + mark },
    { from: node.to - mark, to: node.to },
  ];
  if (node.name === 'InlineCode') {
    // 有内容的行内代码删掉反引号后，光标留在当前内容后面，不跳到上一行
    anchor = node.to - mark * 2;
  } else {
    anchor = pairDeleteAnchor(state, changes, pos, anchor);
  }

  view.dispatch({
    changes,
    selection: { anchor },
    userEvent: 'delete',
  });
  return true;
}

/* ---------------- ``` + 回车 → 完整的代码块 ---------------- */

/** 一行里只有一个围栏（可带语言） */
const FENCE_ONLY = /^(\s{0,3})(`{3,}|~{3,})([A-Za-z0-9+#._-]*)[ \t]*$/;

/**
 * 打了 ``` 之后按回车，自动补出结尾围栏，光标停在中间那行。
 * 这正是 Typora 的手感：手不用离开键盘去补齐三个反引号。
 *
 * 只在「这一行就是块的开始」时动手：统一扫描器发现围栏从更早的行开始，
 * 说明光标在块内或者正踩在收尾围栏上，那就老老实实换行。
 */
export function fenceOnEnter(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.from);
  if (sel.from !== line.to) return false; // 只在行尾触发
  const m = FENCE_ONLY.exec(line.text);
  if (!m) return false;

  const blocks = getCodeFences(state);
  const ownBlock = blocks.find((block) => block.open.line.number === line.number);
  if (ownBlock && (ownBlock.close || ownBlock.implicit)) {
    // 已有正文前输入 ``` 时已经自动补了尾围栏；第一次回车只需进入空白正文行。
    if (ownBlock.close && !state.doc.sliceString(ownBlock.codeFrom, ownBlock.codeTo).trim()) {
      view.dispatch({ selection: { anchor: ownBlock.codeFrom } });
      return true;
    }
    return false; // 已生成的块不能重复补尾围栏
  }
  const belongsToEarlierBlock = blocks.some(
    (block) => block.open.line.from < line.from && sel.from <= block.to
  );
  if (belongsToEarlierBlock) return false;

  const insert = '\n\n' + m[1] + m[2];
  view.dispatch({
    changes: { from: sel.from, insert },
    selection: { anchor: sel.from + 1 },
    userEvent: 'input',
  });
  return true;
}
