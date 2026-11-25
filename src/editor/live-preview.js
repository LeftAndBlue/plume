import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import { StateEffect, StateField } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { buildOutline } from './outline.js';
import { getCodeFences, isFenceDraft } from './code-fences.js';
import { scanDetailsBlocks, scanStyledInlineHtml } from './extrasText.js';
import {
  footnoteDef,
  imageBraceAfter,
  parseImageAttrs,
  scanFrontMatter,
  scanInlineHtml,
  scanTables,
} from './rich-doc.js';
import { FootnoteDefWidget, FootnoteRefWidget, FrontMatterWidget, MermaidWidget } from './rich-widgets.js';
import {
  DetailsWidget,
  FenceChipWidget,
  FenceLangWidget,
  HrWidget,
  ImageWidget,
  editingImageField,
  setEditingImage,
  MathWidget,
  TableWidget,
  TaskWidget,
  TextWidget,
  TocWidget,
  currentDocBase,
} from './widgets.js';

/** 用于在非文档变更时强制重算装饰（例如切换专注模式） */
export const refreshDecorations = StateEffect.define();

/**
 * 源代码模式：把实时预览整个关掉，只留 markdown 语法高亮。
 * 做成 StateField 而不是 body class —— 装饰计算发生在 state 层，
 * 只有 state 变了才会重算，靠 DOM class 得手动 dispatch 一次，容易漏。
 */
export const setSourceMode = StateEffect.define();

export const sourceModeField = StateField.define({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setSourceMode)) return !!e.value;
    return value;
  },
});

const inSourceMode = (state) => !!state.field(sourceModeField, false)

const CODE_NODES = new Set(['InlineCode', 'FencedCode', 'CodeText', 'CodeBlock', 'CodeInfo']);

const referenceDefCache = new WeakMap();
function getReferenceDefs(doc) {
  let defs = referenceDefCache.get(doc);
  if (defs) return defs;
  defs = new Map();
  let fence = null;
  for (let n = 1; n <= doc.lines; n++) {
    const text = doc.line(n).text;
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(text);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const m = /^\s{0,3}\[([^\]^][^\]]*)\]:\s*(\S+)(?:\s+["'(](.*)["')])?\s*$/.exec(text);
    if (m) defs.set(m[1].toLowerCase(), { href: m[2].replace(/^<|>$/g, ''), title: m[3] || '' });
  }
  referenceDefCache.set(doc, defs);
  return defs;
}

/* ---------------- 公共工具 ---------------- */

function activeLineSet(state) {
  const doc = state.doc;
  const set = new Set();
  for (const r of state.selection.ranges) {
    const a = doc.lineAt(r.from).number;
    const b = doc.lineAt(Math.min(r.to, doc.length)).number;
    for (let n = a; n <= b; n++) set.add(n);
  }
  return set;
}

/** 空光标落在这一行。拖出的选区不算，避免整行加深和选区蓝叠在一起。 */
function caretOnLine(state, lineNo) {
  const line = state.doc.line(lineNo);
  for (const range of state.selection.ranges) {
    if (range.empty && range.head >= line.from && range.head <= line.to) return true;
  }
  return false;
}

/** 光标或选区是否贴到 [from, to]。行内标记只在这时展开，避免整行一起炸开。 */
function cursorTouchesRange(state, from, to) {
  for (const r of state.selection.ranges) {
    if (!r.empty) {
      if (r.from <= to + 1 && r.to >= from - 1) return true;
      continue;
    }
    const headLine = state.doc.lineAt(r.head);
    // 光标的贴近容差不能跨逻辑行：光标在下一空行时，上一行末尾的
    // `**` 不应重新显示，否则看起来像加粗没有生效。
    if (from >= headLine.from && to <= headLine.to && r.from <= to + 1 && r.to >= from - 1) return true;
  }
  return false;
}

function quoteDepth(text) {
  const m = /^[ \t]{0,3}((?:>[ \t]*)+)/.exec(text);
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) if (ch === '>') n++;
  return n;
}

/** 从当前行向上找最近的 `> [!NOTE]` 头，嵌套在同一段引用里的行都算进去。 */
function calloutInfo(doc, lineNo) {
  if (lineNo < 1 || lineNo > doc.lines || !quoteDepth(doc.line(lineNo).text)) return null;
  const limit = Math.max(1, lineNo - 60);
  for (let n = lineNo; n >= limit; n--) {
    const t = doc.line(n).text;
    if (!quoteDepth(t)) return null;
    const m = /^[ \t]{0,3}(?:>[ \t]*)+\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.exec(t);
    if (m) return { type: m[1].toLowerCase(), head: n === lineNo, label: m[1].toUpperCase() };
  }
  return null;
}

function eatSpace(doc, to, lineTo) {
  if (to < lineTo && /\s/.test(doc.sliceString(to, to + 1))) return to + 1;
  return to;
}

function parseDest(destRaw) {
  let inner = String(destRaw || '').trim();
  let title = '';
  const tm = /\s+"([^"]*)"\s*$/.exec(inner);
  if (tm) {
    title = tm[1];
    inner = inner.slice(0, tm.index).trim();
  }
  const src = inner.replace(/^</, '').replace(/>$/, '').trim();
  return { src, title };
}

/**
 * 有序列表的显示编号——按层级重排，不看源码里那个数字。
 *
 * Typora 就是这么干的：`1.` 复制十行贴进去，渲染出来仍是 1 2 3…；
 * 子项重新从 1 起数。我们的渲染器原来把源码里的数字原样画出来，
 * 于是「Tab 缩进一个子项」之后，子项顶着「4.」挂在那里，一眼就觉得坏掉了。
 *
 * 往上数同级兄弟，代价是 O(同列表长度)，比全文重排便宜得多，也不用缓存。
 */
