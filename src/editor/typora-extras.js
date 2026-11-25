/**
 * Typora 常用写作增强工具（纯函数 + 数据表，方便独立单测）：
 * 1. ${filename}.assets 同名图片目录解析
 * 2. 中英文混排自动加空格（跳过代码块、行内代码、链接与公式）
 * 3. 段落计数
 * 4. `/` 斜杠快捷插入与 `:` Emoji 补全的触发器与候选表
 */

/**
 * 解析图片归集目录模板，支持 Typora 风格的 `${filename}.assets`。
 * 未保存文档没有文件名时自动回退到 `assets`。
 */
export function resolveImageFolder(template, docPath) {
  const raw = String(template || 'assets').trim() || 'assets';
  let stem = '';
  if (docPath) {
    const base = String(docPath).split(/[\\/]/).pop() || '';
    stem = base.replace(/\.[^.]+$/, '').replace(/[^\w\-\u4e00-\u9fa5.]/g, '_').replace(/^\.+|\.+$/g, '');
  }
  if (raw.includes('${filename}') && !stem) return 'assets';
  const expanded = raw.replace(/\$\{filename\}/g, stem);
  const parts = expanded
    .split(/[\\/]+/)
    .filter((part) => part && part !== '.' && part !== '..' && /^[\w\-\u4e00-\u9fa5][\w\-\u4e00-\u9fa5.]*$/.test(part));
  return parts.slice(0, 4).join('/') || 'assets';
}

/**
 * 中英文与数字之间自动补一个半角空格（Pangu 风格），
 * 跳过围栏代码块、行内代码、Markdown 链接/图片地址与 LaTeX 公式。
 */
export function panguSpacing(markdown) {
  const lines = String(markdown || '').split('\n');
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;

  const formatSegment = (seg) =>
    seg
      .replace(/([\u4e00-\u9fff])([A-Za-z0-9])/g, '$1 $2')
      .replace(/([A-Za-z0-9])([\u4e00-\u9fff])/g, '$1 $2');

  const formatLine = (line) => {
    // 保护行内代码、公式、链接/图片语法、裸 URL
    const protectedRe = /(`+[^`]*`+|\$\$[^$]*\$\$|\$[^$\n]+\$|!?\[[^\]]*\]\([^)]*\)|https?:\/\/\S+)/g;
    let out = '';
    let last = 0;
    let m;
    while ((m = protectedRe.exec(line))) {
      if (m.index > last) out += formatSegment(line.slice(last, m.index));
      out += m[0];
      last = m.index + m[0].length;
    }
    if (last < line.length) out += formatSegment(line.slice(last));
    return out;
  };

  return lines
    .map((line) => {
      const fm = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (fm) {
        const ch = fm[1][0];
        const len = fm[1].length;
        if (!inFence) {
          inFence = true;
          fenceChar = ch;
          fenceLen = len;
        } else if (ch === fenceChar && len >= fenceLen && /^\s{0,3}(`{3,}|~{3,})\s*$/.test(line)) {
          inFence = false;
        }
        return line;
      }
      if (inFence) return line;
      return formatLine(line);
    })
    .join('\n');
}

/** 统计非空逻辑段落数（连续非空行计为一段）。 */
export function countParagraphs(text) {
  const blocks = String(text || '')
    .trim()
    .split(/\n\s*\n/)
    .filter((b) => b.trim().length > 0);
  return blocks.length;
}

export const SLASH_COMMANDS = [
  { id: 'h1', label: '一级标题', keywords: 'h1 heading 标题 一级', insert: '# ', offset: 2 },
  { id: 'h2', label: '二级标题', keywords: 'h2 heading 标题 二级', insert: '## ', offset: 3 },
  { id: 'h3', label: '三级标题', keywords: 'h3 heading 标题 三级', insert: '### ', offset: 4 },
  { id: 'ul', label: '无序列表', keywords: 'ul bullet list 无序 列表', insert: '- ', offset: 2 },
  { id: 'ol', label: '有序列表', keywords: 'ol ordered list 有序 列表', insert: '1. ', offset: 3 },
  { id: 'task', label: '任务列表', keywords: 'task todo checkbox 任务 待办', insert: '- [ ] ', offset: 6 },
  { id: 'quote', label: '引用块', keywords: 'quote blockquote 引用', insert: '> ', offset: 2 },
  { id: 'code', label: '代码块', keywords: 'code fence 代码 代码块', insert: '```\n\n```', offset: 4 },
  { id: 'mermaid', label: '流程图 (Mermaid)', keywords: 'mermaid flowchart diagram 流程图 图表', insert: '```mermaid\ngraph TD\n  A[开始] --> B[结束]\n```', offset: 20 },
  { id: 'table', label: '表格 (3×3)', keywords: 'table 表格', insert: '| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |', offset: 2 },
  { id: 'math', label: '公式块 (LaTeX)', keywords: 'math latex formula 公式', insert: '$$\n\n$$', offset: 3 },
  { id: 'note', label: '提示框 (NOTE)', keywords: 'callout note tip 提示 标注', insert: '> [!NOTE]\n> ', offset: 12 },
  { id: 'warning', label: '警告框 (WARNING)', keywords: 'callout warning 警告 注意', insert: '> [!WARNING]\n> ', offset: 15 },
  { id: 'hr', label: '水平分割线', keywords: 'hr divider line 分割线', insert: '---\n', offset: 4 },
  { id: 'toc', label: '内容目录', keywords: 'toc outline 目录', insert: '[toc]\n', offset: 6 },
];

