/**
 * 快捷键的唯一来源。
 *
 * 之前菜单加速键、帮助里的「快捷键一览」、CM 的 keymap 是三份独立手写的清单，
 * 很容易改一处忘两处（实际就漏了 Ctrl+4/5/6 和 Ctrl+Shift+V —— 菜单上写着，
 * 按下去没反应）。现在：
 *   - 菜单的 accel 从这里取（ACCEL[cmd]）
 *   - 帮助里的列表由这里生成（shortcutText()）
 *   - 自检拿这里跟真正的 keymap facet 做比对（见 selftest.js）
 * 三者同源，改一处就全对。
 */

/** 交给 Chromium 自己处理的组合：内容区里复制/剪切/粘贴走原生行为，CM 不绑定 */
export const NATIVE_KEYS = new Set(['ctrl+c', 'ctrl+x', 'ctrl+v']);

const SHORTCUTS = [
  {
    group: '文件',
    items: [
      { label: '新建', cmd: 'new', keys: 'Ctrl+N' },
      { label: '打开', cmd: 'open', keys: 'Ctrl+O' },
      { label: '快速打开', cmd: 'quick-open', keys: 'Ctrl+Shift+P' },
      { label: '保存', cmd: 'save', keys: 'Ctrl+S' },
      { label: '另存为', cmd: 'save-as', keys: 'Ctrl+Shift+S' },
      { label: '导出 PDF', cmd: 'export-pdf', keys: 'Ctrl+P' },
    ],
  },
  {
    group: '编辑',
    items: [
      { label: '撤销', cmd: 'undo', keys: 'Ctrl+Z' },
      { label: '重做', cmd: 'redo', keys: 'Ctrl+Shift+Z' },
      { label: '剪切', cmd: 'cut', keys: 'Ctrl+X' },
      { label: '复制', cmd: 'copy', keys: 'Ctrl+C' },
      { label: '复制为 Markdown', cmd: 'copy-markdown', keys: 'Ctrl+Shift+C' },
      { label: '粘贴', cmd: 'paste', keys: 'Ctrl+V' },
      { label: '粘贴为纯文本', cmd: 'paste-plain', keys: 'Ctrl+Shift+V' },
      { label: '查找', cmd: 'find', keys: 'Ctrl+F' },
      { label: '全选', cmd: 'select-all', keys: 'Ctrl+A' },
    ],
  },
  {
    group: '段落',
    items: [
      { label: '标题 1', cmd: 'h1', keys: 'Ctrl+1' },
      { label: '标题 2', cmd: 'h2', keys: 'Ctrl+2' },
      { label: '标题 3', cmd: 'h3', keys: 'Ctrl+3' },
      { label: '标题 4', cmd: 'h4', keys: 'Ctrl+4' },
      { label: '标题 5', cmd: 'h5', keys: 'Ctrl+5' },
      { label: '标题 6', cmd: 'h6', keys: 'Ctrl+6' },
      { label: '正文', cmd: 'p', keys: 'Ctrl+0' },
      { label: '代码块', cmd: 'fence', keys: 'Ctrl+Shift+K' },
      { label: '公式块', cmd: 'math', keys: 'Ctrl+Shift+M' },
    ],
  },
  {
    group: '格式',
    items: [
      { label: '加粗', cmd: 'bold', keys: 'Ctrl+B' },
      { label: '斜体', cmd: 'italic', keys: 'Ctrl+I' },
      { label: '删除线', cmd: 'strike', keys: 'Ctrl+Shift+X' },
      { label: '行内代码', cmd: 'code', keys: 'Ctrl+E' },
      { label: '链接', cmd: 'link', keys: 'Ctrl+K' },
    ],
  },
  {
    group: '视图',
    items: [
      { label: '源代码模式', cmd: 'source-mode', keys: 'Ctrl+/' },
      { label: '专注模式', cmd: 'focus', keys: 'F8' },
      { label: '打字机模式', cmd: 'typewriter', keys: 'F9' },
      { label: '文件树', cmd: 'view-files', keys: 'Ctrl+Shift+E' },
      { label: '大纲', cmd: 'view-outline', keys: 'Ctrl+Shift+1' },
      { label: '快捷键一览', cmd: 'shortcuts', keys: 'F1' },
    ],
  },
];

/** 不是命令、但值得写进帮助的按键 */
const KEY_NOTES = [
  'Alt 或 F10 聚焦菜单栏；Alt+F/E/P/O/V/T/H 直接展开对应菜单',
  'Ctrl+Shift+E / Ctrl+Shift+1 再按一次即收起侧栏；Windows 下重做也可用 Ctrl+Y',
  'Ctrl+点击正文里的链接直接打开（普通点击只是把光标放进去改）；选中文字后粘贴链接会变成 [文字](链接)',
];

/** cmd → 加速键字符串，供菜单使用 */
export const ACCEL = Object.fromEntries(
  SHORTCUTS.flatMap((g) => g.items)
    .filter((i) => i.keys)
    .map((i) => [i.cmd, i.keys])
);

/**
 * 归一化：'Mod-/' 与 'Ctrl+/' 视为同一组合。
 * 顺序固定为 ctrl+alt+shift+meta+键，忽略大小写，方便和菜单文案直接比对。
 */
export function normAccel(text) {
  const MODS = ['ctrl', 'alt', 'shift', 'meta'];
  const parts = String(text)
    .split(/[+\-]/)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const mods = new Set();
  let key = '';
  for (const p of parts) {
    if (p === 'mod' || p === 'ctrl' || p === 'cmdorctrl' || p === 'control') mods.add('ctrl');
    else if (p === 'alt' || p === 'option') mods.add('alt');
    else if (p === 'shift') mods.add('shift');
    else if (p === 'meta' || p === 'cmd' || p === 'win' || p === 'super') mods.add('meta');
    else key = p;
  }
  return [...MODS.filter((m) => mods.has(m)), key].join('+');
}

/** 帮助里「快捷键一览」的正文（对话框 detail 用） */
export function shortcutText() {
  const lines = SHORTCUTS.map((g) => {
    const pad = g.group.length < 3 ? '　' : '';
    return (
      g.group +
      pad +
      '　' +
      g.items
        .map((i) => `${i.keys} ${i.label}`)
        .join(' · ')
    );
  });
  return [...lines, '', ...KEY_NOTES].join('\n');
}

/** 全部声明项（自检用） */
export function declaredShortcuts() {
  return SHORTCUTS.flatMap((g) => g.items.map((i) => ({ ...i, group: g.group })));
}