function listLineInfo(text) {
  // 引用标记后最多吃掉一个空白；其余空白仍属于列表缩进。
  // 例如 `>    1. item` 去掉 `> ` 后还剩 3 个空格，不能被引用前缀一起吞掉。
  const quote = /^[ \t]{0,3}((?:>[ \t]?)+)/.exec(text);
  const contentStart = quote ? quote[0].length : 0;
  const m = /^([ \t]*)([-*+]|\d+[.)])(?:[ \t]|$)/.exec(text.slice(contentStart));
  if (!m) return null;
  let depth = 0;
  if (quote) for (const c of quote[1]) if (c === '>') depth++;
  let width = 0;
  for (const c of m[1]) width += c === '\t' ? 4 : 1;
  return { contentStart, depth, width, ordered: /^\d/.test(m[2]) };
}

function orderedNumber(doc, lineNo, width, depth = 0) {
  let n = 1;
  for (let k = lineNo - 1; k >= 1; k--) {
    const t = doc.line(k).text;
    if (!t.trim()) break; // 空行 = 列表断开（宽松写法另有实现，这里按严格列表算）
    const info = listLineInfo(t);
    if (!info) break; // 不是列表项：上一行是段落/标题/围栏，列表到此为止
    if (info.depth !== depth) break; // 引用内外、不同引用层级不能混成同一组编号
    if (info.width < width) break; // 撞到上一级 → 本列表从这一项开始
    if (info.width === width && info.ordered) n++; // 只数同级的数字项；子项与无序项不计
  }
  return n;
}

/* ---------------- 块级装饰（StateField：块装饰只能由 state 提供） ---------------- */

// 只有这些行需要随光标显形/收起。普通正文之间移动光标时，块级装饰完全不变，
// 不必把整篇文档重新扫一遍。缓存按不可变 Text 保存，文档一变自然失效。
const blockActivityCache = new WeakMap();
const largeDocNotified = new WeakSet();
const blockDebug = { computed: 0, reused: 0 };

export function blockDecorationStats() {
  return { ...blockDebug };
}

function blockActivityKey(state) {
  const sensitive = blockActivityCache.get(state.doc);
  if (!sensitive) return '*';
  const active = [];
  for (const line of activeLineSet(state)) if (sensitive.has(line)) active.push(line);
  return active.sort((a, b) => a - b).join(',');
}

