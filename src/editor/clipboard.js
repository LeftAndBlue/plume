import { renderMarkdown, inline, esc } from "./markdown-export.js";
import { getCodeFences, isFenceDraft } from "./code-fences.js";

const BLOCK_PREFIX_RE = /^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/;

/**
 * 将图片相对路径/本地路径解析为外部程序（Word、邮件等）能访问的 URL。
 *   - http(s) / data URI 原样保留
 *   - 本地绝对路径转为标准 file:/// URL
 *   - 相对路径拼在 docDir 下转为 file:/// URL
 */
export function resolveImageForClipboard(src, docDir) {
  if (!src) return "";
  const s = src.trim();
  if (/^(?:https?:|data:|\/\/)/i.test(s)) return s;

  // Windows 盘符 C:\ 或 C:/
  if (/^[a-zA-Z]:[\\/]/.test(s)) {
    const clean = s.replace(/\\/g, "/");
    return "file:///" + clean;
  }

  // 相对路径
  if (docDir) {
    const base = docDir.replace(/[\\/]$/, "");
    const cleanRel = s.replace(/^\.[\\/]/, "");
    const full = `${base}/${cleanRel}`.replace(/\\/g, "/");
    return full.startsWith("/") ? "file://" + full : "file:///" + full;
  }

  return s;
}

/**
 * 将 HTML 片段转换为渲染后的纯文本。
 * 利用隐藏在视口外的 DOM 元素（必须参与布局，因此不能使用 display: none）获取 innerText。
 */
export function htmlToPlainText(html) {
  if (!html) return "";
  if (typeof document !== "undefined" && document.createElement) {
    const div = document.createElement("div");
    div.style.cssText =
      "position:fixed;left:-9999px;top:-9999px;width:1000px;opacity:0;pointer-events:none;";
    div.innerHTML = html;
    document.body.appendChild(div);
    const text = div.innerText;
    div.remove();
    return text;
  }
  // 兜底（Node/SSR 环境）
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .trim();
}

/**
 * 渲染单个选区范围为 { html, plain }。
 */
function renderRange(state, range, docDir) {
  const doc = state.doc;
  const from = range.from;
  const to = range.to;
  if (from >= to) return { html: "", plain: "" };

  const imageResolver = (src) => resolveImageForClipboard(src, docDir);

  // 1. 检查选区是否落在代码围栏内（或包含整个围栏）
  const fences = getCodeFences(state);
  const fence = fences.find((f) => !isFenceDraft(f) && from >= f.from && to <= f.to);
  if (fence) {
    const cleanFrom = Math.max(from, fence.codeFrom);
    const cleanTo = Math.min(to, fence.codeTo);
    if (cleanTo >= cleanFrom) {
      const code = doc.sliceString(cleanFrom, cleanTo);
      const lang = fence.lang ? fence.lang.trim() : "";
      const isSingleLine =
        doc.lineAt(cleanFrom).number === doc.lineAt(cleanTo).number;
      const html = isSingleLine
        ? `<code>${esc(code)}</code>`
        : `<pre class="code"><code${lang ? ` class="language-${esc(lang)}"` : ""}>${esc(code)}</code></pre>`;
      return { html, plain: code };
    }
  }

  const startLine = doc.lineAt(from);
  const endLine = doc.lineAt(to);
  const raw = doc.sliceString(from, to);

  // 2. 单行选区
  if (startLine.number === endLine.number) {
    const isWholeLine = from === startLine.from && to === startLine.to;
    const m = BLOCK_PREFIX_RE.exec(startLine.text);
    const isBlockContentSelected =
      m && from <= startLine.from + m[0].length && to === startLine.to;

    if (isWholeLine || isBlockContentSelected) {
      // 选中了整行（或在实时预览中选中了隐藏标记后的整段可见块）
      const html = renderMarkdown(startLine.text, null, imageResolver);
      const plain = htmlToPlainText(html);
      return { html, plain };
    }
    // 行中间开始或结束的部分选区：退化为行内渲染，不套 <p>，不把中间的字符当块级标题/列表
    const html = inline(raw, new Map(), imageResolver);
    const plain = htmlToPlainText(html);
    return { html, plain };
  }

  // 3. 多行选区
  const startAtLineStart = from === startLine.from;
  const m = BLOCK_PREFIX_RE.exec(startLine.text);
  const isBlockPrefixStart = m && from <= startLine.from + m[0].length;

  let textToRender = raw;
  let hasZeroWidthGuard = false;

  if (isBlockPrefixStart && from > startLine.from) {
    // 补齐隐藏的块标记前缀，使首行块级结构正常渲染
    const missingPrefix = startLine.text.slice(0, from - startLine.from);
    textToRender = missingPrefix + raw;
  } else if (!startAtLineStart) {
    // 如果起始点位于非块标记的行中间（如句子中段），避免首行意外匹配块级语法
    if (/^\s{0,3}(?:#{1,6}|`{3,}|~{3,}|>|[-*+]|\d+[.)])/.test(raw)) {
      textToRender = "\u200B" + raw;
      hasZeroWidthGuard = true;
    }
  }

  let html = renderMarkdown(textToRender, null, imageResolver);
  if (hasZeroWidthGuard) {
    html = html.replace(/\u200B/g, "");
  }
  const plain = htmlToPlainText(html);
  return { html, plain };
}

/**
 * 遍历所有选区（支持多光标多选区），渲染为剪贴板数据。
 */
export function renderSelectionForClipboard(state, docDir) {
  const ranges = state.selection.ranges.filter((r) => !r.empty);
  if (!ranges.length) return { html: "", plain: "" };

  const results = ranges.map((r) => renderRange(state, r, docDir));
  const html = results.map((r) => r.html).join("\n");
  const plain = results.map((r) => r.plain).join("\n");
  return { html, plain };
}
