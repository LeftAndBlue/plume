/**
 * 一键复制为公众号 / 飞书 / 邮件富文本 HTML（全内联样式）：
 * - 复用当前主题的 CSS 变量（含 Orange Heart 橙心、Lapis 青金石等全部内置主题）
 * - 把 Markdown 渲染为自带 inline style 的 HTML，粘贴进微信公众号编辑器、飞书文档或邮件时保留排版
 */
import { renderMarkdown } from './markdown-render.js';

/** 常用主题的内联兜底色板（在无 DOM 或单元测试环境下也可直接按 themeId 渲染）。 */
export const WECHAT_THEME_PRESETS = {
  white: {
    bg: '#ffffff',
    text: '#24292f',
    muted: '#57606a',
    heading: '#1f2328',
    strong: '#1f2328',
    accent: '#2563eb',
    accentSoft: 'rgba(37, 99, 235, 0.1)',
    border: '#e5e7eb',
    codeBg: '#f6f8fa',
    codeText: '#cf222e',
    codeBorder: '#e5e7eb',
    quoteBar: '#2563eb',
    quoteBg: '#f8fafc',
    quoteText: '#4b5563',
    tableHeadBg: '#f3f4f6',
    markBg: '#fef08a',
    fontBody: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
    fontMono: '"JetBrains Mono", Menlo, Consolas, monospace',
  },
  orangeheart: {
    bg: '#ffffff',
    text: '#333333',
    muted: '#666666',
    heading: '#222222',
    strong: '#1a1a1a',
    accent: '#ef7060',
    accentSoft: 'rgba(239, 112, 96, 0.12)',
    border: '#f0e4e0',
    codeBg: '#fff5f3',
    codeText: '#d94f3d',
    codeBorder: '#f4dfda',
    quoteBar: '#ef7060',
    quoteBg: '#fff8f6',
    quoteText: '#595959',
    tableHeadBg: '#fdf1ee',
    markBg: '#ffe9b8',
    fontBody: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
    fontMono: '"JetBrains Mono", Menlo, Consolas, monospace',
  },
  lapis: {
    bg: '#ffffff',
    text: '#354152',
    muted: '#5c6b7f',
    heading: '#2c4c7e',
    strong: '#1f365c',
    accent: '#4870ac',
    accentSoft: 'rgba(72, 112, 172, 0.12)',
    border: '#dfe7f2',
    codeBg: '#f4f7fb',
    codeText: '#3b5f96',
    codeBorder: '#e1e9f4',
    quoteBar: '#4870ac',
    quoteBg: '#f6f9fd',
    quoteText: '#4c5d73',
    tableHeadBg: '#eef3fa',
    markBg: '#fff2b2',
    fontBody: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
    fontMono: '"JetBrains Mono", Menlo, Consolas, monospace',
  },
  github: {
    bg: '#ffffff',
    text: '#24292f',
    muted: '#57606a',
    heading: '#1f2328',
    strong: '#1f2328',
    accent: '#0969da',
    accentSoft: 'rgba(9, 105, 218, 0.1)',
    border: '#d0d7de',
    codeBg: '#f6f8fa',
    codeText: '#24292f',
    codeBorder: '#d0d7de',
    quoteBar: '#d0d7de',
    quoteBg: '#f6f8fa',
    quoteText: '#57606a',
    tableHeadBg: '#f6f8fa',
    markBg: '#fff8c5',
    fontBody: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif',
    fontMono: '"JetBrains Mono", Menlo, Consolas, monospace',
  },
};

