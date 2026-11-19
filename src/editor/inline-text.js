/**
 * 行内 markdown → DOM 片段。
 *
 * 只用在「不该暴露源码、又不在 CM 文档区」的地方 —— 目前是表格单元格。
 * 格子里写 `**粗**`、`` `code` ``、`[文字](链接)` 时，Typora 是渲染出来的，
 * 我们原来直接把原文塞进 textContent，于是表格里也冒出 `**` 这种字符
 * （和大纲里那个 `**` 是同一类问题，只是发生在另一种容器里）。
 *
 * 刻意手写，不复用 CM 的解析：这里的输入是「一个单元格的一段纯文本」，
 * 没有文档上下文（没有 from/to、没有语法树、没有可见范围），
 * 为了几行字把 lezer 整套 parser 拖进 widget 层不划算。
 */
import { INLINE_HTML_CLASSES } from './rich-doc.js';

/* ---------------- KaTeX（懒加载） ----------------
 * katex 约 280KB，不该进首屏包：首次遇到公式才动态加载。
 * 加载完成前公式显示源码占位；加载完成后通过 onTexReady 通知刷新装饰。 */

let katex = null;
let katexPromise = null;
const texReadyCbs = new Set();

export function isTexReady() {
  return !!katex;
}

export function getKatex() {
  return katex;
}

export function ensureKatex() {
  if (katex) return Promise.resolve();
  if (!katexPromise) {
    katexPromise = import('katex')
      .then((mod) => {
        katex = mod.default || mod;
        for (const cb of [...texReadyCbs]) {
          try {
            cb();
          } catch (e) {
            console.warn('[katex] ready callback', e);
          }
        }
      })
      .catch((e) => {
        katexPromise = null; // 失败后允许下次重试
        console.warn('[katex] 加载失败', e);
      });
  }
  return katexPromise;
}

/** 订阅 katex 就绪；已就绪时立即回调。返回取消订阅函数。 */
export function onTexReady(cb) {
  if (katex) {
    cb();
    return () => {};
  }
  texReadyCbs.add(cb);
  return () => texReadyCbs.delete(cb);
}

const escTex = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function renderTex(tex, display) {
  if (!katex) {
    ensureKatex();
    return '<span class="cm-math-pending">' + escTex(tex) + '</span>';
  }
  try {
    return katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      strict: false,
      trust: false,
      output: 'htmlAndMathml',
    });
  } catch (e) {
    return '<span class="cm-math-error">' + (e && e.message ? e.message : '公式解析失败') + '</span>';
  }
}

/* ---------------- 小工具 ---------------- */

const text = (s) => document.createTextNode(s);

function el(tag, cls, ...kids) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  for (const k of kids) if (k != null) n.appendChild(k);
  return n;
}

/* ---------------- 规则表 ---------------- */

/**
 * 顺序即优先级，两条硬约束：
 *   1. 转义、行内代码排最前 —— `` `**x**` `` 里的星号不是粗体
 *   2. `**` 必须排在 `*` 之前，否则粗体永远只能匹配出一个星号
 * 全部用 sticky（y）：只接受「正好落在当前扫描位置」的匹配，
 * 不然 `a*b*c` 里的 `*b*` 会被当成从 a 开始的斜体。
 */
