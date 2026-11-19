import katexCss from 'katex/dist/katex.min.css?raw';
import { ensureKatex, getKatex } from './inline-text.js';
import {
  isTableDelimiterRow,
  isTableRow,
  splitTableRow,
} from './rich-doc.js';
import { splitMarkdownLines } from './markdown-source.js';

// katex 懒加载：exportHtmlReady 会先 await ensureKatex()，同步的 exportHtml
// 只在已就绪时渲染公式，未就绪（如测试直调）退化为源码文本。
function texToHtml(tex, displayMode) {
  const katex = getKatex();
  if (!katex) return `<code>${esc(tex)}</code>`;
  try {
    return katex.renderToString(tex, { throwOnError: false, displayMode, strict: false });
  } catch {
    return `<code>${esc(tex)}</code>`;
  }
}

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const unesc = (s) =>
  String(s).replace(/&(amp|lt|gt|quot|#39);/g, (entity) => ({
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  }[entity]));

function inline(text, refs = new Map()) {
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
      return `<img src="${src.trim()}" alt="${alt}"${t ? ` title="${t}"` : ''}${style ? ` style="${style}"` : ''}>`;
    }
  );
  s = s.replace(/\[\^([^\]]+)\](?!:)/g, (_, id) => `<sup class="fn-ref"><a href="#fn-${esc(id)}">${esc(id)}</a></sup>`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_, txt, href, t) => {
    return `<a href="${href}"${t ? ` title="${t}"` : ''}>${txt}</a>`;
  });
  s = s.replace(/!\[([^\]]*)\]\[([^\]]*)\]/g, (whole, alt, label) => {
    const def = refs.get((label || alt).toLowerCase());
    return def ? `<img src="${esc(def.href)}" alt="${alt}"${def.title ? ` title="${esc(def.title)}"` : ''}>` : whole;
  });
  s = s.replace(/\[([^\]]+)\]\[([^\]]*)\]/g, (whole, txt, label) => {
    const def = refs.get((label || txt).toLowerCase());
    return def ? `<a href="${esc(def.href)}"${def.title ? ` title="${esc(def.title)}"` : ''}>${txt}</a>` : whole;
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

/**
 * 标题锚点规则见 slugify.js（编辑器热路径与导出共用同一份实现）。
 */
export { slugify } from "./slugify.js";
import { slugify } from "./slugify.js";

/**
 * 导出时把 [toc] 也展开成真的目录。
 * 编辑器里那块是 widget，导出必须自己再算一遍；标题 id 在这一步一起生成，
 * 这样目录链接点和正文标题用的是同一份编号，不会错位。
 */
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

function tocHtml(headings, refs) {
  if (!headings.length) return '<nav class="toc"><span class="toc-empty">目录：文档里还没有标题</span></nav>';
  const min = headings.reduce((n, h) => Math.min(n, h.level), 6);
  return (
    '<nav class="toc">' +
    headings
      .map(
        (h) =>
          `<a class="toc-item toc-h${h.level}" style="padding-left:${(h.level - min) * 14}px" href="#${h.id}">${inline(
            h.text, refs
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

function renderNestedList(lines, start, refs) {
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
        current.html += '<br>' + inline(lines[i].trim(), refs);
        i++;
        continue;
      }
      break;
    }
    if (marker.indent < base || (marker.indent === base && marker.ordered !== ordered)) break;
    if (marker.indent > base) {
      if (!current) break;
      const child = renderNestedList(lines, i, refs);
      current.html += child.html;
      i = child.next;
      continue;
    }
    let content = marker.text;
    const task = /^\[([ xX])\]\s+(.*)$/.exec(content);
    current = {
      html: task
        ? `<input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''}> ${inline(task[2], refs)}`
        : inline(content, refs),
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

export function renderMarkdown(md, inheritedRefs) {
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
      out.push(`<aside class="footnote" id="fn-${esc(fn[1])}"><sup>${esc(fn[1])}</sup> ${inline(fn[2], refs)}</aside>`);
      i++;
      continue;
    }

    if (isToc(line)) {
      out.push(tocHtml(headings, refs));
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
          line.replace(/^#{1,6}\s+/, '').replace(/\s*#*\s*$/, ''), refs
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
          head.map((c, j) => `<th style="text-align:${aligns[j] || 'left'}">${inline(c, refs)}</th>`).join('') +
          '</tr></thead><tbody>' +
          rows
            .map(
              (r) =>
                '<tr>' +
                head
                  .map((_, j) => `<td style="text-align:${aligns[j] || 'left'}">${inline(r[j] || '', refs)}</td>`)
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
          `<aside class="callout callout-${esc(kind)}"><div class="callout-title">${inline(title, refs)}</div>` +
            `<div class="callout-body">${renderMarkdown(callout[3], refs)}</div></aside>`
        );
      } else out.push('<blockquote>' + renderMarkdown(buf.join('\n'), refs) + '</blockquote>');
      continue;
    }

    if (isList(line)) {
      const list = renderNestedList(lines, i, refs);
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
    if (buf.length) out.push('<p>' + inline(buf.join('\n'), refs).replace(/\n/g, '<br>') + '</p>');
    else i++;
  }

  return out.join('\n');
}

const PRINT_CSS = `
:root{--fg:#1f2430;--muted:#6b7280;--line:#e5e7eb;--accent:#3b6cf0;--code-bg:#f6f7f9;}
*{box-sizing:border-box}
body{margin:0;padding:48px 32px 72px;color:var(--fg);background:#fff;
 font-family:"Segoe UI","Microsoft YaHei",-apple-system,system-ui,sans-serif;
 font-size:15.5px;line-height:1.78;-webkit-font-smoothing:antialiased}
main{max-width:760px;margin:0 auto}
h1,h2,h3,h4,h5,h6{line-height:1.3;margin:1.6em 0 .6em;font-weight:600}
h1{font-size:2em;border-bottom:1px solid var(--line);padding-bottom:.3em}
h2{font-size:1.5em;border-bottom:1px solid var(--line);padding-bottom:.25em}
h3{font-size:1.25em}h4{font-size:1.08em}h5,h6{font-size:1em;color:var(--muted)}
p{margin:.85em 0}
a{color:var(--accent);text-decoration:none;border-bottom:1px solid rgba(59,108,240,.3)}
code{font-family:"Cascadia Code",Consolas,monospace;font-size:.9em;background:var(--code-bg);
 padding:.15em .38em;border-radius:4px}
pre.code{background:var(--code-bg);border:1px solid var(--line);border-radius:8px;padding:14px 16px;
 overflow:auto;margin:1.1em 0}
pre.code code{background:none;padding:0;font-size:.88em;line-height:1.62}
pre.mermaid{background:transparent;text-align:center}
.mermaid-export{text-align:center;margin:1.1em 0}.mermaid-export svg{max-width:100%;height:auto}
blockquote{margin:1.2em 0;padding:.2em 1em;border-left:3px solid var(--accent);color:var(--muted);
 background:rgba(59,108,240,.04)}
.callout{margin:1.2em 0;padding:.75em 1em;border-left:4px solid var(--accent);border-radius:6px;background:rgba(59,108,240,.07)}
.callout-warning{border-left-color:#d99a00;background:rgba(217,154,0,.08)}.callout-error,.callout-danger{border-left-color:#d44;background:rgba(221,68,68,.07)}
.callout-title{font-weight:650;margin-bottom:.25em}.callout-body>:first-child{margin-top:0}.callout-body>:last-child{margin-bottom:0}
mark{background:#fff0a6;padding:.08em .18em;border-radius:3px}sup,sub{line-height:0}
kbd{display:inline-block;padding:.04em .38em;border:1px solid #c7ccd4;border-bottom-width:2px;border-radius:4px;
 background:var(--code-bg);font:.82em/1.35 "Cascadia Code",Consolas,monospace;white-space:nowrap}
u{text-underline-offset:.16em}
table{border-collapse:collapse;width:100%;margin:1.2em 0;font-size:.95em}
th,td{border:1px solid var(--line);padding:8px 12px}
th{background:#fafafa;font-weight:600}
hr{border:none;border-top:1px solid var(--line);margin:2em 0}
img{max-width:100%;border-radius:6px}
ul,ol{padding-left:1.6em;margin:.8em 0}
li{margin:.25em 0}
li input[type=checkbox]{margin-right:.4em}
.math-block{margin:1.2em 0;text-align:center;overflow:auto}
.katex{font-size:1.02em}
.toc{margin:1.2em 0;padding:.7em 1em;border-left:2px solid var(--line);background:var(--code-bg);
 border-radius:0 8px 8px 0;font-size:.93em}
.toc-item{display:block;padding:.12em 0;color:var(--muted);text-decoration:none}
.toc-item:hover{color:var(--accent);text-decoration:underline}
.toc-h1{font-weight:600;color:var(--fg)}
.toc-empty{color:var(--muted);font-size:.9em}
@media print{body{padding:0}pre.code,blockquote,table,.toc{break-inside:avoid}}
`;

export function exportHtml(markdown, { title = '墨行 Markline', bare = false } = {}) {
  const body = renderMarkdown(markdown);
  if (bare) {
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc(title)}</title>
</head><body>
${body}
</body></html>`;
  }
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<style>${PRINT_CSS}\n${katexCss}</style>
</head><body><main>
${body}
</main></body></html>`;
}

let exportMermaidPromise = null;
let exportMermaidSeq = 0;

/**
 * 导出前把 Mermaid 固化成 SVG。这样 HTML 不依赖 CDN，PDF/PNG 也不必赌异步绘图何时结束。
 * 测试可以注入 renderMermaid，避免为了解析器断言加载整套图表依赖。
 */
export async function exportHtmlReady(markdown, options = {}) {
  await ensureKatex();
  let html = exportHtml(markdown, options);
  const blocks = [...html.matchAll(/<pre class="mermaid">([\s\S]*?)<\/pre>/g)];
  if (!blocks.length) return html;
  const render =
    options.renderMermaid ||
    (async (code) => {
      if (!exportMermaidPromise) {
        exportMermaidPromise = import('mermaid').then((mod) => {
          const mermaid = mod.default;
          mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', fontFamily: 'inherit' });
          return mermaid;
        });
      }
      const mermaid = await exportMermaidPromise;
      const { svg } = await mermaid.render('markline-export-' + ++exportMermaidSeq, code);
      return svg;
    });
  for (const block of blocks) {
    try {
      const svg = await render(unesc(block[1]));
      html = html.replace(block[0], `<div class="mermaid-export">${svg}</div>`);
    } catch (err) {
      console.warn('[export:mermaid]', err);
      // 绘图失败时保留原始代码块，不静默丢掉用户的图表源码。
    }
  }
  return html;
}
