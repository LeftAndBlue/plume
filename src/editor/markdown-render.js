import { getKatex } from './inline-text.js';
import {
  isTableDelimiterRow,
  isTableRow,
  splitTableRow,
} from './rich-doc.js';
import { splitMarkdownLines } from './markdown-source.js';
import { slugify } from './slugify.js';

export { slugify };

// katex 懒加载：exportHtmlReady 会先 await ensureKatex()，同步渲染
// 只在已就绪时渲染公式，未就绪（如测试直调）退化为源码文本。
function texToHtml(tex, displayMode) {
  const katex = getKatex();
  if (!katex) return `<code>${esc(tex)}</code>`;
  try {
    return katex.renderToString(tex, { throwOnError: false, displayMode, strict: false, trust: false });
  } catch {
    return `<code>${esc(tex)}</code>`;
  }
}

export const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const unesc = (s) =>
  String(s).replace(/&(amp|lt|gt|quot|#39);/g, (entity) => ({
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  }[entity]));

/** 过滤危险 URL 协议，防止导出 HTML / 富文本剪贴板注入可执行脚本。 */
export function sanitizeExportUrl(raw, { allowDataImage = false } = {}) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  const compact = trimmed.replace(/[\u0000-\u0020]+/g, '').toLowerCase();
  if (compact.startsWith('javascript:') || compact.startsWith('vbscript:')) return '';
  if (compact.startsWith('data:')) {
    if (allowDataImage && /^data:image\/(png|jpe?g|gif|webp|bmp|avif);/i.test(compact)) {
      return trimmed;
    }
    return '';
  }
  return trimmed;
}

export function inline(text, refs = new Map(), resolveImageSrc = null) {
  const codes = [];
  let s = text.replace(/<br\s*\/?\s*>/gi, '\u0001').replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s);
  // 只还原白名单内的无属性表现标签；script、事件属性和其它 HTML 始终保持转义文本。
  s = s.replace(/&lt;(kbd|u|mark|sup|sub)&gt;([\s\S]*?)&lt;\/\1&gt;/gi, (_, tag, body) => {
    const name = tag.toLowerCase();
    return `<${name}>${body}</${name}>`;
  });
  s = s.replace(/(?<![\\$])\$(?!\$)([^$\n]+?)(?<![\\$])\$(?!\$)/g, (_, tex) => texToHtml(tex, false));
  // 地址里允许空格（编辑器里也认这种写法），标题仍是尾部的那对引号
  s = s.replace(
    /!\[([^\]]*)\]\(([^)]*?)(?:\s+&quot;([^&]*)&quot;)?\)(?:\{([^{}]*)\})?/g,
    (_, alt, src, t, attrs) => {
      const width = attrs && /width\s*=\s*(?:&quot;)?([^&"\s}]+)/i.exec(attrs);
      const align = attrs && /align\s*=\s*(?:&quot;)?(left|center|right)/i.exec(attrs);
      const size = width ? (/^\d+(\.\d+)?$/.test(width[1]) ? width[1] + 'px' : width[1]) : '';
      const place =
        align && align[1] === 'center'
          ? 'display:block;margin-left:auto;margin-right:auto'
          : align && align[1] === 'right'
            ? 'display:block;margin-left:auto'
            : align
              ? 'display:block;margin-right:auto'
              : '';
      const style = [size ? `width:${esc(size)}` : '', place].filter(Boolean).join(';');
      const rawSrc = unesc(src.trim());
      const resolved = typeof resolveImageSrc === 'function' ? resolveImageSrc(rawSrc) : rawSrc;
      const safeSrc = sanitizeExportUrl(resolved, { allowDataImage: true });
      return `<img src="${esc(safeSrc)}" alt="${alt}"${t ? ` title="${t}"` : ''}${style ? ` style="${style}"` : ''}>`;
    }
  );
  s = s.replace(/\[\^([^\]]+)\](?!:)/g, (_, id) => `<sup class="fn-ref"><a href="#fn-${esc(id)}">${esc(id)}</a></sup>`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_, txt, href, t) => {
    const safeHref = sanitizeExportUrl(unesc(href));
    return `<a href="${esc(safeHref || '#')}"${t ? ` title="${t}"` : ''}>${txt}</a>`;
  });
  s = s.replace(/!\[([^\]]*)\]\[([^\]]*)\]/g, (whole, alt, label) => {
    const def = refs.get((label || alt).toLowerCase());
    if (!def) return whole;
    const resolved = typeof resolveImageSrc === 'function' ? resolveImageSrc(def.href) : def.href;
    const safeSrc = sanitizeExportUrl(resolved, { allowDataImage: true });
    return `<img src="${esc(safeSrc)}" alt="${alt}"${def.title ? ` title="${esc(def.title)}"` : ''}>`;
  });
  s = s.replace(/\[([^\]]+)\]\[([^\]]*)\]/g, (whole, txt, label) => {
    const def = refs.get((label || txt).toLowerCase());
    if (!def) return whole;
    const safeHref = sanitizeExportUrl(def.href);
    return `<a href="${esc(safeHref || '#')}"${def.title ? ` title="${esc(def.title)}"` : ''}>${txt}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
  s = s.replace(/\^([^\^\n]+)\^/g, '<sup>$1</sup>');
  s = s.replace(/(?<!~)~([^~\n]+)~(?!~)/g, '<sub>$1</sub>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
  s = s.replace(/\u0001/g, '<br>');
  return s;
}

const isFence = (l) => /^\s{0,3}(`{3,}|~{3,})/.test(l);
const isHeading = (l) => /^(#{1,6})\s+/.test(l);
const isList = (l) => /^\s*([-*+]|\d+[.)])\s+/.test(l);
const isQuote = (l) => /^\s{0,3}>/.test(l);
const isHr = (l) => /^\s{0,3}((-\s*){3,}|(\*\s*){3,}|(_\s*){3,})$/.test(l);
const isToc = (l) => /^\s{0,3}\[toc\]\s*$/i.test(l);

