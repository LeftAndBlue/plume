/**
 * 围栏代码块的统一扫描器。
 *
 * 实时预览、复制和删除共用这里的区间，不再各自依赖语法树做二次猜测。
 * 除了正常 Markdown 配对，还能从被误删成 `` 的尾围栏中恢复后续代码块。
 */

const OPEN_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const REMNANT_RE = /^ {0,3}(`{1,2}|~{1,2})\s*$/;

function parseFence(line) {
  const m = OPEN_RE.exec(line.text);
  if (!m) return null;
  // CommonMark：反引号围栏的 info 里不能再含反引号。
  if (m[2][0] === '`' && m[3].includes('`')) return null;
  return {
    line,
    mark: m[2],
    marker: m[2][0],
    info: m[3],
  };
}

function parseRemnant(line) {
  const m = REMNANT_RE.exec(line.text);
  if (!m) return null;
  return { line, mark: m[1], marker: m[1][0], info: '', remnant: true };
}

function isClosing(fence, open) {
  return !!fence &&
    fence.marker === open.marker &&
    fence.mark.length >= open.mark.length &&
    !fence.info.trim();
}

/** 后面是否还有这个带语言围栏的合法收尾。 */
function hasClosingAhead(doc, lineNo, open) {
  for (let n = lineNo + 1; n <= doc.lines; n++) {
    const candidate = parseFence(doc.line(n));
    if (isClosing(candidate, open)) return true;
  }
  return false;
}

/**
 * close 为真实/残缺尾围栏；implicitEnd 用于尾围栏已完全删掉的情况。
 * implicitEnd 是上一块最后一行的行号，绝不越过下一块的语言围栏。
 */
function finishBlock(doc, open, close, implicitEnd = 0) {
  const openLine = open.line;
  const closeLine = close ? close.line : null;
  const endLineNo = closeLine ? closeLine.number : Math.max(openLine.number, implicitEnd || doc.lines);
  const endLine = closeLine || doc.line(endLineNo);
  const to = endLine.to;
  const codeFrom = Math.min(openLine.to + 1, closeLine ? closeLine.from : to);
  const codeTo = closeLine ? Math.max(codeFrom, closeLine.from - 1) : Math.max(codeFrom, to);

  const infoLead = /^\s*/.exec(open.info)[0].length;
  const infoTail = /\s*$/.exec(open.info)[0].length;
  const infoFrom = openLine.from + open.line.text.indexOf(open.mark) + open.mark.length + infoLead;
  const infoTo = Math.max(infoFrom, openLine.to - infoTail);

  return {
    open,
    close,
    implicit: !closeLine && implicitEnd > 0,
    endLineNo,
    from: openLine.from,
    to,
    codeFrom,
    codeTo,
    infoFrom,
    infoTo,
    lang: open.info.trim(),
  };
}

/**
 * 扫描全文围栏。返回的每个块都有明确的 open / close / codeFrom / codeTo。
 *
 * 容错规则：
 * 1. 无语言围栏后遇到“带语言围栏 + 合法尾围栏”，前者视为孤儿尾围栏。
 * 2. 有语言块尚未正常闭合时又遇到新的语言围栏，上一块在语言围栏前结束。
 *    如果前一行是被删剩的 `` / ~，把它当作残缺尾围栏一并隐藏。
 *
 * 这样即使上一个代码块的尾围栏已被破坏，下面的 ```python / ```cs 仍独立成块。
 */
function scanCodeFences(doc) {
  const blocks = [];
  let open = null;

  for (let n = 1; n <= doc.lines; n++) {
    const fence = parseFence(doc.line(n));
    if (!fence) continue;

    if (open) {
      if (isClosing(fence, open)) {
        blocks.push(finishBlock(doc, open, fence));
        open = null;
        continue;
      }

      if (fence.info.trim() && hasClosingAhead(doc, n, fence)) {
        if (!open.info.trim()) {
          // open 实际是保留下来的旧尾围栏；丢弃它，从新的语言围栏重新成块。
          open = fence;
          continue;
        }

        const remnant = n > open.line.number + 1 ? parseRemnant(doc.line(n - 1)) : null;
        if (remnant && remnant.marker === open.marker) {
          blocks.push(finishBlock(doc, open, remnant));
        } else {
          blocks.push(finishBlock(doc, open, null, n - 1));
        }
        open = fence;
      }
      continue;
    }

    open = fence;
  }

  if (open) blocks.push(finishBlock(doc, open, null));
  return blocks;
}

// Text 是不可变对象；同一份文档在选区变化时可以直接复用扫描结果。
const cache = new WeakMap();

export function getCodeFences(state) {
  const cached = cache.get(state.doc);
  if (cached) return cached;
  const blocks = scanCodeFences(state.doc);
  cache.set(state.doc, blocks);
  return blocks;
}

/** 只打出了开头的 ```，还没按回车补上结尾围栏。这时不要套代码块样式。 */
export function isFenceDraft(block) {
  return !block.close && !block.implicit;
}
