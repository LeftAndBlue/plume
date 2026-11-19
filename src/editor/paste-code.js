/**
 * 粘贴即代码块（Typora 的手感）：剪贴板里是一段 SQL / 程序时，直接落成一个
 * 带语言标记的围栏代码块，而不是一坨挤在段落里的纯文本。
 *
 * 判断只做「一眼就是代码」的那些：SQL 语句、import/def/function 开头、JSON、HTML…
 * 认不出语言但明显是代码的多行文本，给一个无语言围栏块。
 * 拿不准就返回 false，交给 CM 原生粘贴 —— 宁可少转，也不能把一段中文变成代码块。
 */
import { syntaxTree } from '@codemirror/language';

/** 去掉首尾空行、统一换行，但保留代码内部的缩进 */
function normalize(raw) {
  return String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/^\s*\n+/, '')
    .replace(/[ \t\n]+$/, '');
}

/** 是不是 Markdown 自身的排版文本：列表 / 标题 / 引用 / 表格 / 分割线 */
function isMarkdownProse(body) {
  const lines = body.split('\n').filter((l) => l.trim());
  if (!lines.length) return false;
  const md = lines.filter((l) => /^\s{0,3}(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>\s|\||(?:---|\*\*\*|___)\s*$)/.test(l));
  return md.length / lines.length >= 0.8;
}