function computeBlockDecos(state) {
  const doc = state.doc;
  blockDebug.computed++;
  const sensitive = new Set();
  blockActivityCache.set(doc, sensitive);
  // 源代码模式：不渲染任何块，原文就是所见
  if (inSourceMode(state)) return Decoration.none;
  // 块级扫描是全文级的：超大文档直接放弃块渲染，保证输入延迟并提示用户
  if (doc.length > 500000 || doc.lines > 12000) {
    if (!largeDocNotified.has(doc) && typeof document !== 'undefined') {
      largeDocNotified.add(doc);
      queueMicrotask(() => document.dispatchEvent(new CustomEvent('plume-large-doc-fallback')));
    }
    return Decoration.none;
  }
  const active = activeLineSet(state);
  const out = [];
  const codeByLine = new Map();
  for (const block of getCodeFences(state)) codeByLine.set(block.open.line.number, block);
  const tableByLine = new Map();
  for (const table of scanTables(doc)) tableByLine.set(table.startLine, table);

  const tocRe = /^\s{0,3}\[toc\]\s*$/i;
  // 目录条目和侧栏大纲共用一套标题解析，两处显示的层级/顺序才不会打架。
  // 全文扫描比逐行判断贵，所以等真遇到 [toc] 再算。
  let headingsCache = null;
  const headingList = () => (headingsCache || (headingsCache = buildOutline(state)));

  let i = 1;
  const frontMatter = scanFrontMatter(doc);
  while (i <= doc.lines) {
    const line = doc.line(i);
    const text = line.text;

    // 围栏代码块：内部不参与其它块级渲染，整段跳过。
    // 区间与行内装饰、复制、空块删除共用同一个扫描器，多个代码块不会各配各的对。
    const code = codeByLine.get(i);
    if (code && !isFenceDraft(code)) {
      const lang = (code.lang || '').trim().toLowerCase();
      const cursorIn = state.selection.ranges.some((r) => r.from <= code.to && r.to >= code.from);
      if (lang === 'mermaid') {
        for (let n = code.open.line.number; n <= code.endLineNo; n++) sensitive.add(n);
      }
      if (lang === 'mermaid' && !cursorIn) {
        out.push(
          Decoration.replace({
            block: true,
            widget: new MermaidWidget(doc.sliceString(code.codeFrom, code.codeTo), code.from),
          }).range(code.from, code.to)
        );
      }
      i = code.endLineNo + 1;
      continue;
    }

    if (i === 1 && frontMatter) {
      const fm = frontMatter;
      for (let n = fm.startLine; n <= fm.endLine; n++) sensitive.add(n);
      if (fm) {
        let inside = false;
        for (let k = fm.startLine; k <= fm.endLine; k++) {
          if (active.has(k)) inside = true;
        }
        if (!inside) {
          out.push(
            Decoration.replace({
              block: true,
              widget: new FrontMatterWidget(fm.fields, fm.from),
            }).range(fm.from, fm.to)
          );
          i = fm.endLine + 1;
          continue;
        }
      }
    }

    const fnLine = footnoteDef(text);
    if (fnLine) sensitive.add(i);
    if (fnLine && !active.has(i)) {
      out.push(
        Decoration.replace({
          block: true,
          widget: new FootnoteDefWidget(fnLine.id, fnLine.text, line.from),
        }).range(line.from, line.to)
      );
      i++;
      continue;
    }

    // 单行公式块 $$...$$
    // 光标在块外：整行换成渲染结果。光标进来：源码留着，正下方再挂一张实时预览，高度不塌。
    if (/^\s{0,3}\$\$.+\$\$\s*$/.test(text)) {
      sensitive.add(i);
      const inner = /^\s{0,3}\$\$([\s\S]+)\$\$\s*$/.exec(text)[1].trim();
      if (!active.has(i)) {
        out.push(
          Decoration.replace({ block: true, widget: new MathWidget(inner, true, line.from) }).range(line.from, line.to)
        );
      } else {
        out.push(
          Decoration.widget({ block: true, side: 1, widget: new MathWidget(inner, true, line.from, true) }).range(line.to)
        );
      }
      i++;
      continue;
    }

    // 多行公式块
    if (/^\s{0,3}\$\$\s*$/.test(text)) {
      let j = i + 1;
      while (j <= doc.lines && !/^\s{0,3}\$\$\s*$/.test(doc.line(j).text)) j++;
      const endLine = Math.min(j, doc.lines);
      for (let n = i; n <= endLine; n++) sensitive.add(n);
      let anyActive = false;
      for (let k = i; k <= endLine; k++) {
        if (active.has(k)) {
          anyActive = true;
          break;
        }
      }
      const tex = [];
      for (let k = i + 1; k < endLine; k++) tex.push(doc.line(k).text);
      const formula = tex.join('\n');
      if (!anyActive) {
        out.push(
          Decoration.replace({ block: true, widget: new MathWidget(formula, true, line.from) }).range(
            line.from,
            doc.line(endLine).to
          )
        );
      } else {
        out.push(
          Decoration.widget({
            block: true,
            side: 1,
            widget: new MathWidget(formula, true, line.from, true),
          }).range(doc.line(endLine).to)
        );
      }
      i = endLine + 1;
      continue;
    }

    // 目录：整行只有一个 [toc]（Typora 的写法）时渲染成可点击的目录块
    if (tocRe.test(text)) {
      sensitive.add(i);
      if (!active.has(i)) {
        out.push(
          Decoration.replace({ block: true, widget: new TocWidget(headingList(), line.from) }).range(line.from, line.to)
        );
      }
      i++;
      continue;
    }

    // 表格：共享扫描器已经处理外侧管道省略、代码 span 内竖线和列数归一化。
    const table = tableByLine.get(i);
    if (table) {
      for (let n = table.startLine; n <= table.endLine; n++) sensitive.add(n);
      let anyActive = false;
      for (let k = table.startLine; k <= table.endLine; k++) {
        if (active.has(k)) {
          anyActive = true;
          break;
        }
      }
      if (!anyActive) {
        out.push(
          Decoration.replace({
            block: true,
            widget: new TableWidget(table.rows, table.aligns, table.from, table.to, table.startLine),
          }).range(table.from, table.to)
        );
      }
      i = table.endLine + 1;
      continue;
    }

    // 独占一行的图片用块级替换。行内 widget 塞一个块级 div 时，CM 只量到行盒上半截：
    // 下半截点不中，点中上半截后又会在图前面多出一行才画出地址。
    const loneImg = /^([ \t]*)(!\[[^\]]*\]\(([^)\n]*)\)(?:\{[^{}\n]*\})?)[ \t]*$/.exec(text);
    if (loneImg && !/^\s*\|/.test(text)) {
      sensitive.add(i);
      const imgFrom = line.from + loneImg[1].length;
      const imgSyntax = loneImg[2];
      const imgTo = imgFrom + imgSyntax.length;
      const { src, title } = parseDest(loneImg[3]);
      const attr = /\{([^{}]*)\}\s*$/.exec(imgSyntax);
      const spec = attr ? parseImageAttrs(attr[1]) : { width: '', align: '' };
      if (src) {
        const alt = /^!\[([^\]]*)\]/.exec(imgSyntax);
        const editingNow = state.field(editingImageField, false);
        const editing = !!editingNow && editingNow.from === imgFrom && editingNow.to === imgTo;
        out.push(
          Decoration.replace({
            block: true,
            widget: new ImageWidget(
              src,
              alt ? alt[1] : '',
              title,
              imgFrom,
              imgTo,
              false,
              currentDocBase(),
              editing,
              spec.width,
              spec.align,
              attr ? attr[0].trim() : ''
            ),
          }).range(line.from, line.to)
        );
        i++;
        continue;
      }
    }

    // 分割线（排除 setext 标题的二条横线）。文首信息里的 --- 不是分割线。
    const inFront = frontMatter && i >= frontMatter.startLine && i <= frontMatter.endLine;
    if (!inFront && /^\s{0,3}((-\s*){3,}|(\*\s*){3,}|(_\s*){3,})$/.test(text)) {
      sensitive.add(i);
    }
    if (!inFront && /^\s{0,3}((-\s*){3,}|(\*\s*){3,}|(_\s*){3,})$/.test(text) && !active.has(i)) {
      const prevBlank = i === 1 || !doc.line(i - 1).text.trim();
      if (prevBlank) {
        out.push(Decoration.replace({ block: true, widget: new HrWidget(line.from) }).range(line.from, line.to));
      }
    }
    i++;
  }
  // <details><summary> 折叠块实时预览（块级替换必须落在 StateField blockDecorations 中）
  const docStr = doc.toString();
  if (docStr.includes('<details')) {
    for (const blk of scanDetailsBlocks(docStr)) {
      if (blk.to <= blk.from || blk.to > doc.length) continue;
      const startNo = doc.lineAt(blk.from).number;
      const endNo = doc.lineAt(blk.to).number;
      let touched = false;
      for (let ln = startNo; ln <= endNo; ln++) {
        sensitive.add(ln);
        if (active.has(ln)) touched = true;
      }
      if (!touched) {
        out.push(
          Decoration.replace({
            block: true,
            widget: new DetailsWidget(blk.summary, blk.body, blk.open, blk.from, blk.to),
          }).range(blk.from, blk.to)
        );
      }
    }
  }
  return Decoration.set(out, true);
}

export const blockDecorations = StateField.define({
  create: (state) => {
    try {
      return computeBlockDecos(state);
    } catch (e) {
      console.warn('[block]', e);
      return Decoration.none;
    }
  },
  update(value, tr) {
    // 切源代码模式、切专注模式都要重算：它们不改文档也不动选区
    const forced = tr.effects.some((e) => e.is(setSourceMode) || e.is(setEditingImage) || e.is(refreshDecorations));
    if (!forced && !tr.docChanged && !tr.selection) return value.map(tr.changes);
    if (!forced && !tr.docChanged && tr.selection) {
      // 普通正文之间移动光标不会改变任何块级 widget。只有进入/离开表格、
      // 公式、脚注、目录、Mermaid 等显形敏感行时才需要重新扫描。
      if (blockActivityKey(tr.startState) === blockActivityKey(tr.state)) {
        blockDebug.reused++;
        return value;
      }
    }
    try {
      return computeBlockDecos(tr.state);
    } catch (e) {
      console.warn('[block]', e);
      return Decoration.none;
    }
  },
  provide: (f) => EditorView.decorations.from(f),
});