/** 从当前文档根节点的计算样式读取主题 CSS 变量，缺失时回退预设。 */
export function extractThemeTokens(themeId = 'white', computedStyle = null) {
  const base = WECHAT_THEME_PRESETS[themeId] || WECHAT_THEME_PRESETS.white;
  let cs = computedStyle;
  if (!cs && typeof document !== 'undefined' && typeof getComputedStyle === 'function') {
    cs = getComputedStyle(document.documentElement);
  }
  const read = (varName, fallback) => {
    if (!cs || typeof cs.getPropertyValue !== 'function') return fallback;
    const v = cs.getPropertyValue(varName).trim();
    return v || fallback;
  };
  return {
    bg: read('--bg', base.bg),
    text: read('--text', base.text),
    muted: read('--text-muted', base.muted),
    heading: read('--heading', base.heading),
    strong: read('--strong', base.strong),
    accent: read('--accent', base.accent),
    accentSoft: read('--accent-soft', base.accentSoft),
    border: read('--border', base.border),
    codeBg: read('--code-bg', base.codeBg),
    codeText: read('--code-text', base.codeText),
    codeBorder: read('--code-border', base.codeBorder),
    quoteBar: read('--quote-bar', base.quoteBar),
    quoteBg: read('--quote-bg', base.quoteBg),
    quoteText: read('--quote-text', base.quoteText),
    tableHeadBg: read('--table-head-bg', base.tableHeadBg),
    markBg: read('--mark-bg', base.markBg),
    fontBody: read('--font-body', base.fontBody),
    fontMono: read('--font-mono', base.fontMono),
    fontSize: read('--editor-font-size', '15px'),
    lineHeight: read('--line-height', '1.75'),
  };
}

function appendInlineStyle(openTag, style) {
  if (!style) return openTag;
  if (/\bstyle="/i.test(openTag)) {
    return openTag.replace(/\bstyle="([^"]*)"/i, (_, prev) => {
      const sep = prev.trim().endsWith(';') || !prev.trim() ? '' : ';';
      return `style="${prev}${sep}${style}"`;
    });
  }
  return openTag.replace(/>$/, ` style="${style}">`);
}

/**
 * 将 Markdown 转为带完整内联样式的公众号/富文本 HTML。
 * 返回 `{ html, plain }`，可直接写入剪贴板 `text/html` 与 `text/plain`。
 */
/**
 * 为已渲染的语义 HTML 注入当前主题的完整内联样式（零依赖纯函数）。
 */