/** 语言特征表：从上往下第一条命中就生效，越窄的摆越前面 */
const RULES = [
  {
    lang: 'sql',
    test(body, lines, first) {
      const head = /^(?:select|insert\s+into|update|delete\s+from|merge\s+into|create\s+(?:or\s+replace\s+)?(?:table|view|index|database|schema|function|procedure|trigger)|alter\s+(?:table|view|database)|drop\s+(?:table|view|index|database|schema)|truncate\s+table|with\s+[\w"]+\s+as\b|explain(?:\s+analyze)?|show\s+(?:tables|databases|create)|describe|desc)\b/i;
      if (!head.test(first)) return false;
      // 「Select the file you want from the list」也是 select…from…，
      // 但一句英文不会有 SQL 的标点；这种别抢，按普通文字粘。
      const englishProse = /\b(?:the|you|your|please|this|that|we|our|should)\b/i.test(body);
      if (englishProse && !/[;,()*=]/.test(body)) return false;
      // 光有一个动词不够（可能只是一句英文），还得有 SQL 的骨架
      return (
        /\b(?:from|where|join|group\s+by|order\s+by|having|values|set|into|on|union|limit|returning|primary\s+key|as\s+select)\b/i.test(
          body
        ) || /;\s*$/.test(body)
      );
    },
  },
  {
    lang: 'json',
    test(body) {
      if (!/^[\[{]/.test(body)) return false;
      try {
        const v = JSON.parse(body);
        return v !== null && typeof v === 'object';
      } catch {
        return false;
      }
    },
  },
  {
    lang: 'html',
    test(body, lines, first) {
      return /^<(?:!doctype|html|head|body|div|span|script|style|svg|table|section|input)\b/i.test(first);
    },
  },
  {
    lang: 'typescript',
    test(body) {
      return /^(?:interface|type|enum)\s+\w+|:\s*(?:string|number|boolean|any|unknown|void)\b/m.test(body);
    },
  },
  {
    lang: 'css',
    test(body) {
      // 光看 `{ xxx: yyy; }` 会把 TS 的 interface 也当成 CSS，所以再点名几个 CSS 属性
      return (
        /^[.#@\w][^{}]*\{[^{}]*\}/m.test(body) &&
        /\{[^{}]*\b(?:color|margin|padding|display|background|font-size|width|height|border|flex|position|text-align|cursor|overflow)\b\s*:/i.test(body)
      );
    },
  },
  {
    lang: 'python',
    test(body) {
      return /^(?:async\s+def|def|class|from\s+[\w.]+\s+import|import\s+\w+|@\w+|if\s+__name__)\b/m.test(body) ||
        /\bprint\s*\(/.test(body) && /\n/.test(body);
    },
  },
  {
    lang: 'javascript',
    test(body) {
      return /^(?:const|let|var|function|class|import|export|async)\b/m.test(body) ||
        /\b(?:console\.log|document\.|window\.|module\.exports)\b/.test(body) ||
        /=>/.test(body) && /[{};]/.test(body);
    },
  },
  {
    lang: 'go',
    test(body) {
      return /^(?:package\s+\w+|func\s+(?:\([\w\s*]+\)\s*)?\w+\s*\()/m.test(body);
    },
  },
  {
    lang: 'rust',
    test(body) {
      return /^(?:fn\s+main|use\s+\w+::|let\s+(?:mut\s+)?\w+\s*=)/m.test(body);
    },
  },
  {
    lang: 'java',
    test(body) {
      return /\bpublic\s+(?:static\s+)?(?:void|class|int|String)\b|\bSystem\.out\.print/.test(body);
    },
  },
  {
    lang: 'cpp',
    test(body) {
      return /\bstd::|#include\s*<\w+\+?\+?>/m.test(body);
    },
  },
  {
    lang: 'c',
    test(body) {
      return /^#include\b|^\s*(?:int|void)\s+main\s*\(/m.test(body);
    },
  },
  {
    lang: 'bash',
    test(body) {
      return /^(?:#!\/|sudo\s|apt(?:-get)?\s|npm\s|yarn\s|pnpm\s|git\s|docker\s|kubectl\s|curl\s|export\s+\w+=)/m.test(body);
    },
  },
  {
    lang: 'diff',
    test(body) {
      return /^(?:diff --git|\+\+\+ |--- |@@ )/m.test(body);
    },
  },
  {
    lang: 'yaml',
    test(body, lines) {
      return lines.length >= 3 && lines.filter((l) => /^\s*[\w.-]+:\s*\S/.test(l)).length >= 2;
    },
  },
];

/**
 * @returns {{lang: string, body: string} | null} lang 为 '' 表示没认出语言、只给围栏
 */
export function detectCode(raw) {
  const body = normalize(raw);
  if (!body.trim() || body.length > 20000) return null;
  // 已经是带围栏的 Markdown（比如从本文档里复制了一段），再包一层就成了套娃
  if (/```|~~~/.test(body)) return null;
  if (isMarkdownProse(body)) return null;

  const lines = body.split('\n');
  const first = (lines.find((l) => l.trim() && !/^\s*(?:--|\/\/|#|\/\*)/.test(l)) || '').trim();
  for (const rule of RULES) {
    if (rule.test(body, lines, first)) return { lang: rule.lang, body };
  }

  // 认不出语言，但排版上一眼就是代码：多行、有缩进或括号分号，且没有成段的中文句子
  if (lines.length >= 3) {
    const codeish = lines.filter((l) => /^\s{2,}\S|[{};()=<>]|=>/.test(l)).length;
    const prose = /[\u4e00-\u9fff][\u4e00-\u9fff，。！？、；：]{5,}/.test(body);
    if (codeish >= Math.max(2, Math.floor(lines.length * 0.6)) && !prose) {
      return { lang: '', body };
    }
  }
  return null;
}

/** 光标是不是已经在代码块里（在块里粘贴就该是纯文本，不该再套一层围栏） */
function inCode(state, pos) {
  for (let n = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (n.name === 'FencedCode' || n.name === 'CodeBlock') return true;
  }
  return false;
}

/**
 * 把一段剪贴板文本粘成代码块。只接管这些情形：
 *   - 光标在空行（或选中的是空白）：围栏从这一行开始
 *   - 光标在非空行的行首/行尾：自动补一个换行，不打断原句
 * 行中间、选中了正文、光标在代码块里、源代码模式，一律放手让 CM 原生粘贴。
 *
 * @returns {boolean} true = 已经处理，调用方要 preventDefault
 */
export function pasteAsCodeBlock(view, raw, { sourceMode = false } = {}) {
  if (sourceMode || view.state.readOnly) return false;
  const hit = detectCode(raw);
  if (!hit) return false;

  const { state } = view;
  const sel = state.selection.main;
  if (inCode(state, sel.from)) return false;
  // 非空选区只在「同一行里选中的全是空白」时才敢替换，别抢用户本来想覆盖的文字
  if (!sel.empty) {
    if (state.sliceDoc(sel.from, sel.to).trim()) return false;
    if (state.doc.lineAt(sel.from).number !== state.doc.lineAt(sel.to).number) return false;
  }

  const line = state.doc.lineAt(sel.head);
  const atStart = sel.head === line.from;
  const atEnd = sel.head === line.to;
  if (!atStart && !atEnd) return false;

  const fence = '```' + hit.lang;
  // 非空行的行尾要先换行，围栏必须独占一行；行首则把原文字顶到下一段去
  const lead = line.text.trim() && atEnd ? '\n' : '';
  const block = lead + fence + '\n' + hit.body + '\n```\n' + (line.text.trim() && atStart ? '\n' : '');
  const from = line.text.trim() ? sel.head : line.from;
  const to = line.text.trim() ? sel.head : line.to;

  view.dispatch({
    changes: { from, to, insert: block },
    // 光标停在代码正文末尾：接着敲就是接着写代码
    selection: { anchor: from + lead.length + fence.length + 1 + hit.body.length },
    scrollIntoView: true,
  });
  view.focus();
  return true;
}