const RULES = [
  { kind: 'escape', re: /\\([\\`*_{}[\]()#+\-.!~$>|])/y },
  { kind: 'code', re: /(`+)([^\n]*?)\1(?!`)/y },
  { kind: 'br', re: /<br\s*\/?\s*>/iy },
  { kind: 'html', re: /<(kbd|u|mark|sup|sub)>([^<>\n]*?)<\/\1>/iy },
  { kind: 'image', re: /!\[([^\]\n]*)\]\(([^)\n]*)\)/y },
  { kind: 'link', re: /\[([^\]\n]*)\]\(([^)\n]*)\)/y },
  { kind: 'strong', re: /\*\*([\s\S]+?)\*\*/y },
  { kind: 'strong', re: /__([\s\S]+?)__/y },
  { kind: 'del', re: /~~([\s\S]+?)~~/y },
  { kind: 'mark', re: /==([^=\n]+?)==/y },
  { kind: 'sup', re: /\^([^\^\n]+?)\^/y },
  { kind: 'sub', re: /~([^~\n]+?)~/y },
  { kind: 'em', re: /\*([^*\n]+?)\*/y },
  { kind: 'em', re: /_([^_\n]+?)_/y },
  { kind: 'math', re: /\$([^$\n]+?)\$/y },
];

const MAX_DEPTH = 4;

/**
 * @param {string} src 单元格里的原始文本（已去掉 `\|` 转义）
 * @param {{resolve?: (src: string) => string}} [opts]
 *        resolve 传进来时，单元格里的图片才渲染成 <img>；不传就退化成 alt 文字。
 *        用回调而不是直接 import，是为了不让 widgets → inline-text → widgets 成环。
 * @returns {DocumentFragment}
 */
export function renderInline(src, { resolve, depth = 0 } = {}) {
  const frag = document.createDocumentFragment();
  const s = String(src ?? '');
  let buf = '';
  const flush = () => {
    if (buf) {
      frag.appendChild(text(buf));
      buf = '';
    }
  };

  let pos = 0;
  while (pos < s.length) {
    let hit = null;
    if (depth < MAX_DEPTH) {
      for (const r of RULES) {
        r.re.lastIndex = pos;
        const m = r.re.exec(s);
        if (!m) continue;
        // 保守起见的两处例外，都是为了别把正常文字吃掉
        if (r.kind === 'em' && m[0][0] === '_' && pos > 0 && /[\w\u4e00-\u9fff]/.test(s[pos - 1])) continue;
        if (r.kind === 'math' && s[pos + 1] === '$') continue;
        hit = { kind: r.kind, m };
        break;
      }
    }

    if (!hit) {
      buf += s[pos];
      pos++;
      continue;
    }

    flush();
    const { kind, m } = hit;
    switch (kind) {
      case 'escape':
        frag.appendChild(text(m[1]));
        break;
      case 'code':
        frag.appendChild(el('code', 'cm-inline-code', text(m[2] || '')));
        break;
      case 'br':
        frag.appendChild(document.createElement('br'));
        break;
      case 'html': {
        const tag = m[1].toLowerCase();
        frag.appendChild(el(tag, INLINE_HTML_CLASSES[tag], renderInline(m[2], { resolve, depth: depth + 1 })));
        break;
      }
      case 'image': {
        const alt = m[1];
        const dest = m[2].trim();
        if (resolve && dest) {
          const img = document.createElement('img');
          img.className = 'cm-cell-image';
          img.src = resolve(dest);
          img.alt = alt;
          img.draggable = false;
          frag.appendChild(img);
        } else {
          frag.appendChild(text(alt || dest));
        }
        break;
      }
      case 'link': {
        // 做成 span 而不是 <a>：表格里点一下是「进格子编辑」，
        // 真链接会把这次点击吞掉。地址放 title，悬停能看见。
        const a = el('span', 'cm-link', text(m[1] || m[2]));
        a.title = m[2];
        a.dataset.href = m[2];
        frag.appendChild(a);
        break;
      }
      case 'strong':
        frag.appendChild(el('strong', 'cm-strong', renderInline(m[1], { resolve, depth: depth + 1 })));
        break;
      case 'em':
        frag.appendChild(el('em', 'cm-em', renderInline(m[1], { resolve, depth: depth + 1 })));
        break;
      case 'del':
        frag.appendChild(el('del', 'cm-strike', renderInline(m[1], { resolve, depth: depth + 1 })));
        break;
      case 'mark':
        frag.appendChild(el('mark', 'cm-mark', renderInline(m[1], { resolve, depth: depth + 1 })));
        break;
      case 'sup':
        frag.appendChild(el('sup', 'cm-sup', renderInline(m[1], { resolve, depth: depth + 1 })));
        break;
      case 'sub':
        frag.appendChild(el('sub', 'cm-sub', renderInline(m[1], { resolve, depth: depth + 1 })));
        break;
      case 'math': {
        const box = el('span', 'cm-math is-inline');
        box.innerHTML = renderTex(m[1], false);
        frag.appendChild(box);
        break;
      }
    }
    pos += m[0].length;
  }

  flush();
  return frag;
}

/** 去掉行内标记、只留可读文本。大纲、链接标题和纯文本比较共用同一套规则。 */
export function plainInline(value) {
  let s = String(value ?? '');
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!~$>|])/g, '$1');
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.replace(/`+([^`]*)`+/g, '$1');
  s = s.replace(/<\/?(?:kbd|u|mark|sup|sub)>/gi, '');
  s = s.replace(/<br\s*\/?\s*>/gi, ' ');
  s = s.replace(/(\*\*\*|__)([\s\S]+?)\1/g, '$2');
  s = s.replace(/\*\*([\s\S]+?)\*\*/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  s = s.replace(/~~([\s\S]+?)~~/g, '$1');
  s = s.replace(/==([^=\n]+?)==/g, '$1');
  s = s.replace(/\^([^\^=\n]+?)\^/g, '$1');
  s = s.replace(/~([^~\n]+?)~/g, '$1');
  s = s.replace(/(?<![*\w])\*([^*\n]+?)\*(?!\*)/g, '$1');
  s = s.replace(/_([^_\n]+?)_/g, '$1');
  s = s.replace(/\$([^$\n]+?)\$/g, '$1');
  return s.replace(/\s+/g, ' ').trim();
}