export function styleWeChatHtml(rawHtml, { themeId = 'white', tokens = null } = {}) {
  const tk = tokens || extractThemeTokens(themeId);
  const htmlInput = String(rawHtml || '');

  const isOrange = themeId === 'orangeheart';
  const isLapis = themeId === 'lapis';

  const h1Style = isOrange
    ? `font-size:22px;font-weight:700;color:${tk.heading};margin:24px 0 14px;padding-bottom:8px;border-bottom:2px solid ${tk.accent};line-height:1.35;`
    : isLapis
      ? `font-size:22px;font-weight:700;color:${tk.heading};margin:24px 0 14px;padding-bottom:6px;border-bottom:1.5px solid ${tk.border};line-height:1.35;`
      : `font-size:22px;font-weight:700;color:${tk.heading};margin:24px 0 14px;line-height:1.35;`;

  const h2Style = isOrange
    ? `font-size:18px;font-weight:700;color:${tk.heading};margin:22px 0 12px;padding:3px 10px;border-left:4px solid ${tk.accent};background:${tk.accentSoft};border-radius:0 4px 4px 0;line-height:1.4;`
    : isLapis
      ? `font-size:18px;font-weight:700;color:${tk.heading};margin:22px 0 12px;padding-left:10px;border-left:3.5px solid ${tk.accent};line-height:1.4;`
      : `font-size:18px;font-weight:700;color:${tk.heading};margin:22px 0 12px;padding-bottom:4px;border-bottom:1px solid ${tk.border};line-height:1.4;`;

  const tagStyles = {
    h1: h1Style,
    h2: h2Style,
    h3: `font-size:16px;font-weight:700;color:${tk.heading};margin:18px 0 10px;line-height:1.45;`,
    h4: `font-size:15px;font-weight:700;color:${tk.heading};margin:16px 0 8px;line-height:1.45;`,
    h5: `font-size:14px;font-weight:700;color:${tk.muted};margin:14px 0 6px;line-height:1.45;`,
    h6: `font-size:13px;font-weight:700;color:${tk.muted};margin:12px 0 6px;line-height:1.45;`,
    p: `margin:0 0 14px;color:${tk.text};line-height:${tk.lineHeight};`,
    blockquote: `margin:14px 0;padding:10px 14px;border-left:4px solid ${tk.quoteBar};background:${tk.quoteBg};color:${tk.quoteText};border-radius:4px;`,
    ul: `margin:0 0 14px;padding-left:22px;color:${tk.text};`,
    ol: `margin:0 0 14px;padding-left:22px;color:${tk.text};`,
    li: `margin:4px 0;line-height:${tk.lineHeight};`,
    pre: `margin:14px 0;padding:12px 14px;background:${tk.codeBg};border:1px solid ${tk.codeBorder};border-radius:6px;overflow-x:auto;font-family:${tk.fontMono};font-size:13px;line-height:1.6;color:${tk.text};`,
    table: `width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;`,
    th: `padding:8px 10px;border:1px solid ${tk.border};background:${tk.tableHeadBg};color:${tk.heading};font-weight:600;text-align:left;`,
    td: `padding:8px 10px;border:1px solid ${tk.border};color:${tk.text};`,
    a: `color:${tk.accent};text-decoration:none;border-bottom:1px solid ${tk.accent};`,
    strong: `color:${tk.strong};font-weight:700;`,
    em: `font-style:italic;`,
    del: `color:${tk.muted};text-decoration:line-through;`,
    mark: `background:${tk.markBg};color:${tk.text};padding:1px 4px;border-radius:3px;`,
    hr: `border:0;border-top:1px solid ${tk.border};margin:20px 0;`,
    img: `max-width:100%;height:auto;display:block;margin:12px auto;border-radius:4px;`,
  };

  const inlineCodeStyle = `font-family:${tk.fontMono};font-size:0.88em;background:${tk.codeBg};color:${tk.codeText};padding:2px 5px;border-radius:3px;border:1px solid ${tk.codeBorder};`;
  const blockCodeStyle = `font-family:${tk.fontMono};font-size:13px;background:transparent;color:${tk.text};padding:0;border:0;white-space:pre;`;

  // 先处理 <pre ...><code ...> 避免与行内 <code> 混淆
  let styled = htmlInput.replace(
    /(<pre\b[^>]*>)\s*(<code\b[^>]*>)/gi,
    (_, preTag, codeTag) =>
      `${appendInlineStyle(preTag, tagStyles.pre)}${appendInlineStyle(codeTag, blockCodeStyle)}`
  );

  // 为其余标签补全内联样式
  styled = styled.replace(/<([a-z][a-z0-9]*)(\b[^>]*)>/gi, (full, tagName, _rest) => {
    const tag = tagName.toLowerCase();
    if (tag === 'pre') return full;
    if (tag === 'code') {
      if (/\bstyle="/i.test(full)) return full;
      return appendInlineStyle(full, inlineCodeStyle);
    }
    const style = tagStyles[tag];
    return style ? appendInlineStyle(full, style) : full;
  });

  const wrapperStyle = `font-family:${tk.fontBody};font-size:${tk.fontSize};line-height:${tk.lineHeight};color:${tk.text};background-color:${tk.bg};word-break:break-word;`;
  const html = `<section data-plume-theme="${themeId}" style="${wrapperStyle}">${styled}</section>`;

  const plain = htmlInput
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { html, plain };
}

/**
 * 将 Markdown 转为带完整内联样式的公众号/富文本 HTML。
 */
export async function renderWeChatHtml(
  markdown,
  { themeId = 'white', tokens = null, imageResolver = null, renderHtml = null } = {}
) {
  const render = renderHtml || renderMarkdown;
  const rawHtml = render(String(markdown || ''), null, imageResolver);
  return styleWeChatHtml(rawHtml, { themeId, tokens });
}