function splitTableLine(text) {
  return splitTableRow(text).map((cell) => cell.text);
}

function tableColumnsAt(lines, index) {
  if (index < 0 || index + 1 >= lines.length) return 0;
  const delimiterCols = splitTableLine(lines[index + 1]).length;
  if (!isTableDelimiterRow(lines[index + 1], delimiterCols)) return 0;
  if (!isTableRow(lines[index], delimiterCols)) return 0;
  const cols = splitTableLine(lines[index]).length;
  return cols >= 2 && cols === delimiterCols ? cols : 0;
}

function scanHeadings(lines) {
  const used = new Set();
  const list = [];
  let fence = null;
  for (const l of lines) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(l);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    if (isHeading(l)) {
      const level = /^(#{1,6})/.exec(l)[1].length;
      const text = l.replace(/^#{1,6}\s+/, '').replace(/\s*#*\s*$/, '');
      list.push({ level, text, id: slugify(text, used) });
    }
  }
  return list;
}

function tocHtml(headings, refs, resolveImageSrc) {
  if (!headings.length) return '<nav class="toc"><span class="toc-empty">目录：文档里还没有标题</span></nav>';
  const min = headings.reduce((n, h) => Math.min(n, h.level), 6);
  return (
    '<nav class="toc">' +
    headings
      .map(
        (h) =>
          `<a class="toc-item toc-h${h.level}" style="padding-left:${(h.level - min) * 14}px" href="#${h.id}">${inline(
            h.text, refs, resolveImageSrc
          )}</a>`
      )
      .join('') +
    '</nav>'
  );
}

function listMarker(line) {
  const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
  if (!m) return null;
  return {
    indent: m[1].replace(/\t/g, '  ').length,
    ordered: /^\d/.test(m[2]),
    start: /^\d/.test(m[2]) ? parseInt(m[2], 10) : 1,
    text: m[3],
  };
}

function renderNestedList(lines, start, refs, resolveImageSrc) {
  const first = listMarker(lines[start]);
  const base = first.indent;
  const ordered = first.ordered;
  const items = [];
  let current = null;
  let i = start;
  while (i < lines.length) {
    const marker = listMarker(lines[i]);
    if (!marker) {
      if (current && lines[i].trim() && /^\s+/.test(lines[i])) {
        current.html += '<br>' + inline(lines[i].trim(), refs, resolveImageSrc);
        i++;
        continue;
      }
      break;
    }
    if (marker.indent < base || (marker.indent === base && marker.ordered !== ordered)) break;
    if (marker.indent > base) {
      if (!current) break;
      const child = renderNestedList(lines, i, refs, resolveImageSrc);
      current.html += child.html;
      i = child.next;
      continue;
    }
    let content = marker.text;
    const task = /^\[([ xX])\]\s+(.*)$/.exec(content);
    current = {
      html: task
        ? `<input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''}> ${inline(task[2], refs, resolveImageSrc)}`
        : inline(content, refs, resolveImageSrc),
    };
    items.push(current);
    i++;
  }
  const tag = ordered ? 'ol' : 'ul';
  const startAttr = ordered && first.start !== 1 ? ` start="${first.start}"` : '';
  return {
    html: `<${tag}${startAttr}>${items.map((item) => `<li>${item.html}</li>`).join('')}</${tag}>`,
    next: i,
  };
}

export function renderMarkdown(md, inheritedRefs, resolveImageSrc = null) {
  const lines = splitMarkdownLines(md);
  const out = [];
  const headings = scanHeadings(lines);
  const refs = new Map(inheritedRefs || []);
  for (const line of lines) {
    const def = /^\s{0,3}\[([^\]^][^\]]*)\]:\s*(\S+)(?:\s+["'(](.*)["')])?\s*$/.exec(line);
    if (def) refs.set(def[1].toLowerCase(), { href: def[2].replace(/^<|>$/g, ''), title: def[3] || '' });
  }
  // 按出现顺序取 id：scanHeadings 与下面的主循环走同一批行、同样的跳过规则，序号对得上
  let headingNo = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s{0,3}\[[^\]^][^\]]*\]:\s*\S+/.test(line)) {
      i++;
      continue;
    }

    if (i === 0 && /^---\s*$/.test(line)) {
      let j = 1;
      const fields = [];
      while (j < lines.length && !/^(?:---|\.\.\.)\s*$/.test(lines[j])) {
        const field = /^([^:#\s][^:]*):\s*(.*)$/.exec(lines[j]);
        if (field) fields.push(field);
        j++;
      }
      if (j < lines.length) {
        if (fields.length) {
          out.push(
            '<dl class="frontmatter">' +
              fields.map((f) => `<dt>${esc(f[1].trim())}</dt><dd>${esc(f[2].trim())}</dd>`).join('') +
              '</dl>'
          );
        }
        i = j + 1;
        continue;
      }
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const fn = /^\[\^([^\]]+)\]:[ \t]*(.*)$/.exec(line);
    if (fn) {
      out.push(`<aside class="footnote" id="fn-${esc(fn[1])}"><sup>${esc(fn[1])}</sup> ${inline(fn[2], refs, resolveImageSrc)}</aside>`);
      i++;
      continue;
    }

    if (isToc(line)) {
      out.push(tocHtml(headings, refs, resolveImageSrc));
      i++;
      continue;
    }

    const fence = /^\s{0,3}(`{3,}|~{3,})\s*([^`~]*)$/.exec(line);
    if (fence) {
      const ch = fence[1][0];
      const len = fence[1].length;
      const lang = fence[2].trim();
      const closeRe = new RegExp('^\\s{0,3}' + (ch === '`' ? '`' : '~') + '{' + len + ',}\\s*$');
      const buf = [];
      i++;
      while (i < lines.length && !closeRe.test(lines[i])) buf.push(lines[i++]);
      i++;
      if (lang.toLowerCase() === 'mermaid') {
        out.push(`<pre class="mermaid">${esc(buf.join('\n'))}</pre>`);
      } else {
        out.push(
          `<pre class="code"><code${lang ? ` class="language-${esc(lang)}"` : ''}>${esc(buf.join('\n'))}</code></pre>`
        );
      }
      continue;
    }

    if (/^\s*\$\$\s*$/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*\$\$\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<div class="math-block">${texToHtml(buf.join('\n'), true)}</div>`);
      continue;
    }

    if (/^\s*\$\$.+\$\$\s*$/.test(line)) {
      const tex = /^\s*\$\$([\s\S]+)\$\$\s*$/.exec(line)[1];
      out.push(`<div class="math-block">${texToHtml(tex.trim(), true)}</div>`);
      i++;
      continue;
    }

    if (isHeading(line)) {
      const level = /^(#{1,6})/.exec(line)[1].length;
      const meta = headings[headingNo++];
      out.push(
        `<h${level}${meta ? ` id="${meta.id}"` : ''}>${inline(
          line.replace(/^#{1,6}\s+/, '').replace(/\s*#*\s*$/, ''), refs, resolveImageSrc
        )}</h${level}>`
      );
      i++;
      continue;
    }

    if (isHr(line) && (i === 0 || !lines[i - 1].trim())) {
      out.push('<hr>');
      i++;
      continue;
    }

    const tableCols = tableColumnsAt(lines, i);
    if (tableCols) {
      const parse = splitTableLine;
      const head = parse(line);
      const aligns = parse(lines[i + 1]).map((c) =>
        c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'
      );
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i], tableCols)) rows.push(parse(lines[i++]));
      out.push(
        '<table><thead><tr>' +
          head.map((c, j) => `<th style="text-align:${aligns[j] || 'left'}">${inline(c, refs, resolveImageSrc)}</th>`).join('') +
          '</tr></thead><tbody>' +
          rows
            .map(
              (r) =>
                '<tr>' +
                head
                  .map((_, j) => `<td style="text-align:${aligns[j] || 'left'}">${inline(r[j] || '', refs, resolveImageSrc)}</td>`)
                  .join('') +
                '</tr>'
            )
            .join('') +
          '</tbody></table>'
      );
      continue;
    }

    if (isQuote(line)) {
      const buf = [];
      while (i < lines.length && isQuote(lines[i])) buf.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      const callout = /^\[!([A-Za-z]+)\][ \t]*(.*)\n?([\s\S]*)$/.exec(buf.join('\n'));
      if (callout) {
        const kind = callout[1].toLowerCase();
        const title = callout[2] || callout[1].toUpperCase();
        out.push(
          `<aside class="callout callout-${esc(kind)}"><div class="callout-title">${inline(title, refs, resolveImageSrc)}</div>` +
            `<div class="callout-body">${renderMarkdown(callout[3], refs, resolveImageSrc)}</div></aside>`
        );
      } else out.push('<blockquote>' + renderMarkdown(buf.join('\n'), refs, resolveImageSrc) + '</blockquote>');
      continue;
    }

    if (isList(line)) {
      const list = renderNestedList(lines, i, refs, resolveImageSrc);
      out.push(list.html);
      i = list.next;
      continue;
    }

    const buf = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !isHeading(lines[i]) &&
      !isFence(lines[i]) &&
      !isQuote(lines[i]) &&
      !isList(lines[i]) &&
      !tableColumnsAt(lines, i) &&
      !/^\s*\$\$\s*$/.test(lines[i]) &&
      !isHr(lines[i])
    ) {
      buf.push(lines[i++]);
    }
    if (buf.length) out.push('<p>' + inline(buf.join('\n'), refs, resolveImageSrc).replace(/\n/g, '<br>') + '</p>');
    else i++;
  }

  return out.join('\n');
}
