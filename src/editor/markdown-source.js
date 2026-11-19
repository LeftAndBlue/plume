import { normalizeMarkdownText } from './rich-doc.js';

/** 统一换行并切成行；导出、大纲等无 CodeMirror 文档对象的场景复用同一份预处理。 */
export function splitMarkdownLines(markdown) {
  return normalizeMarkdownText(markdown).replace(/\r\n?/g, '\n').split('\n');
}

/** 返回 Front Matter 之后的起始行号；没有闭合的文首信息时返回 0。 */
export function frontMatterEnd(lines) {
  if (!/^---\s*$/.test(lines[0] || '')) return 0;
  for (let i = 1; i < lines.length; i++) {
    if (/^(?:---|\.\.\.)\s*$/.test(lines[i])) return i + 1;
  }
  return 0;
}

/** 导出包络文档时只转义 XML 必需字符；HTML 属性引号仍由调用方负责处理。 */
export function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
