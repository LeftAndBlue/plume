/**
 * extrasText 常用写作增强工具（纯函数 + 数据表，方便独立单测）：
 * 1. ${filename}.assets 同名图片目录解析 & 图片宽度属性回写
 * 2. 中英文混排自动加空格（跳过代码块、行内代码、链接、公式与 HTML 标签）
 * 3. 段落计数与单篇字数目标进度计算
 * 4. `/` 斜杠快捷插入与 `:` Emoji 补全/自动替换的触发器与候选表
 * 5. 内联 HTML 安全样式过滤（<span style>、<center>、<details><summary>）
 */

export const DEFAULT_IMAGE_FOLDER_TEMPLATE = '${filename}.assets';

/**
 * 解析图片归集目录模板，支持 `${filename}.assets` 风格占位符。
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
 * 更新 Markdown 图片语法的 `{width=N}` 属性，保留原有 alt、src、title 及 align 等其他属性。
 * 例：`![a](x.png){align=center}` -> `![a](x.png){width=420 align=center}`
 */
export function updateImageWidthAttr(rawMd, widthPx) {
  const w = Math.max(40, Math.min(2400, Math.round(Number(widthPx) || 0)));
  if (!w) return String(rawMd || '');
  const s = String(rawMd || '');
  const m = /^(!\[[^\]]*\]\([^)]*\))(?:\s*\{([^}]*)\})?$/.exec(s.trim());
  if (!m) return s;
  const base = m[1];
  const existing = (m[2] || '').trim();
  const tokens = existing ? existing.split(/\s+/).filter(Boolean) : [];
  let replaced = false;
  const nextTokens = tokens.map((tok) => {
    if (/^width\s*=/i.test(tok)) {
      replaced = true;
      return `width=${w}`;
    }
    return tok;
  });
  if (!replaced) nextTokens.unshift(`width=${w}`);
  return `${base}{${nextTokens.join(' ')}}`;
}

/**
 * 中英文与数字之间自动补一个半角空格（Pangu 风格），
 * 跳过围栏代码块、行内代码、Markdown 链接/图片地址、LaTeX 公式与 HTML 标签。
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
    // 保护行内代码、公式、链接/图片语法、HTML 标签、裸 URL
    const protectedRe =
      /(`+[^`]*`+|\$\$[^$]*\$\$|\$[^$\n]+\$|!?\[[^\]]*\]\([^)]*\)|<\/?[a-zA-Z][^>\n]*>|https?:\/\/\S+)/g;
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

/** 计算单篇字数目标进度（百分比 0–100，附带是否达成与剩余字数）。 */
export function computeWordGoalProgress(words, goal) {
  const w = Math.max(0, Number(words) || 0);
  const g = Math.max(0, Math.round(Number(goal) || 0));
  if (!g) return { goal: 0, words: w, percent: 0, remaining: 0, reached: false };
  const percent = Math.min(100, Math.round((w / g) * 100));
  return {
    goal: g,
    words: w,
    percent,
    remaining: Math.max(0, g - w),
    reached: w >= g,
  };
}

/**
 * 过滤行内 HTML 的 style 属性：仅保留安全排版白名单属性，防止 XSS / 外链注入。
 */
const ALLOWED_STYLE_PROPS = new Set([
  'color',
  'background',
  'background-color',
  'font-size',
  'font-weight',
  'font-style',
  'text-decoration',
  'text-align',
  'opacity',
  'padding',
  'border-radius',
  'letter-spacing',
]);