/* ---------------- 行内装饰（ViewPlugin：只在视口内计算） ---------------- */

function buildInline(view) {
  const { state } = view;
  const doc = state.doc;
  // 源代码模式：行内标记（**、`、链接语法）也原样显示
  if (inSourceMode(state)) return { deco: Decoration.none, atomic: Decoration.none };
  const active = activeLineSet(state);
  const deco = [];
  const atomic = [];
  const lineClasses = new Map();
  const tableRanges = scanTables(doc);
  const tableLines = new Set();
  for (const table of tableRanges) {
    for (let n = table.startLine; n <= table.endLine; n++) tableLines.add(n);
  }

  const addLine = (no, cls) => {
    let s = lineClasses.get(no);
    if (!s) lineClasses.set(no, (s = new Set()));
    s.add(cls);
  };
  const hide = (from, to) => {
    if (to > from) deco.push(Decoration.replace({}).range(from, to));
  };
  const mark = (from, to, cls, attributes) => {
    if (to > from) deco.push(Decoration.mark({ class: cls, attributes }).range(from, to));
  };
  const blockActive = (from, to) => {
    const a = doc.lineAt(from).number;
    const b = doc.lineAt(Math.min(to, doc.length)).number;
    for (let k = a; k <= b; k++) if (active.has(k)) return true;
    return false;
  };
  const cursorTouches = (from, to) => cursorTouchesRange(state, from, to);
  const inCode = (pos) => CODE_NODES.has(syntaxTree(state).resolveInner(pos, -1).name);

  /**
   * 块级标记的「空格提交」门槛。
   * 正在输入的这一行只有标记本身（-、*、+、1.、>、#），后面还没跟空格时，
   * 一律按普通文本显示：补一个空格才真正变成列表 / 引用 / 标题。
   * 否则想写「-3」「#话题」这类内容，第一个字符就会先把格式套上。
   * 只约束光标所在行，已有文档里的裸标记行仍按 CommonMark 原样渲染。
   */
  const bareMarkLine = (line) =>
    active.has(line.number) && /^ {0,3}(?:#{1,6}|>+|[-*+]|\d{1,9}[.)])$/.test(line.text);

  /**
   * 图片：整行只有一个 `![alt](src)` 时按块级展示，否则跟着文字排。
   * 语法树认出来的和下面兜底扫出来的都走这里，解析规则只写一遍。
   * 返回 false 表示没解析出地址（比如 `![](  )`），交给上层当普通文本。
   */
  const renderImage = (from, to, alt, destRaw) => {
    const { src, title } = parseDest(destRaw);
    if (!src) return false;
    const line = doc.lineAt(from);
    const brace = imageBraceAfter(doc, to);
    const end = brace ? brace.end : to;
    const lone = line.text.trim() === doc.sliceString(from, end).trim();
    // 整行图片由块级字段画，这里再替换一次会和块装饰重叠。
    if (lone) {
      addLine(line.number, 'cm-image-line');
      return true;
    }
    const editingNow = state.field(editingImageField, false);
    const editing = !!editingNow && editingNow.from === from && editingNow.to === end;
    const d = Decoration.replace({
      widget: new ImageWidget(
        src,
        alt,
        title,
        from,
        end,
        true,
        currentDocBase(),
        editing,
        brace ? brace.width : '',
        brace ? brace.align : '',
        brace ? brace.raw : ''
      ),
    });
    deco.push(d.range(from, end));
    if (!editing) atomic.push(d.range(from, end));
    return true;
  };

  // 语法树已经当 Image 处理过的区间：兜底扫描要跳过，否则同一张图渲染两遍
  const treeImages = [];

  /* 专注模式：除当前段落外整体淡出 */
  const focusMode = document.body.classList.contains('focus-mode');
  let focusFrom = 0;
  let focusTo = 0;
  if (focusMode) {
    let head = state.selection.main.head;
    // 光标不在可视区（刚打开文档时光标在文末、页面却在顶部）时，改用视口首行作锚点，
    // 否则整屏都会被判成「非当前段落」而全部淡出。
    // 布局尚未完成时 visibleRanges 为空，此时退回首行。
    const ranges = view.visibleRanges;
    const inView = ranges.some((r) => head >= r.from && head <= r.to);
    if (!inView) head = ranges.length ? ranges[0].from : 0;
    let a = doc.lineAt(head).number;
    let b = a;
    // 空行回退到最近的非空行
    while (a > 1 && !doc.line(a).text.trim()) a--;
    b = a;
    while (a > 1 && doc.line(a - 1).text.trim()) a--;
    while (b < doc.lines && doc.line(b + 1).text.trim()) b++;
    focusFrom = doc.line(a).from;
    focusTo = doc.line(b).to;
  }

  const frontMatter = scanFrontMatter(doc);
  const frontClosed =
    frontMatter &&
    !state.selection.ranges.some((r) => r.from <= frontMatter.to && r.to >= frontMatter.from);

  for (const range of view.visibleRanges) {
    // 代码块边界由统一扫描器给出，不依赖语法树当前的临时配对状态。
    // 已闭合块的两条围栏始终收起；只有尚未闭合、正在输入的首围栏允许显形。
    for (const block of getCodeFences(state)) {
      if (isFenceDraft(block)) continue;
      if ((block.lang || '').trim().toLowerCase() === 'mermaid') {
        const cursorIn = state.selection.ranges.some((r) => r.from <= block.to && r.to >= block.from);
        if (!cursorIn) continue;
      }
      if (block.to < range.from || block.from > range.to) continue;
      const first = block.open.line;
      const last = block.close ? block.close.line : doc.lineAt(block.to);
      const fromLine = Math.max(first.number, doc.lineAt(range.from).number);
      const toLine = Math.min(last.number, doc.lineAt(range.to).number);
      for (let k = fromLine; k <= toLine; k++) {
        addLine(k, 'cm-code-line');
        if (k === first.number) {
          addLine(k, 'cm-code-first');
          addLine(k, 'cm-no-ln');
        }
        if (k === last.number) addLine(k, 'cm-code-last');
        if (block.close && k === last.number) addLine(k, 'cm-no-ln');
        if (block.close) {
          if (k === first.number) addLine(k, 'cm-fence-open');
          if (k === last.number) addLine(k, 'cm-fence-close');
          if (k === first.number + 1) addLine(k, 'cm-code-body-first');
          if (k === last.number - 1) addLine(k, 'cm-code-body-last');
        }
      }

      const editingUnclosedFence = !block.close && !block.implicit && active.has(first.number);
      if (editingUnclosedFence) addLine(first.number, 'cm-fence-pending');
      if (!editingUnclosedFence && first.from >= range.from && first.from <= range.to) {
        deco.push(
          Decoration.replace({
            widget: new FenceChipWidget(
              block.lang,
              first.from,
              block.codeFrom,
              block.codeTo,
              block.infoFrom,
              block.infoTo
            ),
          }).range(first.from, first.to)
        );
      }
      const cursorInBlock = state.selection.ranges.some((r) => r.from <= block.to && r.to >= block.from);
      if (block.close && last.from >= range.from && last.from <= range.to) {
        deco.push(
          Decoration.replace({
            widget: new FenceLangWidget(block.lang, block.infoFrom, block.infoTo, cursorInBlock),
          }).range(last.from, last.to)
        );
      } else if (!block.close && !editingUnclosedFence) {
        // 还没写完的代码块没有尾围栏，语言小框先挂在首行旁边
        deco.push(
          Decoration.widget({
            widget: new FenceLangWidget(block.lang, block.infoFrom, block.infoTo, cursorInBlock),
            side: 1,
          }).range(first.to)
        );
      }
    }

    syntaxTree(state).iterate({
      from: range.from,
      to: range.to,
      enter: (ref) => {
        const name = ref.name;
        const from = ref.from;
        const to = ref.to;
        const node = ref.node;
        if (frontClosed && from >= frontMatter.from && from < frontMatter.to) return false;
        // 表格由块级 TableWidget 完整接管；语法树不再向其中添加强调、链接或图片装饰。
        // 尤其是省略行首 | 的宽松表格，过去会在这里与块级替换区间发生冲突。
        if (tableRanges.some((table) => from >= table.from && to <= table.to)) return false;

        if (name === 'Paragraph') {
          const parent = node.parent;
          const raw = doc.sliceString(from, to).trim();
          // 独占一行的图片不是自然段。段后距会在图的上下各垫出一行空白。
          const imageOnly = /^!\[[^\]]*\]\([^)\n]*\)$/.test(raw);
          // 首行缩进只给文档最外层的自然段。引用和列表里的文字不缩进。
          if (!imageOnly && parent && (parent.name === 'Document' || parent.name === 'Blockquote')) {
            const end = to > from ? to - 1 : from;
            const endLine = doc.lineAt(end);
            if (parent.name === 'Document') addLine(doc.lineAt(from).number, 'cm-para-first');
            // 引用最后一行本身由 .cm-quote-last 控制内/外留白，不再叠加 cm-para-last，
            // 避免点击引用或清空引用文字时背景框高度跳变。
            const isQuoteLast =
              parent.name === 'Blockquote' &&
              endLine.number >= doc.lineAt(Math.max(parent.from, parent.to - 1)).number;
            // 下一行本身是空行时，空行已提供完整行高，不再额外叠段后距（也不再随光标进出切换高度）。
            const nextNo = endLine.number + 1;
            const nextIsBlank = nextNo <= doc.lines && !doc.line(nextNo).text.trim();
            if (!isQuoteLast && !nextIsBlank) addLine(endLine.number, 'cm-para-last');
          }
        }

        const heading = /^ATXHeading(\d)$/.exec(name);
        if (heading) {
          const no = doc.lineAt(from).number;
          if (bareMarkLine(doc.line(no))) return; // 只有 #、还没空格：先按普通文本
          addLine(no, 'cm-heading');
          addLine(no, 'cm-h' + heading[1]);
          const mk = node.getChild('HeaderMark');
          if (mk) {
            const end = Math.min(eatSpace(doc, mk.to, doc.lineAt(mk.from).to), to);
            if (!blockActive(from, to)) hide(mk.from, end);
            else {
              // 光标行显示 Typora 式 h1~h6 徽标（浮在左侧留白里，标题文字不横跳），不再显示 ###
              deco.push(
                Decoration.replace({
                  widget: new TextWidget('h' + heading[1], 'cm-heading-badge'),
                }).range(mk.from, end)
              );
            }
          }
          return;
        }

        if (name === 'SetextHeading1' || name === 'SetextHeading2') {
          const no = doc.lineAt(from).number;
          // Setext 下划线只要一个 - / = 就成立。刚敲下第一个字符时别把上一行变成标题，
          // 否则想在段落下写列表（- 空格）时，上一行会先突然变成二级标题。
          const mk0 = node.getChild('HeaderMark');
          const underlineLine = mk0 ? doc.lineAt(mk0.from) : doc.lineAt(Math.max(from, to - 1));
          if (bareMarkLine(underlineLine)) return;
          addLine(no, 'cm-heading');
          addLine(no, 'cm-h' + (name === 'SetextHeading1' ? '1' : '2'));
          if (!blockActive(from, to)) {
            const mk = node.getChild('HeaderMark');
            if (mk) hide(mk.from, mk.to);
          }
          return;
        }

        if (name === 'StrongEmphasis') {
          mark(from + 2, to - 2, 'cm-strong');
          if (!cursorTouches(from, to)) {
            let c = node.firstChild;
            while (c) {
              if (c.name === 'EmphasisMark') hide(c.from, c.to);
              c = c.nextSibling;
            }
          }
          return;
        }

        if (name === 'Emphasis') {
          mark(from + 1, to - 1, 'cm-em');
          if (!cursorTouches(from, to)) {
            let c = node.firstChild;
            while (c) {
              if (c.name === 'EmphasisMark') hide(c.from, c.to);
              c = c.nextSibling;
            }
          }
          return;
        }

        if (name === 'Strikethrough') {
          mark(from + 2, to - 2, 'cm-strike');
          if (!cursorTouches(from, to)) {
            let c = node.firstChild;
            while (c) {
              if (c.name === 'StrikethroughMark') hide(c.from, c.to);
              c = c.nextSibling;
            }
          }
          return;
        }

        if (name === 'InlineCode') {
          mark(from, to, 'cm-inline-code');
          if (!cursorTouches(from, to)) {
            let c = node.firstChild;
            while (c) {
              if (c.name === 'CodeMark') hide(c.from, c.to);
              c = c.nextSibling;
            }
          }
          return;
        }

        if (name === 'URL') {
          // GFM 裸链接（https://a、www.a）在树里就是行内 URL 节点；
          // Link / Autolink / Image 内部的 URL 由各自的分支处理，这里不能重复包。
          const parent = node.parent;
          if (parent && ['Link', 'Autolink', 'Image'].includes(parent.name)) return;
          if (cursorTouches(from, to)) return;
          const href = doc.sliceString(from, to);
          mark(from, to, 'cm-link', { title: href, 'data-href': href });
          return;
        }

        if (name === 'Autolink') {
          if (cursorTouches(from, to)) return;
          const kids = [];
          let c = node.firstChild;
          while (c) {
            kids.push(c);
            c = c.nextSibling;
          }
          // 尖括号形式 <https://a> 有 URL 子节点；GFM 裸 URL 没有，整段就是地址。
          const urlNode = kids.find((k) => k.name === 'URL');
          const href = urlNode ? doc.sliceString(urlNode.from, urlNode.to) : doc.sliceString(from, to);
          mark(from, to, 'cm-link', { title: href, 'data-href': href });
          // 裸 URL 原样显示；尖括号形式只把 < > 藏掉，地址本身保留可见。
          if (urlNode) {
            for (const k of kids) {
              if (k.name !== 'URL') hide(k.from, k.to);
            }
          }
          return;
        }

        if (name === 'Link') {
          const rawLink = doc.sliceString(from, to);
          if (/^\[[^\]]+\]\[[^\]]*\]$/.test(rawLink)) return;
          if (cursorTouches(from, to)) return;
          const kids = [];
          let c = node.firstChild;
          while (c) {
            kids.push(c);
            c = c.nextSibling;
          }
          const urlNode = kids.find((k) => k.name === 'URL');
          const label = urlNode
            ? doc.sliceString(from + 1, Math.max(from + 1, urlNode.from - 2))
            : doc.sliceString(from, to);
          const href = urlNode ? doc.sliceString(urlNode.from, urlNode.to) : '';
          // data-href：Ctrl/Cmd + 点击时从这里取地址（见 index.js 的 openLink）。
          // 普通点击仍然是「把光标放进文字里改」——链接在编辑器里首先是文本。
          mark(from, to, 'cm-link', { title: href || label, 'data-href': href });
          for (const k of kids) {
            if (k.name === 'LinkMark' || k.name === 'URL') hide(k.from, k.to);
          }
          return;
        }

        if (name === 'Image') {
          const raw = doc.sliceString(from, to);
          // URL 里可能含空格（data URI）或成对尖括号，不能用 [^)\s]+ 草率匹配
          const m = /^!\[([^\]]*)\]\(([\s\S]*)\)$/.exec(raw);
          if (!m) return;
          treeImages.push([from, to]);
          renderImage(from, to, m[1], m[2]);
          return;
        }

        if (name === 'Blockquote') {
          const a = doc.lineAt(from).number;
          const b = doc.lineAt(Math.max(from, to - 1)).number;
          // 没有 > 的懒续行虽然还在引用节点里，视觉上不当成引用，否则下一行会跟着带背景。
          let first = 0;
          let last = 0;
          for (let k = a; k <= b; k++) {
            if (!quoteDepth(doc.line(k).text)) continue;
            if (bareMarkLine(doc.line(k))) continue; // 裸 > 还没跟空格，不套引用样式
            addLine(k, 'cm-quote');
            if (!first) first = k;
            last = k;
          }
          if (first) {
            addLine(first, 'cm-quote-first');
            addLine(last, 'cm-quote-last');
          }
          return;
        }

        if (name === 'QuoteMark') {
          const line = doc.lineAt(from);
          // > 标记始终收起，光标进入引用行也不再显示源码。
          // 刚敲出来、还没跟空格的裸 > 仍按源码显示，等空格提交；
          // 退出引用由 exitQuoteOnBackspace 处理，不依赖标记可见。
          if (bareMarkLine(line)) return;
          hide(from, Math.min(eatSpace(doc, to, line.to), line.to));
          return;
        }

        if (name === 'BulletList' || name === 'OrderedList') {
          // 只标最外层列表；嵌套列表仍紧跟所属列表项，不在列表内部制造额外断层。
          if (node.parent && node.parent.name !== 'ListItem' && !bareMarkLine(doc.lineAt(from))) {
            addLine(doc.lineAt(from).number, 'cm-list-first');
            addLine(doc.lineAt(to).number, 'cm-list-last');
          }
          return;
        }

        if (name === 'ListItem') {
          if (!bareMarkLine(doc.lineAt(from))) addLine(doc.lineAt(from).number, 'cm-li');
          return;
        }

        if (name === 'ListMark') {
          const t = doc.sliceString(from, to);
          const line = doc.lineAt(from);
          // 只敲了 - / * / 1. 还没空格：保留原字符，不换成圆点、不加悬挂缩进
          if (bareMarkLine(line)) return;

          // 悬挂缩进只用 padding。负的 text-indent 会让 posAtCoords 把点击横坐标算偏，
          // 点在「2」右边时光标仍落在数字前面。序号本身用负 margin 拉回左侧留白。
          const listInfo = listLineInfo(line.text);
          const contentStart = listInfo ? listInfo.contentStart : 0;
          const w = listInfo ? listInfo.width : 0;
          const depth = listInfo ? listInfo.depth : 0;
          // 引用行的 > 始终隐藏，列表也按普通渲染处理（隐藏缩进、序号用渲染样式），
          // 光标进入时排版不再变化。
          const indentEm = (w * 0.75 + 1.5).toFixed(2);
          deco.push(
            Decoration.line({
              attributes: {
                // 普通列表直接算左内边距；引用列表由 CSS 用同一个变量叠加引用自身的缩进。
                style: `--list-indent:${indentEm}em;padding-left:calc(var(--gutter-x, 40px) + ${indentEm}em)`,
              },
            }).range(line.from)
          );
          // 引用里的缩进从 > 前缀之后开始隐藏，绝不能连同 QuoteMark 一起替换。
          if (w > 0) hide(line.from + contentStart, from);

          const markerEnd = eatSpace(doc, to, line.to);
          // 任务清单行：连标记一起隐藏，只留勾选框
          if (/^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/.test(line.text)) {
            hide(from, markerEnd);
            return;
          }
          // 只替换标记本身，后面的空格留在正文流里，点击才能落到数字后面。
          if (t === '-' || t === '*' || t === '+') {
            // 层级以 Markdown 语法树的实际嵌套为准，不再假定“每 2 空格一级”。
            // 因而常见的 4 空格、Tab 与 2 空格列表都能显示正确的圆点档位。
            let depth = 0;
            for (let parent = node.parent; parent; parent = parent.parent) {
              if (parent.name === 'BulletList') depth++;
            }
            const lvl = Math.max(0, depth - 1);
            const glyph = ['•', '◦', '▪'][lvl % 3];
            deco.push(Decoration.replace({ widget: new TextWidget(glyph, 'cm-bullet') }).range(from, to));
            return;
          }
          if (/^\d/.test(t)) {
            const shown = orderedNumber(doc, line.number, w, depth) + t.slice(-1);
            deco.push(Decoration.replace({ widget: new TextWidget(shown, 'cm-ordered-num') }).range(from, to));
            return;
          }
          mark(from, to, 'cm-list-mark');
          return;
        }

        if (name === 'FencedCode') {
          // 围栏、语言标签与代码行样式已在上面按统一区间处理。
          // 这里仍让语法树正常遍历，代码语言的 token 着色不受影响。
          return;
        }

        if (name === 'HorizontalRule') {
          // 由块级状态字段处理
          return;
        }
      },
    });

    // 逐行扫描：任务清单、引用层级、高亮、行内公式、图片兜底
    let pos = range.from;
    while (pos <= range.to) {
      const line = doc.lineAt(pos);
      const text = line.text;
      if (frontClosed && line.number >= frontMatter.startLine && line.number <= frontMatter.endLine) {
        pos = line.to + 1;
        continue;
      }
      const inFence = lineClasses.get(line.number)?.has('cm-code-line');
      const tableLine = tableLines.has(line.number);
      // 只有光标停在这一行时才加深。选区盖住整行时再铺一层深底，
      // 会把行号一起涂暗，并和正文的选区蓝叠成另一种颜色。
      if (inFence && caretOnLine(state, line.number)) addLine(line.number, 'cm-code-active');

      if (focusMode && (line.to < focusFrom || line.from > focusTo)) addLine(line.number, 'cm-dim');

      // 光标正在这一行时不压缩：否则新行字号只有 10px，光标比有字的行矮一截。
      if (!text.trim() && !inFence) {
        if (active.has(line.number)) addLine(line.number, 'cm-caret-line');
        else addLine(line.number, 'cm-blank');
      }

      if (!inFence && !tableLine && !footnoteDef(text)) {
        const fnRe = /\[\^([^\]]+)\](?!:)/g;
        let fnMatch;
        while ((fnMatch = fnRe.exec(text))) {
          const fnFrom = line.from + fnMatch.index;
          const fnTo = fnFrom + fnMatch[0].length;
          if (cursorTouches(fnFrom, fnTo) || inCode(fnFrom)) continue;
          deco.push(Decoration.replace({ widget: new FootnoteRefWidget(fnMatch[1]) }).range(fnFrom, fnTo));
        }
      }

      if (!inFence) {
        const depth = quoteDepth(text);
        if (depth && !bareMarkLine(line)) {
          addLine(line.number, 'cm-qd-' + Math.min(depth, 4));
        }
        const callout = calloutInfo(doc, line.number);
        if (callout) {
          addLine(line.number, 'cm-callout');
          addLine(line.number, 'cm-callout-' + callout.type);
          if (callout.head) {
            addLine(line.number, 'cm-callout-head');
            if (!active.has(line.number)) {
              const m = /^([ \t]{0,3}(?:>[ \t]*)+)\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.exec(text);
              if (m) {
                const a = line.from + m[1].length;
                const b = line.from + m[0].length;
                deco.push(Decoration.replace({ widget: new TextWidget(m[2].toUpperCase(), 'cm-callout-label') }).range(a, b));
              }
            }
          }
        }
      }

      const task = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\](?=[ \t]|$)/.exec(text);
      if (task && !inFence) {
        const open = line.from + task[1].length;
        deco.push(Decoration.replace({ widget: new TaskWidget(task[2] !== ' ', open + 1) }).range(open, open + 3));
        if (task[2] !== ' ') addLine(line.number, 'cm-task-done');
      }

      // 常见无属性行内 HTML + 白名单样式 <center>/<span style>：只加表现层装饰，绝不执行任意 HTML。
      if (!inFence && !tableLine && text.includes('<')) {
        for (const html of scanInlineHtml(text)) {
          const hFrom = line.from + html.from;
          const hTo = line.from + html.to;
          if (inCode(hFrom) || syntaxTree(state).resolveInner(hFrom, 1).name === 'Image') continue;
          mark(line.from + html.contentFrom, line.from + html.contentTo, html.className);
          if (!cursorTouches(hFrom, hTo)) {
            hide(line.from + html.openFrom, line.from + html.openTo);
            hide(line.from + html.closeFrom, line.from + html.closeTo);
          }
        }
        for (const sh of scanStyledInlineHtml(text)) {
          const hFrom = line.from + sh.from;
          const hTo = line.from + sh.to;
          if (inCode(hFrom) || syntaxTree(state).resolveInner(hFrom, 1).name === 'Image') continue;
          if (sh.tag === 'center') {
            addLine(line.number, 'cm-html-center');
          } else if (sh.tag === 'span' && sh.style) {
            const cFrom = line.from + sh.contentFrom;
            const cTo = line.from + sh.contentTo;
            if (cTo > cFrom) {
              deco.push(Decoration.mark({ attributes: { style: sh.style } }).range(cFrom, cTo));
            }
          }
          if (!cursorTouches(hFrom, hTo)) {
            hide(line.from + sh.openFrom, line.from + sh.openTo);
            hide(line.from + sh.closeFrom, line.from + sh.closeTo);
          }
        }
      }

      // ==高亮==：光标没贴上时收起等号。嵌进粗体/代码里会和已有替换区间重叠，直接跳过。
      if (!inFence && !tableLine && text.includes('==')) {
        const hiRe = /==([^=\n]+?)==/g;
        let hm;
        const skipHost = new Set([
          'StrongEmphasis',
          'Emphasis',
          'Strikethrough',
          'Link',
          'Image',
          'URL',
          'Autolink',
          ...CODE_NODES,
        ]);
        while ((hm = hiRe.exec(text))) {
          const hFrom = line.from + hm.index;
          const hTo = hFrom + hm[0].length;
          if (hTo - hFrom < 5) continue;
          if (inCode(hFrom) || skipHost.has(syntaxTree(state).resolveInner(hFrom + 2, 1).name)) continue;
          mark(hFrom + 2, hTo - 2, 'cm-mark');
          if (!cursorTouches(hFrom, hTo)) {
            hide(hFrom, hFrom + 2);
            hide(hTo - 2, hTo);
          }
        }
      }

      if (!inFence && !tableLine && text.includes('][')) {
        const refs = getReferenceDefs(doc);
        const refRe = /(!?)\[([^\]\n]+)\]\[([^\]\n]*)\]/g;
        let rm;
        while ((rm = refRe.exec(text))) {
          const def = refs.get((rm[3] || rm[2]).toLowerCase());
          if (!def) continue;
          const rFrom = line.from + rm.index;
          const rTo = rFrom + rm[0].length;
          if (inCode(rFrom) || cursorTouches(rFrom, rTo)) continue;
          if (rm[1]) {
            renderImage(rFrom, rTo, rm[2], def.href + (def.title ? ` "${def.title}"` : ''));
          } else {
            const labelTo = rFrom + 1 + rm[2].length;
            mark(rFrom + 1, labelTo, 'cm-link', { title: def.title || def.href, 'data-href': def.href });
            hide(rFrom, rFrom + 1);
            hide(labelTo, rTo);
          }
        }
      }

      if (!inFence && !tableLine && (text.includes('^') || text.includes('~'))) {
        const scriptRules = [
          { re: /\^([^\^\n]+?)\^/g, cls: 'cm-sup' },
          { re: /(?<!~)~([^~\n]+?)~(?!~)/g, cls: 'cm-sub' },
        ];
        for (const rule of scriptRules) {
          let sm;
          while ((sm = rule.re.exec(text))) {
            const sFrom = line.from + sm.index;
            const sTo = sFrom + sm[0].length;
            if (inCode(sFrom) || CODE_NODES.has(syntaxTree(state).resolveInner(sFrom + 1, 1).name)) continue;
            mark(sFrom + 1, sTo - 1, rule.cls);
            if (!cursorTouches(sFrom, sTo)) {
              hide(sFrom, sFrom + 1);
              hide(sTo - 1, sTo);
            }
          }
        }
      }

      const mathRe = /(?<![\\$])\$(?!\$)([^$\n]+?)(?<![\\$])\$(?!\$)/g;
      let mm;
      // 表格行整块已被 widget 顶掉，再往里撒行内装饰会和块级 replaced 区间打架；
      // 单元格里的公式由 TableWidget 自己用 renderInline 渲染
      while (!tableLine && (mm = mathRe.exec(text))) {
        const mFrom = line.from + mm.index;
        const mTo = mFrom + mm[0].length;
        if (inCode(mFrom)) continue;
        if (cursorTouches(mFrom, mTo)) continue;
        const d = Decoration.replace({ widget: new MathWidget(mm[1], false, mFrom) });
        deco.push(d.range(mFrom, mTo));
        atomic.push(d.range(mFrom, mTo));
      }

      /* 兜底扫图片：CommonMark 允许的裸地址里不能有空格，`![x](my pic.png)`
         在语法树里根本不是 Image 节点，会被原样显示成源码。
         Typora 认这种写法，这里也认——反正整行/整段匹配到就渲染。
         表格行跳过：整张表已经被块级 widget 顶掉了，再往里塞行内装饰会撞区间。 */
      if (text.includes('![') && !tableLine && !inFence) {
        const imgRe = /!\[([^\]\n]*)\]\(([^()\n]+)\)/g;
        let im;
        while ((im = imgRe.exec(text))) {
          const iFrom = line.from + im.index;
          const iTo = iFrom + im[0].length;
          if (treeImages.some(([a, b]) => iFrom < b && iTo > a)) continue;
          if (inCode(iFrom)) continue;
          renderImage(iFrom, iTo, im[1], im[2]);
        }
      }

      if (line.to >= range.to) break;
      pos = line.to + 1;
    }
  }

  for (const [no, set] of lineClasses) {
    deco.push(Decoration.line({ class: [...set].join(' ') }).range(doc.line(no).from));
  }

  return { deco: Decoration.set(deco, true), atomic: Decoration.set(atomic, true) };
}

export const livePreview = ViewPlugin.fromClass(
  class {
    constructor(view) {
      const r = buildInline(view);
      this.decorations = r.deco;
      this.atomics = r.atomic;
    }
    update(u) {
      const forced = u.transactions.some((tr) =>
        tr.effects.some((e) => e.is(refreshDecorations) || e.is(setSourceMode))
      );
      if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged || u.heightChanged || forced) {
        const r = buildInline(u.view);
        this.decorations = r.deco;
        this.atomics = r.atomic;
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => {
        const p = view.plugin(plugin);
        return p ? p.atomics : Decoration.none;
      }),
  }
);
