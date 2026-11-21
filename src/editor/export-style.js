/**
 * 导出样式装配：主题配色 + 公共排版层 + 版式模板。
 *
 * 为什么单独一层：原来的 PRINT_CSS 写死在 markdown-export.js 里，字体和颜色跟
 * 编辑器主题完全脱钩，用户在编辑器里选「报纸」导出 PDF 却是 Segoe UI + 雅黑。
 * 现在把主题 CSS 变量原样内联，导出页带 data-theme，颜色/字体自然对得上。
 *
 * 三块拼装顺序不能反：先主题（变量），再公共层（消费变量），最后模板
 * （在 @media print / @media screen 里覆盖尺寸，必须排最后才压得住公共层）。
 *
 * 本模块只吃 CSS 文本，不依赖 theme.js，避免把 live-preview 拖进导出懒加载分包。
 */

import baseCss from './styles/export/base.css?raw';
import templateDocCss from './styles/export/template-doc.css?raw';
import templateBookCss from './styles/export/template-book.css?raw';
import templatePaperCss from './styles/export/template-paper.css?raw';

import whiteCss from './styles/themes/white.css?raw';
import sepiaCss from './styles/themes/sepia.css?raw';
import vueCss from './styles/themes/vue.css?raw';
import nightCss from './styles/themes/night.css?raw';
import githubCss from './styles/themes/github.css?raw';
import newsprintCss from './styles/themes/newsprint.css?raw';
import pixyllCss from './styles/themes/pixyll.css?raw';
import gothicCss from './styles/themes/gothic.css?raw';

/** 与 theme.js 的 THEMES 保持同 id；改主题 id 时两处同步。 */
const THEME_CSS = {
  white: whiteCss,
  sepia: sepiaCss,
  vue: vueCss,
  night: nightCss,
  github: githubCss,
  newsprint: newsprintCss,
  pixyll: pixyllCss,
  gothic: gothicCss,
};

/** 深色主题印在纸上没有意义，PDF 统一退回浅色配色（长图仍保留深色）。 */
const DARK_THEMES = new Set(['night', 'gothic']);

export const EXPORT_TEMPLATES = [
  { id: 'doc', label: '文档' },
  { id: 'book', label: '书籍' },
  { id: 'paper', label: '论文' },
];

const TEMPLATE_CSS = {
  doc: templateDocCss,
  book: templateBookCss,
  paper: templatePaperCss,
};

export function normalizeExportTemplate(id) {
  return TEMPLATE_CSS[id] ? id : 'doc';
}

/**
 * @param {object} opts
 * @param {string} [opts.theme]    主题 id（theme.js 的 THEMES）
 * @param {string} [opts.template] 版式模板 id（doc / book / paper）
 * @param {'screen'|'print'} [opts.mode] 屏幕（HTML、长图）或纸张（PDF）
 * @returns {{themeId:string, templateId:string, css:string}}
 */
export function buildExportCss({ theme = 'white', template = 'doc', mode = 'screen' } = {}) {
  let themeId = THEME_CSS[theme] ? theme : 'white';
  if (mode === 'print' && DARK_THEMES.has(themeId)) themeId = 'white';
  const templateId = normalizeExportTemplate(template);
  return {
    themeId,
    templateId,
    css: [THEME_CSS[themeId], baseCss, TEMPLATE_CSS[templateId]].join('\n'),
  };
}