export function sanitizeInlineStyle(styleText) {
  const raw = String(styleText || '').trim();
  if (!raw) return '';
  const safe = [];
  for (const decl of raw.split(';')) {
    const idx = decl.indexOf(':');
    if (idx <= 0) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const val = decl.slice(idx + 1).trim();
    if (!ALLOWED_STYLE_PROPS.has(prop) || !val) continue;
    if (/url\s*\(|expression\s*\(|javascript:|behavior\s*:|@import/i.test(val)) continue;
    if (!/^[#(),.%\w\s+-]+$/i.test(val)) continue;
    safe.push(`${prop}: ${val}`);
  }
  return safe.join('; ');
}

/**
 * 扫描单行内的 `<center>...</center>` 与 `<span style="...">...</span>`。
 * 返回列表项：`{ tag, from, to, openFrom, openTo, contentFrom, contentTo, closeFrom, closeTo, style }`
 */
export function scanStyledInlineHtml(lineText) {
  const text = String(lineText ?? '');
  const found = [];
  const centerRe = /<center>([^<>\n]*?)<\/center>/gi;
  let m;
  while ((m = centerRe.exec(text))) {
    const openEnd = m.index + '<center>'.length;
    const closeFrom = openEnd + m[1].length;
    found.push({
      tag: 'center',
      from: m.index,
      to: centerRe.lastIndex,
      openFrom: m.index,
      openTo: openEnd,
      contentFrom: openEnd,
      contentTo: closeFrom,
      closeFrom,
      closeTo: centerRe.lastIndex,
      style: '',
    });
  }
  const spanRe = /<span\s+style\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)')\s*>([^<>\n]*?)<\/span>/gi;
  while ((m = spanRe.exec(text))) {
    const style = sanitizeInlineStyle(m[1] ?? m[2] ?? '');
    if (!style) continue;
    const openEnd = text.indexOf('>', m.index) + 1;
    const closeFrom = openEnd + m[3].length;
    found.push({
      tag: 'span',
      from: m.index,
      to: spanRe.lastIndex,
      openFrom: m.index,
      openTo: openEnd,
      contentFrom: openEnd,
      contentTo: closeFrom,
      closeFrom,
      closeTo: spanRe.lastIndex,
      style,
    });
  }
  found.sort((a, b) => a.from - b.from);
  return found;
}

/**
 * 扫描文档中的 `<details>...</details>` 折叠块（跳过围栏代码块）。
 * 返回 `{ from, to, open, summary, body }`。
 */
export function scanDetailsBlocks(docText) {
  const text = String(docText ?? '');
  const lines = text.split('\n');
  const offsets = [];
  let pos = 0;
  for (const l of lines) {
    offsets.push(pos);
    pos += l.length + 1;
  }

  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  let blockStart = -1;
  let blockOpen = false;
  const blocks = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
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
      continue;
    }
    if (inFence) continue;

    if (blockStart === -1) {
      const om = /^\s*<details(\s+open(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)?\s*>/i.exec(line);
      if (om) {
        blockStart = i;
        blockOpen = Boolean(om[1]);
        // 单行闭合情况：<details><summary>...</summary>...</details>
        if (/<\/details>\s*$/i.test(line)) {
          const from = offsets[i];
          const to = offsets[i] + line.length;
          blocks.push(parseDetailsSlice(text.slice(from, to), from, to, blockOpen));
          blockStart = -1;
        }
      }
    } else if (/^\s*<\/details>\s*$/i.test(line)) {
      const from = offsets[blockStart];
      const to = offsets[i] + line.length;
      blocks.push(parseDetailsSlice(text.slice(from, to), from, to, blockOpen));
      blockStart = -1;
    }
  }
  return blocks;
}

function parseDetailsSlice(raw, from, to, open) {
  const inner = raw
    .replace(/^\s*<details[^>]*>/i, '')
    .replace(/<\/details>\s*$/i, '')
    .trim();
  const sm = /<summary>([\s\S]*?)<\/summary>/i.exec(inner);
  const summary = sm ? sm[1].replace(/<[^>]+>/g, '').trim() || '详细信息' : '详细信息';
  const body = (sm ? inner.slice(sm.index + sm[0].length) : inner).trim();
  return { from, to, open, summary, body };
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
  {
    id: 'table',
    label: '表格（选择行列…）',
    keywords: 'table 表格',
    command: 'insert-table',
    insert: '| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |',
    offset: 2,
  },
  { id: 'math', label: '公式块 (LaTeX)', keywords: 'math latex formula 公式', insert: '$$\n\n$$', offset: 3 },
  { id: 'note', label: '提示框 (NOTE)', keywords: 'callout note 提示 标注', insert: '> [!NOTE]\n> ', offset: 12 },
  { id: 'tip', label: '技巧框 (TIP)', keywords: 'callout tip 技巧 建议', insert: '> [!TIP]\n> ', offset: 11 },
  { id: 'warning', label: '警告框 (WARNING)', keywords: 'callout warning 警告 注意', insert: '> [!WARNING]\n> ', offset: 15 },
  {
    id: 'details',
    label: '折叠详情块 (Details)',
    keywords: 'details summary collapse fold 折叠 详情',
    insert: '<details>\n<summary>点击展开</summary>\n\n在这里输入内容\n</details>\n',
    offset: 19,
  },
  { id: 'hr', label: '水平分割线', keywords: 'hr divider line 分割线', insert: '---\n', offset: 4 },
  { id: 'toc', label: '内容目录', keywords: 'toc outline 目录', insert: '[toc]\n', offset: 6 },
];

export const EMOJI_LIST = [
  // 表情
  { code: 'smile', emoji: '😄', label: '微笑' },
  { code: 'grinning', emoji: '😀', label: '露齿笑' },
  { code: 'joy', emoji: '😂', label: '笑哭' },
  { code: 'rofl', emoji: '🤣', label: '笑翻' },
  { code: 'blush', emoji: '😊', label: '害羞笑' },
  { code: 'wink', emoji: '😉', label: '眨眼' },
  { code: 'heart_eyes', emoji: '😍', label: '花痴' },
  { code: 'thinking', emoji: '🤔', label: '思考' },
  { code: 'sunglasses', emoji: '😎', label: '酷' },
  { code: 'sweat_smile', emoji: '😅', label: '汗颜笑' },
  { code: 'neutral_face', emoji: '😐', label: '无语' },
  { code: 'cry', emoji: '😢', label: '哭泣' },
  { code: 'sob', emoji: '😭', label: '大哭' },
  { code: 'angry', emoji: '😠', label: '生气' },
  { code: 'exploding_head', emoji: '🤯', label: '震惊' },
  { code: 'partying_face', emoji: '🥳', label: '派对' },
  { code: 'sleeping', emoji: '😴', label: '睡觉' },
  { code: 'nerd_face', emoji: '🤓', label: '书呆子' },
  { code: 'saluting_face', emoji: '🫡', label: '致敬' },
  { code: 'eyes', emoji: '👀', label: '围观' },
  // 手势
  { code: 'thumbsup', emoji: '👍', label: '点赞' },
  { code: '+1', emoji: '👍', label: '赞同' },
  { code: 'thumbsdown', emoji: '👎', label: '点踩' },
  { code: '-1', emoji: '👎', label: '反对' },
  { code: 'clap', emoji: '👏', label: '鼓掌' },
  { code: 'ok_hand', emoji: '👌', label: 'OK' },
  { code: 'ok', emoji: '👌', label: 'OK' },
  { code: 'pray', emoji: '🙏', label: '感谢' },
  { code: 'wave', emoji: '👋', label: '挥手' },
  { code: 'muscle', emoji: '💪', label: '加油' },
  { code: 'raised_hands', emoji: '🙌', label: '欢呼' },
  { code: 'handshake', emoji: '🤝', label: '合作' },
  { code: 'point_right', emoji: '👉', label: '向右指' },
  { code: 'point_down', emoji: '👇', label: '向下指' },
  { code: 'writing_hand', emoji: '✍️', label: '写作' },
  // 情感与状态
  { code: 'heart', emoji: '❤️', label: '红心' },
  { code: 'broken_heart', emoji: '💔', label: '心碎' },
  { code: 'fire', emoji: '🔥', label: '火热' },
  { code: 'sparkles', emoji: '✨', label: '闪亮' },
  { code: 'star', emoji: '⭐', label: '星星' },
  { code: 'star2', emoji: '🌟', label: '闪星' },
  { code: 'rocket', emoji: '🚀', label: '火箭' },
  { code: 'tada', emoji: '🎉', label: '庆祝' },
  { code: 'confetti_ball', emoji: '🎊', label: '彩球' },
  { code: 'trophy', emoji: '🏆', label: '奖杯' },
  { code: 'medal', emoji: '🏅', label: '奖牌' },
  { code: 'crown', emoji: '👑', label: '皇冠' },
  { code: 'gem', emoji: '💎', label: '宝石' },
  { code: 'bulb', emoji: '💡', label: '灵感' },
  { code: '100', emoji: '💯', label: '满分' },
  // 标注与符号
  { code: 'check', emoji: '✅', label: '完成' },
  { code: 'white_check_mark', emoji: '✅', label: '通过' },
  { code: 'x', emoji: '❌', label: '错误' },
  { code: 'heavy_check_mark', emoji: '✔️', label: '勾选' },
  { code: 'warning', emoji: '⚠️', label: '警告' },
  { code: 'no_entry', emoji: '⛔', label: '禁止' },
  { code: 'prohibited', emoji: '🚫', label: '禁用' },
  { code: 'question', emoji: '❓', label: '疑问' },
  { code: 'exclamation', emoji: '❗', label: '感叹' },
  { code: 'info', emoji: 'ℹ️', label: '信息' },
  { code: 'new', emoji: '🆕', label: '新增' },
  { code: 'up', emoji: '🆙', label: '升级' },
  { code: 'recycle', emoji: '♻️', label: '重构' },
  { code: 'zap', emoji: '⚡', label: '闪电' },
  { code: 'boom', emoji: '💥', label: '爆炸' },
  { code: 'red_circle', emoji: '🔴', label: '红点' },
  { code: 'yellow_circle', emoji: '🟡', label: '黄点' },
  { code: 'green_circle', emoji: '🟢', label: '绿点' },
  { code: 'blue_circle', emoji: '🔵', label: '蓝点' },
  // 文档与开发
  { code: 'pin', emoji: '📌', label: '置顶' },
  { code: 'pushpin', emoji: '📌', label: '图钉' },
  { code: 'bookmark', emoji: '🔖', label: '书签' },
  { code: 'memo', emoji: '📝', label: '笔记' },
  { code: 'pencil', emoji: '✏️', label: '编辑' },
  { code: 'book', emoji: '📖', label: '书本' },
  { code: 'books', emoji: '📚', label: '书籍' },
  { code: 'page_facing_up', emoji: '📄', label: '文档' },
  { code: 'clipboard', emoji: '📋', label: '剪贴板' },
  { code: 'link', emoji: '🔗', label: '链接' },
  { code: 'paperclip', emoji: '📎', label: '附件' },
  { code: 'mag', emoji: '🔍', label: '搜索' },
  { code: 'chart_with_upwards_trend', emoji: '📈', label: '增长' },
  { code: 'bar_chart', emoji: '📊', label: '图表' },
  { code: 'bug', emoji: '🐛', label: 'Bug' },
  { code: 'wrench', emoji: '🔧', label: '修复' },
  { code: 'hammer', emoji: '🔨', label: '构建' },
  { code: 'gear', emoji: '⚙️', label: '配置' },
  { code: 'package', emoji: '📦', label: '打包' },
  { code: 'test_tube', emoji: '🧪', label: '测试' },
  { code: 'shield', emoji: '🛡️', label: '安全' },
  { code: 'lock', emoji: '🔒', label: '锁定' },
  { code: 'unlock', emoji: '🔓', label: '解锁' },
  { code: 'key', emoji: '🔑', label: '钥匙' },
  { code: 'computer', emoji: '💻', label: '电脑' },
  { code: 'keyboard', emoji: '⌨️', label: '键盘' },
  { code: 'globe', emoji: '🌐', label: '网络' },
  { code: 'cloud', emoji: '☁️', label: '云端' },
  { code: 'folder', emoji: '📁', label: '文件夹' },
  { code: 'wastebasket', emoji: '🗑️', label: '删除' },
  // 时间与生活
  { code: 'clock', emoji: '🕒', label: '时间' },
  { code: 'hourglass', emoji: '⏳', label: '等待' },
  { code: 'stopwatch', emoji: '⏱️', label: '计时' },
  { code: 'calendar', emoji: '📅', label: '日历' },
  { code: 'bell', emoji: '🔔', label: '提醒' },
  { code: 'megaphone', emoji: '📣', label: '公告' },
  { code: 'speech_balloon', emoji: '💬', label: '评论' },
  { code: 'email', emoji: '📧', label: '邮件' },
  { code: 'target', emoji: '🎯', label: '目标' },
  { code: 'compass', emoji: '🧭', label: '指南' },
  { code: 'coffee', emoji: '☕', label: '咖啡' },
  { code: 'tea', emoji: '🍵', label: '茶' },
  { code: 'sun', emoji: '☀️', label: '晴天' },
  { code: 'moon', emoji: '🌙', label: '月亮' },
  { code: 'rainbow', emoji: '🌈', label: '彩虹' },
  { code: 'seedling', emoji: '🌱', label: '成长' },
];

const EMOJI_MAP = new Map(EMOJI_LIST.map((e) => [e.code.toLowerCase(), e.emoji]));

/**
 * 检查当前行光标前是否刚闭合一个完整 `:shortcode:`（如 `:smile:`）。
 * 命中时返回 `{ from, to, emoji, code }`，否则 `null`。
 */
export function matchExactEmojiShortcode(lineText, lineFrom, cursorOffset) {
  const before = String(lineText || '').slice(0, cursorOffset);
  const m = /(?:^|[\s([{\u4e00-\u9fff]):([a-z0-9_+-]{1,32}):$/i.exec(before);
  if (!m) return null;
  const code = m[1].toLowerCase();
  const emoji = EMOJI_MAP.get(code);
  if (!emoji) return null;
  const tokenLen = m[1].length + 2;
  return {
    from: lineFrom + before.length - tokenLen,
    to: lineFrom + before.length,
    code,
    emoji,
  };
}

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
      items: items.slice(0, 10),
    };
  }

  // 2. 句中或行首输入 `:xxx`（至少 1 个字母/数字/+-）触发 Emoji 候选
  const emoji = /(?:^|[\s([{\u4e00-\u9fff]):([a-z0-9_+-]{1,24})$/i.exec(before);
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


/** 解析单行 ATX 标题等级（1–6），非标题返回 0。 */
export function headingLevelOfLine(text) {
  const m = /^(#{1,6})\s+/.exec(String(text || ''));
  return m ? m[1].length : 0;
}

/**
 * 计算文本行数组（0-indexed）中某一行标题的折叠范围（仅支持 H1..maxLevel），
 * 自动跳过围栏代码块内部并去掉区间末尾空行。
 */
export function computeHeadingFoldLines(lines, lineIndex, maxLevel = 3) {
  if (lineIndex < 0 || lineIndex >= lines.length) return null;

  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  for (let i = 0; i <= lineIndex; i++) {
    const fm = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (fm) {
      const ch = fm[1][0];
      const len = fm[1].length;
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
        fenceLen = len;
      } else if (ch === fenceChar && len >= fenceLen && /^\s{0,3}(`{3,}|~{3,})\s*$/.test(lines[i])) {
        inFence = false;
      }
    }
  }
  if (inFence) return null;

  const level = headingLevelOfLine(lines[lineIndex]);
  if (!level || level > maxLevel) return null;

  let endIndex = lines.length - 1;
  for (let i = lineIndex + 1; i < lines.length; i++) {
    const fm = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (fm) {
      const ch = fm[1][0];
      const len = fm[1].length;
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
        fenceLen = len;
      } else if (ch === fenceChar && len >= fenceLen && /^\s{0,3}(`{3,}|~{3,})\s*$/.test(lines[i])) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const lv = headingLevelOfLine(lines[i]);
    if (lv > 0 && lv <= level) {
      endIndex = i - 1;
      break;
    }
  }

  while (endIndex > lineIndex && !lines[endIndex].trim()) {
    endIndex--;
  }
  if (endIndex <= lineIndex) return null;
  return { startLine: lineIndex + 1, endLine: endIndex + 1 };
}
