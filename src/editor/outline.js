/**
 * 大纲里只放"读得顺"的标题文本。
 * 源文件里很常见 `## **一、现状全景**`（作者想加粗），Typora 的大纲不会把 ** 带进去。
 * 纯文本规则与表格、链接标题统一放在 inline-text.js，避免多处维护一套正则。
 */
import { plainInline } from './inline-text.js';
export { plainInline };

export function buildOutline(state) {
  const doc = state.doc;
  const items = [];
  let inFence = false;
  let fenceMark = '';
  for (let i = 1; i <= doc.lines; i++) {
    const text = doc.line(i).text;
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(text);
    if (f) {
      if (!inFence) {
        inFence = true;
        fenceMark = f[1][0];
      } else if (f[1][0] === fenceMark) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(text);
    if (m) {
      items.push({ level: m[1].length, text: plainInline(m[2]) || '(空标题)', pos: doc.line(i).from });
      continue;
    }
    // setext
    if (i < doc.lines && /^\s{0,3}(=+|-+)\s*$/.test(doc.line(i + 1).text) && text.trim()) {
      const nx = doc.line(i + 1).text;
      const level = /=/.test(nx) ? 1 : 2;
      items.push({ level, text: plainInline(text), pos: doc.line(i).from });
    }
  }
  return items;
}
