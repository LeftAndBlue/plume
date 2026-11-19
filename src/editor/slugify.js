/**
 * 标题文字 → 锚点 id：去掉行内标记，空白压成连字符，中文原样保留（浏览器认）。
 * 导出、`[toc]`、以及编辑器里 Ctrl+点击 `#锚点` 三处必须用同一套规则，
 * 否则导出的目录在自己页面上跳不动。
 *
 * 单独成模块：编辑器启动就要用（锚点跳转），而导出栈整体懒加载，
 * 不能让这条热路径跟着导出代码一起进首屏 bundle。
 */
export function slugify(text, used) {
  let base =
    String(text)
      .replace(/[*_`~]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^\w\u4e00-\u9fa5-]/g, '') || 'section';
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
}