export const EMOJI_LIST = [
  { code: 'smile', emoji: '😄', label: '微笑' },
  { code: 'joy', emoji: '😂', label: '笑哭' },
  { code: 'wink', emoji: '😉', label: '眨眼' },
  { code: 'thinking', emoji: '🤔', label: '思考' },
  { code: 'sunglasses', emoji: '😎', label: '酷' },
  { code: 'thumbsup', emoji: '👍', label: '点赞' },
  { code: 'clap', emoji: '👏', label: '鼓掌' },
  { code: 'ok', emoji: '👌', label: 'OK' },
  { code: 'pray', emoji: '🙏', label: '感谢' },
  { code: 'heart', emoji: '❤️', label: '红心' },
  { code: 'fire', emoji: '🔥', label: '火热' },
  { code: 'sparkles', emoji: '✨', label: '闪亮' },
  { code: 'star', emoji: '⭐', label: '星星' },
  { code: 'rocket', emoji: '🚀', label: '火箭' },
  { code: 'tada', emoji: '🎉', label: '庆祝' },
  { code: 'bulb', emoji: '💡', label: '灵感' },
  { code: 'check', emoji: '✅', label: '完成' },
  { code: 'x', emoji: '❌', label: '错误' },
  { code: 'warning', emoji: '⚠️', label: '警告' },
  { code: 'info', emoji: 'ℹ️', label: '信息' },
  { code: 'pin', emoji: '📌', label: '置顶' },
  { code: 'memo', emoji: '📝', label: '笔记' },
  { code: 'book', emoji: '📖', label: '书本' },
  { code: 'link', emoji: '🔗', label: '链接' },
  { code: 'bug', emoji: '🐛', label: 'Bug' },
  { code: 'wrench', emoji: '🔧', label: '修复' },
  { code: 'zap', emoji: '⚡', label: '闪电' },
  { code: 'clock', emoji: '🕒', label: '时间' },
  { code: 'calendar', emoji: '📅', label: '日历' },
  { code: 'folder', emoji: '📁', label: '文件夹' },
  { code: 'lock', emoji: '🔒', label: '锁定' },
  { code: 'key', emoji: '🔑', label: '钥匙' },
  { code: 'coffee', emoji: '☕', label: '咖啡' },
  { code: '100', emoji: '💯', label: '满分' },
];

/**
 * 检查当前行光标前是否命中 `/` 斜杠命令或 `:` Emoji 补全。
 * 返回 `{ kind: 'slash' | 'emoji', from, query, items }` 或 `null`。
 */
export function matchQuickTrigger(lineText, lineFrom, cursorOffset) {
  const before = lineText.slice(0, cursorOffset);
  // 1. 行首（可带前导空白）输入 `/...` 触发斜杠菜单
  const slash = /^(\s*)\/([\w\u4e00-\u9fa5-]*)$/.exec(before);
  if (slash) {
    const q = slash[2].toLowerCase();
    const items = q
      ? SLASH_COMMANDS.filter(
          (c) =>
            c.id.includes(q) ||
            c.label.toLowerCase().includes(q) ||
            c.keywords.toLowerCase().includes(q)
        )
      : SLASH_COMMANDS;
    if (!items.length) return null;
    return {
      kind: 'slash',
      from: lineFrom + slash[1].length,
      query: q,
      items: items.slice(0, 8),
    };
  }

  // 2. 句中或行首输入 `:xxx`（至少 1 个字母/数字）触发 Emoji 候选
  const emoji = /(?:^|[\s([{\u4e00-\u9fff]):([a-z0-9_]{1,16})$/i.exec(before);
  if (emoji) {
    const q = emoji[1].toLowerCase();
    const items = EMOJI_LIST.filter(
      (e) => e.code.includes(q) || e.label.includes(q)
    );
    if (!items.length) return null;
    return {
      kind: 'emoji',
      from: lineFrom + before.length - emoji[1].length - 1,
      query: q,
      items: items.slice(0, 8),
    };
  }

  return null;
}
